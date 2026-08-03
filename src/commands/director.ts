// 导演工具命令：director 主命令与 lineart/sketch/bg-removal/declutter/colorize/emotion 快捷命令
import { Context, h, Quester } from 'koishi'
import { Config } from '../config'
import { DirectorTools, ImageData } from '../types'
import { download, extractImages, getImageSize, NetworkError } from '../utils'
import { callDirectorToolsAPI, EMOTION_MAP } from '../services/director'
import { Runtime } from '../runtime'

export function registerDirector(ctx: Context, config: Config, runtime: Runtime) {
  const { queueSystem, membershipSystem, getToken } = runtime
  // ========== Director Tools 功能 ==========
  if (config.directorToolsEnabled !== false) {  // 默认启用

    // Director Tools 图像处理核心函数

    // 创建 Director Tools 命令
    const directorCmd = ctx.command('director <tool:string> [prompt:text]', 'NovelAI Director Tools - 图像处理工具')
      .alias('导演工具')
      .userFields(['authority'])
      .option('defry', '-d <defry:number>', { fallback: config.directorToolsDefaultDefry ?? 0 })
      .usage(`
NovelAI Director Tools 图像处理工具

可用工具：
• bg-removal  - 背景移除（⚠️ 消耗大量 Anlas，默认关闭，需管理员启用）
• lineart     - 线稿提取
• sketch      - 素描转换
• colorize    - 图像上色（提示词可选）
• emotion     - 表情修改（需要指定表情）
• declutter   - 删文字

发送图片的方式：
✅ 直接发送：[图片] + 指令
✅ 回复图片：回复包含图片的消息 + 指令
✅ 等待发送：先发送指令，再发送图片（60秒内）

使用方法：
1. 基础工具（无需额外参数）：
   线稿 [图片]
   director.lineart [图片]
   素描 [图片]
   director.sketch [图片]
   去背景 [图片]
   director.bg-removal [图片]
   删文字 [图片]
   director.declutter [图片]
   
2. 上色工具（提示词可选，图片可在前后）：
   上色/director.colorize [图片]                             
   上色/director.colorize [tags] [图片]                        
   上色/director.colorize -d 2 [tags] [图片]   # 调整强度(-d 0-5)
   
3. 表情修改（必须指定表情，图片可在前后）：
   改表情/director.emotion 开心 [图片]                        
   改表情/director.emotion happy [图片]
   改表情/director.emotion happy -d 1 [图片]       # 调整强度(-d 0-5)

参数说明：
-d <0-5>  降低工具影响强度（值越高变化越小，仅用于 colorize 和 emotion）

支持的表情：
平静、开心、伤心、生气、害怕、吃惊、疲惫、兴奋、紧张、思考、困惑、害羞、
厌恶、得意、无聊、大笑、恼怒、激情、尴尬、担心、爱意、坚定、受伤、调皮
      `)
      .action(async ({ session, options }, tool, promptText) => {

        if (config.debugLog) {
          ctx.logger.info(`[Director Tools] 命令调用开始`)
          ctx.logger.info(`[Director Tools] 参数 - tool: ${tool}, prompt: ${promptText}, defry: ${options.defry}`)
        }

        // ===== 参数验证阶段（不进入队列）=====

        // 1. 验证工具类型
        const validTools: DirectorTools.ToolType[] = ['bg-removal', 'lineart', 'sketch', 'colorize', 'emotion', 'declutter']

        if (!tool) {
          ctx.logger.warn('[Director Tools] 缺少工具类型参数')
          return '❌ 请指定工具类型\n\n可用工具：bg-removal, lineart, sketch, colorize, emotion, declutter\n\n发送 "help director" 查看详细说明'
        }

        const toolType = tool.toLowerCase() as DirectorTools.ToolType

        if (!validTools.includes(toolType)) {
          ctx.logger.warn(`[Director Tools] 无效的工具类型: ${tool}`)
          return `❌ 无效的工具类型: ${tool}\n\n可用工具：${validTools.join(', ')}\n\n发送 "help director" 查看详细说明`
        }

        // 检查 bg-removal 是否启用
        if (toolType === 'bg-removal' && config.directorToolsBgRemovalEnabled !== true) {
          ctx.logger.warn('[Director Tools] bg-removal 功能未启用')
          return '❌ 背景移除功能未启用\n\n该功能消耗较多 Anlas，需要管理员在配置中启用\n配置项：directorToolsBgRemovalEnabled: true'
        }

        // 2. 提取图片并清理 prompt 中的图片标签（不使用 h.parse，避免 `>_<` 等裸 `<` 被误解析）
        let imgUrl: string
        const inputContent = session.content || ''

        // 提取图片并移除 img 元素
        const extracted = extractImages(inputContent)
        imgUrl = extracted.urls[0]
        const cleanedInput = extracted.input

        // 如果消息中没有图片，尝试从引用消息中提取
        if (!imgUrl && session.quote) {
          imgUrl = extractImages(session.quote.content || '').urls[0]

          if (config.debugLog && imgUrl) {
            ctx.logger.info(`[Director Tools] 从引用消息中提取到图片`)
          }
        }

        // 如果仍然没有图片，等待用户发送
        if (!imgUrl) {
          ctx.logger.info('[Director Tools] 消息中未找到图片，等待用户发送')

          const promptMsg = await session.send('请60s内发送图片')

          try {
            // 等待用户发送图片，超时时间 60 秒
            const userInput = await session.prompt(60000)

            if (!userInput) {
              ctx.logger.warn('[Director Tools] 用户超时未发送图片')
              return '⏱️ 超时未收到图片，操作已取消'
            }

            // 从用户发送的消息中提取图片
            imgUrl = extractImages(userInput).urls[0]

            if (!imgUrl) {
              ctx.logger.warn('[Director Tools] 用户发送的消息中没有图片')
              return '❌ 未检测到图片，操作已取消\n\n请确保发送的是图片消息'
            }

            if (config.debugLog) {
              ctx.logger.info(`[Director Tools] 从用户发送的消息中提取到图片`)
            }
          } catch (err) {
            ctx.logger.error(`[Director Tools] 等待用户输入时出错: ${err.message}`)
            return '❌ 等待图片时出错，操作已取消'
          }
        }

        // 清理后的 prompt（移除了图片标签）
        // 需要移除命令前缀：director、导演工具、以及子命令（director.emotion、表情、改表情等）
        let cleanedPrompt = cleanedInput
          .replace(/^(director|导演工具)\s+/i, '')  // 移除主命令
          .replace(/^(director\.\w+|表情|改表情|上色|线稿|素描|去背景|移除背景|去杂乱|清理图片|删文字|提取线稿|转素描)\s*/i, '')  // 移除子命令/别名
          .trim()

        if (config.debugLog) {
          ctx.logger.info(`[Director Tools] 检测到图片 URL: ${imgUrl.substring(0, 50)}...`)
          ctx.logger.info(`[Director Tools] 原始 promptText: ${promptText}`)
          ctx.logger.info(`[Director Tools] cleanedInput: ${cleanedInput}`)
          ctx.logger.info(`[Director Tools] 清理后 prompt: ${cleanedPrompt}`)
        }

        // 使用清理后的 prompt 替换原 promptText
        if (cleanedPrompt) {
          promptText = cleanedPrompt
        } else {
          promptText = undefined
        }

        // 3. colorize 的提示词是可选的（不验证）
        if (config.debugLog && toolType === 'colorize') {
          ctx.logger.info(`[Director Tools] colorize 提示词: ${promptText || '(使用默认)'}`)
        }

        // 4. 验证和处理 emotion 的特殊要求
        let emotionValue: string = ''
        let emotionPrompt: string = ''

        if (toolType === 'emotion') {
          if (!promptText) {
            ctx.logger.warn('[Director Tools] emotion 缺少表情参数')
            return `❌ emotion 需要提供表情\n\n支持的表情：\n${Object.keys(EMOTION_MAP).join('、')}\n或英文表情名\n\n例如：[图片] director emotion 开心`
          }

          // 分离表情和提示词（使用清理后的 promptText）
          const parts = promptText.trim().split(/\s+/)
          emotionValue = parts[0]
          emotionPrompt = parts.slice(1).join(' ')

          // 验证表情（支持中英文）
          const emotionEn = EMOTION_MAP[emotionValue] || emotionValue
          if (!Object.values(EMOTION_MAP).includes(emotionEn as DirectorTools.Emotion)) {
            ctx.logger.warn(`[Director Tools] 无效的表情: ${emotionValue}`)
            return `❌ 无效的表情: ${emotionValue}\n\n支持的表情：\n${Object.keys(EMOTION_MAP).join('、')}\n或英文：${Object.values(EMOTION_MAP).join(', ')}`
          }

          if (config.debugLog) {
            ctx.logger.info(`[Director Tools] 表情验证通过: ${emotionValue} -> ${emotionEn}`)
            ctx.logger.info(`[Director Tools] emotion 附加描述: ${emotionPrompt || '(无)'}`)
          }
        }

        // 5. 验证 defry 参数
        const defaultDefry = config.directorToolsDefaultDefry ?? 0
        const isDefryExplicitlySet = options.defry !== undefined && options.defry !== defaultDefry

        if (options.defry !== undefined) {
          if (options.defry < 0 || options.defry > 5) {
            ctx.logger.warn(`[Director Tools] defry 参数超出范围: ${options.defry}`)
            return '❌ defry 参数必须在 0-5 之间'
          }

          // 只有当用户明确指定了 defry（不是默认值）且工具不支持时才报错
          if (isDefryExplicitlySet && toolType !== 'colorize' && toolType !== 'emotion') {
            ctx.logger.warn(`[Director Tools] ${toolType} 不支持 defry 参数，用户明确指定了: ${options.defry}`)
            return `❌ ${toolType} 工具不支持 defry 参数\n\ndefry 仅用于 colorize 和 emotion 工具`
          }
        }

        if (config.debugLog) {
          ctx.logger.info('[Director Tools] 所有参数验证通过，准备添加到队列')
        }

        // ===== 队列和会员检查阶段 =====

        // 检查会员状态和使用次数限制
        if (config.membershipEnabled) {
          const userId = session.userId
          const canUse = membershipSystem.canUseDrawing(userId, session)

          if (typeof canUse === 'string') {
            if (config.debugLog) {
              ctx.logger.info(`[Director Tools] 会员检查未通过: ${canUse}`)
            }
            return canUse
          }
        }

        // 检查用户是否可以添加任务
        const userId = session.userId
        const canAddResult = queueSystem.canAddTask(userId)
        if (!canAddResult.canAdd) {
          const [msgKey, ...params] = canAddResult.message.split(':')
          if (config.debugLog) {
            ctx.logger.info(`[Director Tools] 队列检查未通过: ${canAddResult.message}`)
          }
          return session.text(`commands.novelai.messages.${msgKey}`, params.map(p => parseInt(p) || p))
        }

        // ===== 提前下载图片与计费检查 =====
        let imageData: ImageData
        try {
          if (config.debugLog) {
            ctx.logger.info(`[Director Tools] 提前下载图片以进行扣费预检`)
          }
          imageData = await download(ctx, imgUrl)
        } catch (err) {
          ctx.logger.error(`[Director Tools] 图片下载失败: ${err.message}`, err)
          if (err instanceof NetworkError) {
            return session.text(err.message, err.params)
          }
          return session.text('commands.novelai.messages.download-error')
        }

        let deductedPoints = 0
        if (config.membershipEnabled && config.pointsEnabled) {
          const size = getImageSize(imageData.buffer)
          const pointsCost = membershipSystem.calculateDirectorPointsCost(size.width, size.height, toolType)

          if (pointsCost > 0) {
            const result = await membershipSystem.deductPoints(userId, pointsCost)
            if (result === -1) {
              const currentPoints = membershipSystem.getPoints(userId)
              // 直接回复错误并结束，不会进入排队
              return session.text('commands.novelai.messages.points-insufficient', [currentPoints, pointsCost])
            }
            deductedPoints = pointsCost // 记录已扣点数用于可能的退款
          }
        }

        // 增加用户任务计数（真正开始排队）
        queueSystem.incrementUserTask(userId, 1)

        // 显示队列信息
        const now = Date.now()
        const { totalWaiting, userQueue } = queueSystem.getQueueStatus(userId)
        const totalWithCurrent = totalWaiting + 1

        if ((totalWithCurrent > 0 || userQueue > 0) && config.showQueueInfo) {
          ctx.logger.debug(`[Director Tools] 队列信息 - 总队列: ${totalWithCurrent}, 用户队列: ${userQueue}`)

          // 构建点数信息
          const pointsInfo = (deductedPoints > 0)
            ? session.text('commands.novelai.messages.points-deducted', [deductedPoints])
            : ''

          const queueMsg = session.text('commands.novelai.messages.queue-position', [totalWithCurrent, userQueue]) + pointsInfo
          await session.send(queueMsg)

          // 更新最后绘图时间
          if (config.membershipEnabled) {
            membershipSystem.updateLastDrawTime(userId, now)
          }
        }

        // ===== 任务处理阶段（进入队列）=====

        // 创建任务处理函数
        const executeDirectorTask = async () => {
          // 借用一个 token 索引并写入 session.runtime 供 getToken() 使用
          const borrowedIdx = queueSystem.borrowTokenIndex()
            ; (session as any).runtime = {
              ...(session as any).runtime,
              _forcedTokenIndex: borrowedIdx,
            }
          try {
            // 步骤 2: 获取 Token
            if (config.debugLog) {
              ctx.logger.info('[Director Tools Task] 开始获取 token')
            }

            let token: string
            try {
              token = await getToken(session)
              if (config.debugLog) {
                ctx.logger.info('[Director Tools Task] Token 获取成功')
              }
            } catch (err) {
              ctx.logger.error(`[Director Tools Task] Token 获取失败: ${err.message}`, err)
              if (err instanceof NetworkError) {
                throw err
              }
              throw new NetworkError('commands.novelai.messages.unknown-error')
            }

            // 步骤 3: 准备请求参数
            const requestOptions: { defry?: number; prompt?: string } = {}

            // 处理 defry 参数
            if (toolType === 'colorize' || toolType === 'emotion') {
              requestOptions.defry = options.defry ?? config.directorToolsDefaultDefry ?? 0
              if (config.debugLog) {
                ctx.logger.info(`[Director Tools Task] 使用 defry: ${requestOptions.defry}`)
              }
            }

            // 处理 prompt 参数
            if (toolType === 'emotion') {
              // emotion 的特殊格式: "{emotion};;{prompt}"
              const emotionEn = EMOTION_MAP[emotionValue] || emotionValue
              requestOptions.prompt = emotionPrompt
                ? `${emotionEn};;${emotionPrompt}`
                : emotionEn

              if (config.debugLog) {
                ctx.logger.info(`[Director Tools Task] emotion prompt: ${requestOptions.prompt}`)
              }
            } else if (toolType === 'colorize' && promptText) {
              // colorize 的 prompt 是可选的，只在有提示词时添加
              requestOptions.prompt = promptText

              if (config.debugLog) {
                ctx.logger.info(`[Director Tools Task] colorize prompt: ${requestOptions.prompt}`)
              }
            } else if (toolType === 'colorize') {
              if (config.debugLog) {
                ctx.logger.info(`[Director Tools Task] colorize 无提示词，使用默认`)
              }
            }

            // 步骤 4: 调用 API
            if (config.debugLog) {
              ctx.logger.info('[Director Tools Task] 开始调用 NovelAI API')
            }

            let resultDataUrl: string
            try {
              resultDataUrl = await callDirectorToolsAPI(config, ctx, toolType, imageData, token, requestOptions)

              if (config.debugLog) {
                ctx.logger.info('[Director Tools Task] API 调用成功')
              }
            } catch (err) {
              ctx.logger.error(`[Director Tools Task] API 调用失败: ${err.message}`, err)

              if (Quester.Error.is(err)) {
                if (err.response?.status === 402) {
                  throw new NetworkError('commands.novelai.messages.unauthorized')
                } else if (err.response?.status === 429) {
                  throw new NetworkError('commands.novelai.messages.request-failed', { code: '请求过于频繁' })
                } else if (err.response?.status) {
                  throw new NetworkError('commands.novelai.messages.response-error', { status: err.response.status })
                } else if (err.code === 'ETIMEDOUT') {
                  throw new NetworkError('commands.novelai.messages.request-timeout')
                } else if (err.code) {
                  throw new NetworkError('commands.novelai.messages.request-failed', { code: err.code })
                }
              }

              throw new NetworkError('commands.novelai.messages.unknown-error')
            }

            // 步骤 5: 构建并发送结果
            const toolNameMap: Record<DirectorTools.ToolType, string> = {
              'bg-removal': '背景移除',
              'lineart': '线稿提取',
              'sketch': '素描转换',
              'colorize': '图像上色',
              'emotion': '表情修改',
              'declutter': '删文字',
            }

            const toolName = toolNameMap[toolType]

            if (config.debugLog) {
              ctx.logger.info(`[Director Tools Task] 任务完成，准备发送结果`)
              ctx.logger.info(`[Director Tools Task] 结果 DataURL 长度: ${resultDataUrl.length}`)
              ctx.logger.info(`[Director Tools Task] DataURL 前缀: ${resultDataUrl.substring(0, 50)}`)
            }

            // 将 DataURL 转换回 PNG 文件 Buffer（让 QQ 正确识别文件类型）
            const base64Data = resultDataUrl.split(',')[1]
            const imageBuffer = Buffer.from(base64Data, 'base64')
            const imageSizeKB = Math.round(imageBuffer.length / 1024)

            if (config.debugLog) {
              ctx.logger.info(`[Director Tools Task] 结果图片大小: ${imageSizeKB}KB`)
              ctx.logger.info(`[Director Tools Task] 准备将图片作为 PNG 文件发送`)
            }

            // 如果图片太大，警告用户
            if (imageSizeKB > 5000) {
              ctx.logger.warn(`[Director Tools Task] 结果图片过大: ${imageSizeKB}KB，可能发送失败`)
              await session.send(`⚠️ 处理完成，但图片较大（${imageSizeKB}KB），可能上传失败`)
            }

            // 发送图片（使用 Buffer 方式，让平台正确识别为 PNG 文件）
            try {
              const output = session.resolve(config.output ?? 'default')

              if (config.debugLog) {
                ctx.logger.info(`[Director Tools Task] 输出模式: ${output}`)
              }

              // 先发送提示文本（非 minimal 模式）
              if (output !== 'minimal') {
                await session.send(`✨ ${toolName} 完成！`)
                if (config.debugLog) {
                  ctx.logger.info(`[Director Tools Task] 提示文本发送完成`)
                }
              }
              if (config.showTokenSuccessPrefix) {
                const idx = typeof (session as any)?.runtime?._forcedTokenIndex === 'number'
                  ? (session as any).runtime._forcedTokenIndex
                  : null
                if (idx != null) {
                  await session.send(`token[${idx}] 成功`)
                }
              }

              // 使用 h.image 发送 PNG 文件（传入 Buffer）
              // Koishi 会自动处理 Buffer 类型并正确上传
              if (config.debugLog) {
                ctx.logger.info(`[Director Tools Task] 准备发送图片，Buffer 大小: ${imageBuffer.length} bytes`)
              }

              // 创建图片元素，使用 DataURL 方式（最兼容）
              const imageElement = h.image(resultDataUrl)

              if (config.debugLog) {
                ctx.logger.info(`[Director Tools Task] 图片元素创建完成: ${JSON.stringify(imageElement)}`)
              }

              await session.send(imageElement)

              if (config.debugLog) {
                ctx.logger.info(`[Director Tools Task] 图片发送完成`)
              }
            } catch (sendErr) {
              ctx.logger.error(`[Director Tools Task] 发送结果失败: ${sendErr.message}`, sendErr)

              if (config.debugLog) {
                ctx.logger.error(`[Director Tools Task] 发送错误详情:`, sendErr)
                ctx.logger.error(`[Director Tools Task] 错误堆栈:`, sendErr.stack)
              }

              // 通知用户发送失败
              try {
                await session.send(`❌ 图片发送失败\n图片大小：${imageSizeKB}KB\n可能原因：图片过大或平台限制\n\n建议：使用分辨率较小的原图`)
              } catch (notifyErr) {
                ctx.logger.error(`[Director Tools Task] 无法发送错误通知: ${notifyErr.message}`)
              }
            }

            // 返回 undefined（任务已完成，结果已发送）
            return

          } catch (err) {
            ctx.logger.error(`[Director Tools Task] 任务执行失败: ${err.message}`, err)
            // 错误已经在外层 catch 中处理，这里重新抛出
            throw err
          }
          finally {
            // 归还借用的 token 索引
            if (typeof borrowedIdx === 'number') {
              queueSystem.returnTokenIndex(borrowedIdx)
            }
          }
        }

        // 添加到队列并执行
        if (config.debugLog) {
          ctx.logger.info(`[Director Tools] 准备将任务添加到队列`)
        }

        // Director Tools 直接执行，共享队列限制但不走 generateImage 流程
        return new Promise((resolveTask, rejectTask) => {
          // 将任务添加到队列管理中（用于并发控制）
          const taskWrapper = {
            session,
            options: { toolType, promptText, emotionValue, emotionPrompt, ...options },
            input: `director:${toolType}`,
            isRedraw: false,
            resolve: resolveTask,
            reject: rejectTask
          }

          // 使用 Promise 包装异步执行，遵守队列并发限制
          const executeWhenReady = async () => {
            // 等待队列有空位
            while (queueSystem.processingTasks >= queueSystem.maxConcurrentTasks) {
              await new Promise(r => setTimeout(r, 100))
            }

            queueSystem.processingTasks++

            if (config.debugLog) {
              ctx.logger.info(`[Director Tools] 开始执行任务: ${toolType}`)
            }

            try {
              // 直接执行 Director Tools 任务
              await executeDirectorTask()

              // 任务成功完成，减少用户计数
              queueSystem.userTasks[userId]--

              // 导演工具成功后，增加使用次数
              if (config.membershipEnabled) {
                membershipSystem.incrementUsage(userId, 1)
              }

              resolveTask(undefined)

              if (config.debugLog) {
                ctx.logger.info(`[Director Tools] 任务执行成功`)
              }
            } catch (err) {
              // 任务失败，减少用户计数
              queueSystem.userTasks[userId]--

              // 因为报错导致没画成，执行一次全部退款
              if (config.membershipEnabled && config.pointsEnabled && deductedPoints > 0) {
                membershipSystem.refundPoints(userId, deductedPoints)
                  .catch(refundErr => ctx.logger.error(`[Director Tools] 失败返还点数异常: ${refundErr.message}`))
              }

              ctx.logger.error(`[Director Tools] 任务执行失败: ${err.message}`, err)

              // 向用户发送错误消息（只发送一次）
              try {
                const idx = typeof (session as any)?.runtime?._forcedTokenIndex === 'number'
                  ? (session as any).runtime._forcedTokenIndex
                  : null
                const prefix = idx != null ? `token[${idx}] ` : ''
                if (err instanceof NetworkError) {
                  await session.send(prefix + session.text(err.message, err.params))
                } else {
                  await session.send(prefix + '发生未知错误')
                }
              } catch (sendErr) {
                ctx.logger.error(`[Director Tools] 发送错误消息失败: ${sendErr.message}`)
              }

              // 使用 resolveTask 而不是 rejectTask
              // 因为错误已经处理并发送给用户，避免 Koishi 命令系统再次处理导致重复发送
              resolveTask(undefined)
            } finally {
              queueSystem.processingTasks--
              // 处理队列中的下一个任务
              queueSystem.processQueue()
            }
          }

          // 立即开始执行
          executeWhenReady()
        })
      })

    // 添加便捷别名命令（不需要 defry 参数的工具）
    ctx.command('director.lineart', '提取线稿')
      .alias('线稿', '提取线稿')
      .userFields(['authority'])
      .usage('从图像中提取线稿\n\n使用方法：\n• [图片] 线稿\n• 回复图片消息发送：线稿\n• 先发送指令：线稿（然后发图）')
      .action(({ session }) => {
        // 直接执行主命令，会自动处理图片提取和等待逻辑
        return session.execute(`director lineart`)
      })

    ctx.command('director.sketch', '转换为素描')
      .alias('素描', '转素描')
      .userFields(['authority'])
      .usage('将图像转换为素描风格\n\n使用方法：\n• [图片] 素描\n• 回复图片消息发送：素描\n• 先发送指令：素描（然后发图）')
      .action(({ session }) => {
        return session.execute(`director sketch`)
      })

    ctx.command('director.bg-removal', '移除背景')
      .alias('移除背景', '去背景')
      .userFields(['authority'])
      .usage('移除图像背景（消耗较多 Anlas，需要启用）\n\n使用方法：\n• [图片] 去背景\n• 回复图片消息发送：去背景\n• 先发送指令：去背景（然后发图）')
      .action(({ session }) => {
        // 检查是否启用
        if (config.directorToolsBgRemovalEnabled !== true) {
          return '❌ 背景移除功能未启用\n\n该功能消耗较多 Anlas，需要管理员在配置中启用\n配置项：directorToolsBgRemovalEnabled: true'
        }
        return session.execute(`director bg-removal`)
      })

    ctx.command('director.declutter', '去除杂乱元素')
      .alias('去杂乱', '清理图片', '删文字')
      .userFields(['authority'])
      .usage('去除图像中的杂乱元素\n\n使用方法：\n• [图片] 删文字\n• 回复图片消息发送：删文字\n• 先发送指令：删文字（然后发图）')
      .action(({ session }) => {
        return session.execute(`director declutter`)
      })

    ctx.command('director.colorize [prompt:text]', '图像上色')
      .alias('上色')
      .userFields(['authority'])
      .option('defry', '-d <defry:number>', { fallback: config.directorToolsDefaultDefry ?? 0 })
      .usage(`
为图像上色（提示词可选）

使用方法：
• [图片] 上色
• 上色 [tags] [图片]
• 上色 -d 2 [tags]  # 然后发送图片
• 回复图片消息发送：上色 [tags]

参数说明：
-d <0-5>  调整强度，值越高变化越小
      `)
      .action(({ session, options }, prompt) => {
        const defryArg = options.defry !== (config.directorToolsDefaultDefry ?? 0) ? ` -d ${options.defry}` : ''
        if (prompt) {
          return session.execute(`director colorize ${prompt}${defryArg}`)
        } else {
          return session.execute(`director colorize${defryArg}`)
        }
      })

    ctx.command('director.emotion <emotion:text>', '表情修改')
      .alias('改表情')
      .userFields(['authority'])
      .option('defry', '-d <defry:number>', { fallback: config.directorToolsDefaultDefry ?? 0 })
      .usage(`
修改角色表情

支持的表情：
平静、开心、伤心、生气、害怕、吃惊、疲惫、兴奋、紧张、思考、困惑、害羞、
厌恶、得意、无聊、大笑、恼怒、激情、尴尬、担心、爱意、坚定、受伤、调皮

使用方法：
• [图片] 改表情 开心
• 改表情 happy  # 然后发送图片
• 改表情 happy -d 1 [图片]
• 回复图片消息发送：改表情 开心

参数说明：
-d <0-5>  值越高变化越小，更保留原表情
      `)
      .action(({ session, options }, emotion) => {
        if (!emotion) {
          return `❌ 请指定表情\n\n支持的表情：\n${Object.keys(EMOTION_MAP).join('、')}\n\n例如：改表情 开心`
        }
        const defryArg = options.defry !== (config.directorToolsDefaultDefry ?? 0) ? ` -d ${options.defry}` : ''
        return session.execute(`director emotion ${emotion}${defryArg}`)
      })
  }
}
