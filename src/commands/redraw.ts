// 重画命令与快捷中间件：基于上次任务参数重复生成
import { Context } from 'koishi'
import { Config } from '../config'
import { handleError, Runtime } from '../runtime'

export function registerRedraw(ctx: Context, config: Config, runtime: Runtime) {
  const { membershipSystem, queueSystem, userData } = runtime
  ctx.command('重画 [count:text]')
    .userFields(['authority'])

    .action(async ({ session }, count) => {
      // 获取锁，确保多个重画命令不会同时执行
      await queueSystem.acquireRedrawLock()

      try {
        if (count && !count.includes(' ')) {
          const matched = count.match(/^(\d+)/)
          if (matched) count = matched[1]
        }

        const userId = session.userId
        const lastTask = queueSystem.getLastTask(userId)

        // 检查会员状态和使用次数限制
        if (config.membershipEnabled) {
          const canUse = membershipSystem.canUseDrawing(userId, session)

          if (typeof canUse === 'string') {
            queueSystem.releaseRedrawLock() // 释放锁后返回错误消息
            return canUse // 返回错误消息
          }
        }

        if (!lastTask) {
          queueSystem.releaseRedrawLock() // 释放锁
          return '你还没有进行过任务'
        }

        if (config.membershipEnabled) {
          const canUseNai5 = membershipSystem.canUseNai5(userId, session, lastTask.options?.model || config.model)
          if (typeof canUseNai5 === 'string') {
            queueSystem.releaseRedrawLock()
            return canUseNai5
          }
        }

        let repeatCount = 1
        if (count) {
          const numMap = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }
          const match = count.match(/^([一二两三四五六七八九十]|\d+)/)
          if (match) {
            repeatCount = numMap[match[1]] || parseInt(match[1])
          }
        }

        if (repeatCount > session.resolve(config.maxRedrawCount)) {
          queueSystem.releaseRedrawLock() // 释放锁
          return session.text('commands.novelai.messages.exceed-redraw-limit', [config.maxRedrawCount])
        }

        const now = Date.now()

        // 检查用户是否可以添加任务
        const canAddResult = queueSystem.canAddTask(userId)
        if (!canAddResult.canAdd) {
          const [msgKey, ...params] = canAddResult.message.split(':')
          queueSystem.releaseRedrawLock() // 释放锁
          return session.text(`commands.novelai.messages.${msgKey}`, params.map(p => parseInt(p) || p))
        }

        // 检查是否超出队列限制（考虑多个重画任务）
        const currentTaskCount = queueSystem.userTasks[userId] || 0
        if (currentTaskCount + repeatCount > config.maxUserQueueSize) {
          queueSystem.userCooldowns[userId] = now + config.penaltyCooldown
          queueSystem.releaseRedrawLock() // 释放锁
          return session.text('commands.novelai.messages.exceed-user-queue', [config.maxUserQueueSize])
        }

        // ===== 重画点数预扣 =====
        let redrawDeductedPoints = 0
        if (config.membershipEnabled && config.pointsEnabled && lastTask.pointsCost > 0) {
          const totalPointsCost = lastTask.pointsCost * repeatCount
          const result = await membershipSystem.deductPoints(userId, totalPointsCost)
          if (result === -1) {
            const currentPoints = membershipSystem.getPoints(userId)
            queueSystem.releaseRedrawLock()
            return session.text('commands.novelai.messages.points-insufficient', [currentPoints, totalPointsCost])
          }
          redrawDeductedPoints = totalPointsCost
        }

        // 先增加用户任务计数
        queueSystem.incrementUserTask(userId, repeatCount)

        // 在发送重画响应前添加队列信息，显示添加任务后的数量
        const { totalWaiting, userQueue } = queueSystem.getQueueStatus(userId)
        const totalWithRedraw = totalWaiting + repeatCount  // 加上即将添加的重画任务数

        // 修改为直接使用 text 方法获取消息文本
        if ((totalWithRedraw > 0 || userQueue > 0) && config.showQueueInfo) {
          ctx.logger.debug(`重画队列信息 - 总队列: ${totalWithRedraw}, 用户队列: ${userQueue}`)
          const queueMsg = await session.text('commands.novelai.messages.queue-position', [
            totalWithRedraw,
            userQueue
          ])

          // 构建点数信息
          const pointsInfo = (redrawDeductedPoints > 0)
            ? session.text('commands.novelai.messages.points-deducted', [redrawDeductedPoints])
            : ''

          await session.send(queueMsg + pointsInfo)

          // 在发送队列信息后立即更新lastDrawTime
          if (config.membershipEnabled) {
            const user = userData[userId] || {
              isMember: false,
              membershipExpiry: 0,
              dailyUsage: 0,
              lastUsed: Date.now(),
              dailyLimit: config.nonMemberDailyLimit
            }

            // 计算所需的CD时间（每张图的CD时间 * 重画数量）
            const cooldownPerImage = user.isMember ? config.memberCooldown : config.nonMemberCooldown
            const totalCooldown = cooldownPerImage * repeatCount

            // 更新lastDrawTime，考虑多张图的CD累加
            if (user.lastDrawTime) {
              userData[userId].lastDrawTime = Date.now() + (totalCooldown * 1000) - (user.isMember ? config.memberCooldown * 1000 : config.nonMemberCooldown * 1000)
            } else {
              userData[userId].lastDrawTime = Date.now()
            }

            // 保存用户数据
            membershipSystem.saveUserData()
          }
        }

        try {
          const currentChannelId = session.channelId

          // 为每次重画命令生成一个唯一的命令ID，用于调试和区分不同的重画命令
          const commandId = Date.now() % 10000  // 使用时间戳后4位作为命令ID

          // 在重画命令一开始，重置 ctx.runtime.currentTokenIndex
          if (config.tokenStrategy === 'round-robin' && Array.isArray(ctx.config.token)) {
            if (!ctx.runtime) {
              ctx.runtime = { currentTokenIndex: 0 }
            }

            // 记录重画命令开始前的 token 索引
            const oldTokenIndex = ctx.runtime.currentTokenIndex

            // 检查上一次重画命令的执行时间
            const lastRedrawTime = queueSystem.getLastRedrawTime()
            const timeSinceLastRedraw = now - lastRedrawTime

            // 为了避免连续重画命令使用相同的 token，我们使用全局追踪的方式
            // 1. 如果离上次重画命令时间很短，增加随机性
            // 2. 使用 getUniqueTokenIndex 函数获取未被最近使用的索引
            let newTokenIndex
            if (timeSinceLastRedraw < 5000) {  // 5秒内视为频繁重画
              // 使用时间差作为偏移量的一部分
              const timeOffset = timeSinceLastRedraw % ctx.config.token.length
              const randomOffset = Math.floor(Math.random() * ctx.config.token.length)

              // 从当前索引开始，计算一个新的索引
              const baseIndex = (oldTokenIndex + timeOffset + randomOffset + commandId) % ctx.config.token.length

              // 使用 getUniqueTokenIndex 确保获取一个未被最近使用的索引
              newTokenIndex = queueSystem.getUniqueTokenIndex(baseIndex, ctx.config.token.length)
            } else {
              // 离上次重画时间较长，使用更简单的方法
              const randomOffset = Math.floor(Math.random() * ctx.config.token.length)
              newTokenIndex = (oldTokenIndex + randomOffset + 1) % ctx.config.token.length
            }

            ctx.runtime.currentTokenIndex = newTokenIndex

            // 更新最后重画时间
            queueSystem.setLastRedrawTime(now)

            ctx.logger.debug(`重画命令(${commandId})开始，token 索引从 ${oldTokenIndex} 更新为 ${newTokenIndex}，间隔: ${timeSinceLastRedraw}ms`)
          }

          // 添加重画任务的函数，用于延迟添加任务到队列
          const addRedrawTask = async (index: number, delay: number = 0) => {
            // 如果需要延迟，等待指定的时间
            if (delay > 0) {
              await new Promise(resolve => setTimeout(resolve, delay))
            }

            const targetBot = session.bot
            const targetChannelId = session.channelId
            const currentUserId = session.userId

            // 为每个重画任务创建一个新的session对象
            const taskSession = Object.create(session)

            // 确保关键属性被正确设置
            taskSession.userId = currentUserId
            taskSession.channelId = targetChannelId
            taskSession.bot = targetBot

            // 为 session 对象添加 isRedraw 属性，以便在 getToken 中识别重画任务
            taskSession.isRedraw = true

            // 生成任务唯一ID，用于调试和区分不同的重画任务
            const taskUniqueId = commandId * 100 + index  // 命令ID + 任务索引，确保唯一性

            // 为每个重画任务设置特殊处理
            if (Array.isArray(ctx.config.token)) {
              if (config.tokenStrategy === 'parallel') {
                // parallel策略：创建新的runtime状态，确保每个任务都能独立获取token
                taskSession.runtime = {
                  currentTokenIndex: undefined,
                  tokenUsage: {}, // 空对象，避免共享引用
                  _timeStamp: Date.now() + index,
                  _taskId: taskUniqueId
                }
                ctx.logger.debug(`为重画任务 ${taskUniqueId} 创建独立的session对象，确保能够独立获取token`)
              } else if (config.tokenStrategy === 'round-robin') {
                // round-robin策略：为每个任务分配唯一的 token 索引
                if (ctx.runtime) {
                  // 为了避免重画任务使用相同的 token，我们为每个任务生成一个唯一的 token 索引
                  // 计算一个索引偏移量，确保不同任务使用不同的 token
                  // 使用基于当前 token 索引、任务索引、任务唯一ID 的组合
                  let forcedTokenIndex

                  if (ctx.config.token.length <= 1) {
                    // 只有一个 token，直接使用
                    forcedTokenIndex = 0
                  } else {
                    // 计算任务专属的 token 索引
                    const baseIndex = ctx.runtime.currentTokenIndex
                    const taskOffset = (index * 3 + taskUniqueId) % ctx.config.token.length
                    const candidateIndex = (baseIndex + taskOffset) % ctx.config.token.length

                    // 使用队列系统的函数获取唯一索引
                    forcedTokenIndex = queueSystem.getUniqueTokenIndex(candidateIndex, ctx.config.token.length)

                    ctx.logger.debug(`重画任务 ${taskUniqueId} token索引计算: 基础=${baseIndex}, 任务偏移=${taskOffset}, 最终=${forcedTokenIndex}`)
                  }

                  // 更新 runtime 对象
                  taskSession.runtime = {
                    _timeStamp: Date.now() + index,
                    _redraw: true,
                    _forcedTokenIndex: forcedTokenIndex,  // 强制指定 token 索引
                    _taskIndex: index,                    // 任务索引
                    _taskId: taskUniqueId                 // 任务唯一ID
                  }

                  ctx.logger.debug(`为重画任务 ${taskUniqueId} 强制指定 token 索引: ${forcedTokenIndex}`)
                } else {
                  taskSession.runtime = {
                    _timeStamp: Date.now() + index,
                    _redraw: true,
                    _taskId: taskUniqueId
                  }
                  ctx.logger.debug(`为重画任务 ${taskUniqueId} 创建轮询session对象，将使用下一个可用token`)
                }
              } else if (config.tokenStrategy === 'random') {
                // random策略：不设置currentTokenIndex，每次调用getToken都会随机选择token
                taskSession.runtime = {
                  _timeStamp: Date.now() + index,
                  _redraw: true,
                  _taskId: taskUniqueId
                }
                ctx.logger.debug(`为重画任务 ${taskUniqueId} 创建随机策略session对象，将随机选择token`)
              } else if (config.tokenStrategy === 'fallback') {
                // fallback策略：不设置currentTokenIndex，每次都从第一个token开始尝试
                taskSession.runtime = {
                  _timeStamp: Date.now() + index,
                  _redraw: true,
                  _taskId: taskUniqueId
                }
                ctx.logger.debug(`为重画任务 ${taskUniqueId} 创建备用策略session对象，将从第一个token开始尝试`)
              }
            }

            // 为每个重画任务创建独立的 options 副本，并注入 _deductedPoints
            // 这是因为 generateImage 在请求失败时通过 return 而非 throw 处理错误，
            // 所以 reject 回调不会被调用，需要依靠 generateImage 内部的退款逻辑
            const taskOptions = { ...lastTask.options }
            if (config.membershipEnabled && config.pointsEnabled && lastTask.pointsCost > 0) {
              taskOptions._deductedPoints = lastTask.pointsCost
            }

            queueSystem.taskQueue.push({
              session: taskSession,  // 使用新创建的session对象
              options: taskOptions,
              input: lastTask.input,
              isRedraw: true,
              resolve: (value) => {
                queueSystem.userTasks[currentUserId]--
                targetBot.sendMessage(targetChannelId, value)
              },
              reject: (err) => {
                queueSystem.userTasks[currentUserId]--
                // 单次重画任务失败，退还该次对应的点数（后备方案，当 generateImage throw 时触发）
                // 检查 taskOptions._deductedPoints 而非 lastTask.pointsCost，
                // 因为 generateImage 内部退款后会将 _deductedPoints 设为 0，避免双重退款
                const remainingPoints = taskOptions._deductedPoints || 0
                if (config.membershipEnabled && config.pointsEnabled && remainingPoints > 0) {
                  taskOptions._deductedPoints = 0 // 标记已退款
                  membershipSystem.refundPoints(currentUserId, remainingPoints)
                    .catch(refundErr => ctx.logger.error(`[重画] 退还点数异常: ${refundErr.message}`))
                }
                targetBot.sendMessage(
                  targetChannelId,
                  handleError(ctx, session, err)
                )
              }
            })

            // 记录任务创建信息
            ctx.logger.debug(`创建重画任务 ${taskUniqueId}，任务索引: ${index}，命令ID: ${commandId}，当前队列长度: ${queueSystem.taskQueue.length}`)

            // 添加任务后立即处理队列，确保任务能够尽快开始处理
            queueSystem.processQueue()
          }

          // 简化重画调度：不再基于策略或延迟，直接添加所有任务
          for (let i = 0; i < repeatCount; i++) {
            addRedrawTask(i)
          }
        } catch (err) {
          queueSystem.releaseRedrawLock() // 确保发生错误时释放锁
          return handleError(ctx, session, err)
        }

        // 任务成功添加后释放锁
        queueSystem.releaseRedrawLock()
      } catch (error) {
        // 确保任何错误情况下都释放锁
        queueSystem.releaseRedrawLock()
        throw error
      }
    })

  ctx.middleware(async (session, next) => {
    const content = session.stripped.content
    if (/^重画[\d一二两三四五六七八九十]+/.test(content)) {
      const matched = content.match(/^重画([\d一二两三四五六七八九十]+)/)
      if (matched) {
        return session.execute(`重画 ${matched[1]}`, next)
      }
    }
    return next()
  })
}