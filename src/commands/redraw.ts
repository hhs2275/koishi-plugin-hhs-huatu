// 重画命令与快捷中间件：基于上次任务参数重复生成
import { Context, h } from 'koishi'
import { Config, orientMap } from '../config'
import { handleError, Runtime } from '../runtime'
import { calculateTaskPointsCost, getTaskDrawCount } from '../services/points'

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

        // ===== 重画点数预扣（按当前 nai5 日限逐张重算，不能复用上次免费单价） =====
        let redrawDeductedPoints = 0
        let redrawPerTask: number[] = []
        let nai5Overage = false
        if (config.membershipEnabled && config.pointsEnabled) {
          let resWidth = 832, resHeight = 1216
          const lastOptions = lastTask.options || {}
          if (lastOptions.inpaint && lastOptions._alignedWidth && lastOptions._alignedHeight) {
            resWidth = lastOptions._alignedWidth
            resHeight = lastOptions._alignedHeight
          } else if (lastOptions.resolution) {
            resWidth = lastOptions.resolution.width || 832
            resHeight = lastOptions.resolution.height || 1216
          } else {
            const res = session.resolve(config.resolution)
            if (typeof res === 'string' && orientMap[res]) {
              resWidth = orientMap[res].width
              resHeight = orientMap[res].height
            } else if (res && typeof res === 'object') {
              resWidth = (res as any).width || 832
              resHeight = (res as any).height || 1216
            }
          }

          const imgUrl_check = h.select(session.elements ?? [], 'img').length > 0
            || /<img\b[^>]*?>/i.test(lastTask.input || '')
            || lastOptions.inpaint
          const preciseRefCount = lastOptions._preciseRefImages?.length || 0
          const drawCount = getTaskDrawCount(lastOptions, repeatCount)
          const cost = calculateTaskPointsCost(
            runtime, session, lastOptions, resWidth, resHeight, !!lastOptions.inpaint || imgUrl_check, preciseRefCount,
            userId, lastOptions.model || config.model, drawCount,
          )
          const imagesPerTask = Math.max(1, Math.floor(drawCount / repeatCount))
          for (let i = 0; i < repeatCount; i++) {
            const start = i * imagesPerTask
            redrawPerTask.push(cost.perImage.slice(start, start + imagesPerTask).reduce((sum, n) => sum + n, 0))
          }
          nai5Overage = membershipSystem.shouldChargeNai5Overage(userId, lastOptions.model || config.model, drawCount)
          if (membershipSystem.isNai5Model(lastOptions.model || config.model) && membershipSystem.getNai5DailyLimit(userId) > 0) {
            membershipSystem.reserveNai5Usage(userId, drawCount)
          }
          if (cost.total > 0) {
            const result = await membershipSystem.deductPoints(userId, cost.total)
            if (result === -1) {
              membershipSystem.releaseNai5Usage(userId, drawCount)
              const currentPoints = membershipSystem.getPoints(userId)
              queueSystem.releaseRedrawLock()
              return session.text('commands.novelai.messages.points-insufficient', [currentPoints, cost.total])
            }
            redrawDeductedPoints = cost.total
          }
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
          const overageInfo = nai5Overage
            ? session.text('commands.novelai.messages.nai5-overage-charged')
            : ''
          await session.send([queueMsg + pointsInfo, overageInfo].filter(Boolean).join('\n'))

          // 在发送队列信息后立即更新lastDrawTime
          if (config.membershipEnabled) {
            const tier = membershipSystem.getActiveTier(userId)
            const benefit = tier > 0 ? membershipSystem.getTierBenefit(tier) : null
            const user = userData[userId] || {
              isMember: false,
              membershipExpiry: 0,
              dailyUsage: 0,
              lastUsed: Date.now(),
              dailyLimit: config.nonMemberDailyLimit
            }

            // 计算所需的CD时间（每张图的CD时间 * 重画数量），会员按生效等级取值
            const cooldownPerImage = benefit ? benefit.cooldown : config.nonMemberCooldown
            const totalCooldown = cooldownPerImage * repeatCount

            // 更新lastDrawTime，考虑多张图的CD累加
            if (user.lastDrawTime) {
              userData[userId].lastDrawTime = Date.now() + (totalCooldown * 1000) - (cooldownPerImage * 1000)
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

          // 重画任务也统一交给队列分配 token，避免预先计算的索引被队列覆盖。
          // 轮询、随机和兼容旧配置的策略都由 QueueSystem 作为唯一分配入口处理。
          if (Array.isArray(ctx.config.token)) {
            queueSystem.setLastRedrawTime(now)
            ctx.logger.debug(`重画命令(${commandId})开始，token 使用策略: ${config.tokenStrategy || 'round-robin'}`)
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

            // 只记录重画元数据；真正的 token 索引由 QueueSystem 在任务开始时分配。
            if (Array.isArray(ctx.config.token)) {
              taskSession.runtime = {
                _timeStamp: Date.now() + index,
                _redraw: true,
                _taskIndex: index,
                _taskId: taskUniqueId
              }
            }

            // 为每个重画任务创建独立的 options 副本，并注入 _deductedPoints
            // 这是因为 generateImage 在请求失败时通过 return 而非 throw 处理错误，
            // 所以 reject 回调不会被调用，需要依靠 generateImage 内部的退款逻辑
            const taskOptions = { ...lastTask.options }
            if (config.membershipEnabled && config.pointsEnabled) {
              const unitCost = redrawPerTask[index] || 0
              if (unitCost > 0) taskOptions._deductedPoints = unitCost
            }
            if (config.membershipEnabled && membershipSystem.isNai5Model(lastTask.options?.model || config.model) && membershipSystem.getNai5DailyLimit(currentUserId) > 0) {
              taskOptions._reservedNai5 = getTaskDrawCount(lastTask.options, 1)
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
