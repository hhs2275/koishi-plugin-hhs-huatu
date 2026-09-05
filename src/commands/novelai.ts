// novelai 主绘图命令（含快捷别名、选项解析）与 upscale 子命令
import { Context, h, Session, trimSlash } from 'koishi'
import { Config, models, orientMap, sampler, scheduler, upscalers } from '../config'
import { ImageData, StableDiffusionWebUI } from '../types'
import { clampToNAILimit, download, extractImages, forceDataPrefix, NetworkError } from '../utils'
import { Runtime } from '../runtime'
import { runInpaintInteraction } from '../interactions/inpaint'
import { runPreciseRefInteraction } from '../interactions/preciseRef'
import { calculateTaskPointsCost, getTaskDrawCount } from '../services/points'
function extractOptionsFromUndesired(undesired: string): { cleanedUndesired: string; extractedOptions: any } {
  const extractedOptions: any = {}
  let cleanedUndesired = undesired.trim()

  // 定义选项模式，按优先级排序（更具体的模式在前）
  const optionPatterns = [
    // 带引号的选项（优先级最高）
    { pattern: /-K\s+["']([^"']*)["']/g, key: 'chars' },
    { pattern: /-m\s+["']([^"']*)["']/g, key: 'model' },
    { pattern: /-s\s+["']([^"']*)["']/g, key: 'sampler' },
    { pattern: /-r\s+["']([^"']*)["']/g, key: 'resolution' },
    { pattern: /-o\s+["']([^"']*)["']/g, key: 'output' },
    { pattern: /-C\s+["']([^"']*)["']/g, key: 'scheduler' },

    // 不带引号的选项
    { pattern: /-K\s+(\S+)/g, key: 'chars' },
    { pattern: /-m\s+(\w+)/g, key: 'model' },
    { pattern: /-s\s+(\w+)/g, key: 'sampler' },
    { pattern: /-r\s+([\w\d]+)/g, key: 'resolution' },
    { pattern: /-o\s+(\w+)/g, key: 'output' },
    { pattern: /-O\s*/g, key: 'override', value: true },
    { pattern: /-x\s+(\d+)/g, key: 'seed' },
    { pattern: /-t\s+(\d+)/g, key: 'steps' },
    { pattern: /-c\s+([\d.]+)/g, key: 'scale' },
    { pattern: /-R\s+([\d.]+)/g, key: 'rescale' },
    { pattern: /-n\s+([\d.]+)/g, key: 'noise' },
    { pattern: /-N\s+([\d.]+)/g, key: 'strength' },
    { pattern: /-v\s+([\d.]+)/g, key: 'skipCfgAboveSigma' },
    { pattern: /-H\s*/g, key: 'hiresFix', value: true },
    { pattern: /-S\s*/g, key: 'smea', value: true },
    { pattern: /-d\s*/g, key: 'smeaDyn', value: true },
    { pattern: /-C\s+(\w+)/g, key: 'scheduler' },
    { pattern: /-D\s*/g, key: 'decrisper', value: true },
    { pattern: /-T\s*/g, key: 'noTranslator', value: true },
    { pattern: /-i\s+(\d+)/g, key: 'iterations' },
    { pattern: /-b\s+(\d+)/g, key: 'batch' },

  ]

  // 提取选项
  for (const { pattern, key, value } of optionPatterns) {
    const matches = [...cleanedUndesired.matchAll(pattern)]
    for (const match of matches) {
      if (value !== undefined) {
        extractedOptions[key] = value
      } else if (match[1]) {
        extractedOptions[key] = match[1]
      }
      // 从 undesired 中移除这个选项
      cleanedUndesired = cleanedUndesired.replace(match[0], '').trim()
    }
  }

  // 清理多余的空白和可能残留的引号
  cleanedUndesired = cleanedUndesired.replace(/\s+/g, ' ').trim()
  cleanedUndesired = cleanedUndesired.replace(/^["']|["']$/g, '').trim()

  return { cleanedUndesired, extractedOptions }
}


export function registerNovelai(ctx: Context, config: Config, runtime: Runtime) {
  const { membershipSystem, queueSystem, useFilter, useBackend, thirdParty, noImage, some, step, resolution } = runtime
  const recentCommandMessages = new Map<string, number>()
  const commandDedupWindow = 30_000

  // 某些适配器在重连或消息回执异常时，可能会把同一条消息重复投递。
  // 只使用消息 ID 去重，避免把用户连续发送的相同绘图指令误判为重复。
  const isDuplicateCommand = (session: Session): boolean => {
    const messageId = session.messageId
    if (!messageId) return false

    const now = Date.now()
    for (const [key, timestamp] of recentCommandMessages) {
      if (now - timestamp > commandDedupWindow) recentCommandMessages.delete(key)
    }

    const key = [session.platform, session.selfId, session.channelId, session.userId, messageId].join(':')
    if (recentCommandMessages.has(key)) {
      ctx.logger.warn(`检测到重复绘图消息，已忽略：messageId=${messageId}`)
      return true
    }

    recentCommandMessages.set(key, now)
    return false
  }

  // nai4-5 / nai4-5c 别名只认 ASCII 连字符（-），但用户可能输入其他 Unicode 横杠
  // （如 U+2011 ‑、U+2013 –、U+FF0D － 等）。这里在命令解析前把指令首词中的横杠归一化，
  // 使这些变体也能命中别名，同时保持原有的指令触发语义（群聊无前缀/@ 依然不会触发）。
  ctx.before('attach', (session) => {
    session.stripped.content = session.stripped.content.replace(
      /^(\S*?nai4)[\u2010-\u2015\u2212\uFE63\uFF0D](5c?)(?=\s|$)/i,
      '$1-$2',
    )
  })

  const cmd = ctx.command('novelai [prompts...]')
    .alias('nai')
    .alias('imagine')
    .alias('nai4', { options: { model: 'nai-v4-full' } })
    .alias('nai4c', { options: { model: 'nai-v4-curated-preview'} })
    .alias('nai4-5c', { options: { model: 'nai-v4-5-curated'} })
    .alias('nai4-5', { options: { model: 'nai-v4-5-full' } })
    .alias('nai5c', { options: { model: 'nai-v5-curated'} })
    .alias('nai5', { options: { model: 'nai-v5-full' } })
    .userFields(['authority'])
    .shortcut('imagine', { i18n: true, fuzzy: true })
    .shortcut('enhance', { i18n: true, fuzzy: true, options: { enhance: true } })
    .option('enhance', '-e', { hidden: some(thirdParty, noImage) })
    .option('model', '-m <model>', { type: models, hidden: thirdParty })
    .option('resolution', '-r <resolution>', { type: resolution })
    .option('output', '-o', { type: ['minimal', 'default', 'verbose'] })
    .option('override', '-O')
    .option('sampler', '-s <sampler>')
    .option('seed', '-x <seed:number>')
    .option('steps', '-t <step>', { type: step })
    .option('scale', '-c <scale:number>')
    .option('rescale', '-R <rescale:number>')
    .option('noise', '-n <noise:number>', { hidden: thirdParty })
    .option('strength', '-N <strength:number>')
    .option('skipCfgAboveSigma', '-v <skipCfgAboveSigma:number>')
    .option('hiresFix', '-H', { hidden: () => config.type !== 'sd-webui' })
    .option('hiresFixSteps', '<step>', { type: step, hidden: () => config.type !== 'sd-webui' })
    .option('smea', '-S', { hidden: () => config.model !== 'nai-v3' })
    .option('smeaDyn', '-d', { hidden: () => config.model !== 'nai-v3' })
    .option('scheduler', '-C <scheduler:string>', {
      hidden: () => config.type === 'naifu',
      type: ['token', 'login'].includes(config.type)
        ? scheduler.nai
        : config.type === 'sd-webui'
          ? scheduler.sd
          : config.type === 'stable-horde'
            ? scheduler.horde
            : [],
    })
    .option('decrisper', '-D', { hidden: thirdParty })
    .option('undesired', '-u <undesired:text>')
    .option('noTranslator', '-T', { hidden: () => !ctx.translator || !config.translator })
    .option('iterations', '-i <iterations:posint>', { fallback: 1, hidden: () => config.maxIterations <= 1 })
    .option('batch', '-b <batch:option>', { fallback: 1, hidden: () => config.maxIterations <= 1 })
    .option('chars', '-K <chars>')
    .option('inpaint', '-M', { hidden: thirdParty })
    .option('preciseRef', '-P', { hidden: thirdParty })  // 精准参考
    .option('preciseRefParams', '-p <params:string>')  // 精准参考参数

    .action(async ({ session, options, name }, ...prompts) => {
      if (isDuplicateCommand(session)) return

      // 将 prompts 数组转换为字符串
      let input = prompts.join(' ')

      // 从元素树提取图片 URL（官方推荐方式，attrs.src 已反转义），
      // 供 generateImage / inpaint 等后续流程使用，并随 options 保存供重画复用
      const imageUrls = h.select(session.elements ?? [], 'img').map(el => el.attrs.src)
      if (imageUrls.length) {
        ; (options as any)._imageUrls = imageUrls
      }

      // 处理可能被错误包含在 undesired 中的其他选项
      if (options.undesired) {
        const { cleanedUndesired, extractedOptions } = extractOptionsFromUndesired(options.undesired)
        options.undesired = cleanedUndesired

        // 将提取的选项合并到 options 中
        Object.assign(options, extractedOptions)

        // 调试日志
        if (config.debugLog) {
          ctx.logger.info(`[Undesired Debug] 原始 undesired: ${options.undesired}`)
          ctx.logger.info(`[Undesired Debug] 清理后 undesired: ${cleanedUndesired}`)
          ctx.logger.info(`[Undesired Debug] 提取的选项: ${JSON.stringify(extractedOptions)}`)
        }
      }

      // 调试日志（受配置控制）
      if (config.debugLog) {
        ctx.logger.info(`[Characters Debug] 接收到的 prompts 数组: ${JSON.stringify(prompts)}`)
        ctx.logger.info(`[Characters Debug] 接收到的 input: ${input}`)
        ctx.logger.info(`[Characters Debug] 接收到的 options: ${JSON.stringify(options)}`)
      }

      // 如果没有提供prompt参数，直接返回帮助信息
      if (!input?.trim()) {
        return session.execute('help novelai')
      }

      // 检查会员状态和使用次数限制
      if (config.membershipEnabled) {
        const userId = session.userId
        const canUse = membershipSystem.canUseDrawing(userId, session)

        if (typeof canUse === 'string') {
          return canUse // 返回错误消息
        }

        const canUseNai5 = membershipSystem.canUseNai5(userId, session, options.model || config.model)
        if (typeof canUseNai5 === 'string') {
          return canUseNai5
        }
      }

      const now = Date.now()
      const userId = session.userId

      // ========== 局部重绘交互流程（在进入队列之前完成） ==========
      // ========== 局部重绘交互流程（在进入队列之前完成） ==========
      const inpaintResult = await runInpaintInteraction(runtime, session, options, input)
      if (inpaintResult.error) return inpaintResult.error
      input = inpaintResult.input
      // ========== 局部重绘交互流程结束 ==========
      // ========== 局部重绘交互流程结束 ==========

      // ========== 精准参考交互流程（在进入队列之前完成） ==========
      // ========== 精准参考交互流程（在进入队列之前完成） ==========
      const preciseRefError = await runPreciseRefInteraction(runtime, session, options)
      if (preciseRefError) return preciseRefError
      // ========== 精准参考交互流程结束 ==========
      // ========== 精准参考交互流程结束 ==========

      // 检查用户是否可以添加任务
      const canAddResult = queueSystem.canAddTask(userId)
      if (!canAddResult.canAdd) {
        const [msgKey, ...params] = canAddResult.message.split(':')
        return session.text(`commands.novelai.messages.${msgKey}`, params.map(p => parseInt(p) || p))
      }

      // ========== 提取目标尺寸计算（用于尺寸限制检查和点数计算） ==========
      let resWidth = 832, resHeight = 1216

      // 局部重绘时优先使用实际的对齐后尺寸（这才是真正发给 API 的尺寸）
      if (options.inpaint && (options as any)._alignedWidth && (options as any)._alignedHeight) {
        resWidth = (options as any)._alignedWidth
        resHeight = (options as any)._alignedHeight
      } else if (options.resolution) {
        resWidth = options.resolution.width || 832
        resHeight = options.resolution.height || 1216
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

      // ========== NovelAI 最大像素限制检查（进入队列前统一拦截） ==========
      if (['login', 'token'].includes(config.type)) {
        const maxPixels = session.resolve(config.maxPixels) ?? 3211264
        const naiClamped = clampToNAILimit(resWidth, resHeight, maxPixels)
        if (naiClamped.clamped) {
          return session.text('commands.novelai.messages.size-exceeded', [resWidth, resHeight, naiClamped.recommendedWidth, naiClamped.recommendedHeight])
        }
      }

      // ========== 点数计算与预扣 ==========
      let pointsCost = 0
      let nai5Overage = false
      if (config.pointsEnabled && config.membershipEnabled) {
        // 确定是否图生图（用于步数与计费判断）
        // 优先从 session.elements（适配器解析好的元素树，不触发字符串解析）判断，
        // 同时兼容文本中手写的 <img> 标记，避免 `>_<` 导致 h.parse 误判
        const imgUrl_check = h.select(session.elements ?? [], 'img').length > 0
          || /<img\b[^>]*?>/i.test(input || '')
          || options.inpaint

        // 确定精准参考图片数量
        const preciseRefCount = (options as any)?._preciseRefImages?.length || 0
        const drawCount = getTaskDrawCount(options)
        const isImg2Img = !!options.inpaint || imgUrl_check

        // nai5 日限内走 Opus 免费档；超出后按 Anlas 估算扣点（标准分辨率也会扣）
        const cost = calculateTaskPointsCost(
          runtime, session, options, resWidth, resHeight, isImg2Img, preciseRefCount,
          userId, options.model || config.model, drawCount,
        )
        pointsCost = cost.total
        nai5Overage = membershipSystem.shouldChargeNai5Overage(userId, options.model || config.model, drawCount)
        if (membershipSystem.isNai5Model(options.model || config.model) && membershipSystem.getNai5DailyLimit(userId) > 0) {
          membershipSystem.reserveNai5Usage(userId, drawCount)
          ; (options as any)._reservedNai5 = drawCount
        }

        if (pointsCost > 0) {
          const result = await membershipSystem.deductPoints(userId, pointsCost)
          if (result === -1) {
            membershipSystem.releaseNai5Usage(userId, (options as any)._reservedNai5 || 0)
            delete (options as any)._reservedNai5
            const currentPoints = membershipSystem.getPoints(userId)
            return session.text('commands.novelai.messages.points-insufficient', [currentPoints, pointsCost])
          }
          // 存储已扣除的点数到 options，以便失败时退还
          ; (options as any)._deductedPoints = pointsCost
        }
      }

      // 先增加用户任务计数，再显示队列信息
      queueSystem.incrementUserTask(userId, 1)

      // 修改队列信息显示逻辑，显示添加任务后的数量
      const { totalWaiting, userQueue } = queueSystem.getQueueStatus(userId)
      const totalWithCurrent = totalWaiting + 1  // +1 表示包含当前即将添加的任务

      const showQueue = (totalWithCurrent > 0 || userQueue > 0) && config.showQueueInfo
      if (showQueue || pointsCost > 0 || nai5Overage) {
        if (showQueue) {
          ctx.logger.debug(`队列信息 - 总队列: ${totalWithCurrent}, 用户队列: ${userQueue}`)
        }

        const queueMsg = showQueue
          ? session.text('commands.novelai.messages.queue-position', [totalWithCurrent, userQueue])
          : ''
        const pointsInfo = (pointsCost > 0)
          ? session.text('commands.novelai.messages.points-deducted', [pointsCost])
          : ''
        const overageInfo = nai5Overage
          ? session.text(membershipSystem.isNai5BucketEnabled()
            ? 'commands.novelai.messages.nai5-bucket-exhausted'
            : 'commands.novelai.messages.nai5-overage-charged')
          : ''
        const charged = queueMsg ? queueMsg + pointsInfo : pointsInfo.replace(/^[,，、]\s*/, '')
        const notice = [charged, overageInfo].filter(Boolean).join('\n').trim()
        if (notice) await session.send(notice)

        // 在发送队列信息后立即更新lastDrawTime，而不是等到图片生成完成
        if (config.membershipEnabled) {
          membershipSystem.updateLastDrawTime(userId, now)
        }
      }

      // 保存用户最后一次任务
      queueSystem.saveLastTask(userId, session, options, input, pointsCost)

      // 添加任务到队列并处理
      return queueSystem.addTask({
        session,
        options,
        input,
        isRedraw: false,
        resolve: () => { },  // 这些会被 addTask 方法重写
        reject: () => { }
      })
    })

  ctx.accept(['model', 'sampler'], (config) => {
    const getSamplers = () => {
      switch (config.type) {
        case 'sd-webui':
          return sampler.sd
        case 'stable-horde':
          return sampler.horde
        default:
          return { ...sampler.nai, ...sampler.nai3, ...sampler.nai4 }
      }
    }

    cmd._options.model.fallback = config.model
    cmd._options.sampler.fallback = config.sampler
    cmd._options.sampler.type = Object.keys(getSamplers())
  }, { immediate: true })

  const subcmd = ctx
    .intersect(useBackend('sd-webui'))
    .intersect(useFilter(config.features.upscale))
    .command('novelai.upscale')
    .shortcut('upscale', { i18n: true, fuzzy: true })
    .option('scale', '-s <scale:number>', { fallback: 2 })
    .option('resolution', '-r <resolution>', { type: resolution })
    .option('crop', '-C, --no-crop', { value: false, fallback: true })
    .option('upscaler', '-1 <upscaler>', { type: upscalers })
    .option('upscaler2', '-2 <upscaler2>', { type: upscalers })
    .option('visibility', '-v <visibility:number>')
    .option('upscaleFirst', '-f', { fallback: false })
    .action(async ({ session, options }, input) => {
      let imgUrl: string
      // 官方方式：从元素树取图（attrs.src 已反转义）；文本中手写的 <img> 标记作兜底
      const [imageElement] = h.select(session.elements ?? [], 'img')
      imgUrl = imageElement?.attrs.src
      if (!imgUrl) imgUrl = extractImages(input || '').urls[0]

      if (!imgUrl) return session.text('commands.novelai.messages.expect-image')
      let image: ImageData
      try {
        image = await download(ctx, imgUrl)
      } catch (err) {
        if (err instanceof NetworkError) {
          return session.text(err.message, err.params)
        }
        ctx.logger.error(err)
        return session.text('commands.novelai.messages.download-error')
      }

      const payload: StableDiffusionWebUI.ExtraSingleImageRequest = {
        image: image.dataUrl,
        resize_mode: options.resolution ? 1 : 0,
        show_extras_results: true,
        upscaling_resize: options.scale,
        upscaling_resize_h: options.resolution?.height,
        upscaling_resize_w: options.resolution?.width,
        upscaling_crop: options.crop,
        upscaler_1: options.upscaler,
        upscaler_2: options.upscaler2 ?? 'None',
        extras_upscaler_2_visibility: options.visibility ?? 1,
        upscale_first: options.upscaleFirst,
      }

      try {
        const { data } = await ctx.http<StableDiffusionWebUI.ExtraSingleImageResponse>(trimSlash(config.endpoint) + '/sdapi/v1/extra-single-image', {
          method: 'POST',
          timeout: config.requestTimeout,
          headers: {
            ...config.headers,
          },
          data: payload,
        })
        return h.image(forceDataPrefix(data.image))
      } catch (e) {
        ctx.logger.warn(e)
        return session.text('commands.novelai.messages.unknown-error')
      }
    })

  ctx.accept(['upscaler'], (config) => {
    subcmd._options.upscaler.fallback = config.upscaler
  }, { immediate: true })
}
