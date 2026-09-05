// 图像生成核心流程：构建请求、调用后端 API、审核与发送结果
import { Dict, h, omit, Quester, Session, SessionError, trimSlash } from 'koishi'
import { modelMap, orientMap, parseInput, sampler } from '../config'
import { ImageData, NovelAI, StableDiffusionWebUI } from '../types'
import { download, extractImages, getImageSize, forceDataPrefix, NetworkError, project, convertPosition, modelSupportsCharacters, parseCharacters, darkenImage, extractMaskWithAntiArtifact, modelSupportsCharacterReference, processCharacterReferenceImage } from '../utils'
import AdmZip from 'adm-zip'
import { resolve } from 'path'
import { readFile } from 'fs/promises'
import { auditImage, AuditResult } from '../imageAudit'
import { handleError, Runtime } from '../runtime'
import { fetchSubscription, isNovelAIV5Model, isOpusQuotaExhausted } from './opusQuota'

export async function generateImage(runtime: Runtime, session: Session<'authority'>, options: any, input: string) {
  try {
    return await generateImageInner(runtime, session, options, input)
  } finally {
    const leftover = (options as any)?._reservedNai5 || 0
    if (leftover > 0) {
      runtime.membershipSystem.releaseNai5Usage(session.userId, leftover)
      ; (options as any)._reservedNai5 = 0
    }
  }
}

async function generateImageInner(runtime: Runtime, session: Session<'authority'>, options: any, input: string) {
    // 添加调试日志，检查session对象
    if (runtime.config.debugLog) runtime.ctx.logger.info(`generateImage开始处理，sessionId=${session.id}，userId=${session.userId}`)

    // 简化重画调度：不再基于策略延迟或切换索引，队列系统会分配 _forcedTokenIndex

    // 检查session是否包含runtime对象，这对于后续getToken调用很重要
    if ('runtime' in session) {
      if (runtime.config.debugLog) runtime.ctx.logger.info(`session包含runtime对象: ${JSON.stringify(session.runtime)}`)
    } else {
      if (runtime.config.debugLog) runtime.ctx.logger.info('session不包含runtime对象，将使用ctx默认runtime')
    }

    if (runtime.config.defaultPromptSw) {
      if (session.user.authority < session.resolve(runtime.config.authLvDefault)) {
        return session.text('internal.low-authority')
      }
      if (session.user.authority < session.resolve(runtime.config.authLv)) {
        input = ''
        options = options.resolution ? { resolution: options.resolution } : {}
      }
    } else if (
      !runtime.config.defaultPromptSw
      && session.user.authority < session.resolve(runtime.config.authLv)
    ) return session.text('internal.low-auth')

    const haveInput = !!input?.trim()
    if (!haveInput && !runtime.config.defaultPromptSw) return session.execute('help novelai')



    const { batch = 1, iterations = 1 } = options
    const total = batch * iterations
    if (total > runtime.config.maxIterations) {
      return session.text('commands.novelai.messages.exceed-max-iteration', [runtime.config.maxIterations])
    }

    const allowText = runtime.useFilter(runtime.config.features.text)(session)
    const allowImage = runtime.useFilter(runtime.config.features.image)(session)

    let imgUrl: string, image: ImageData
    if (haveInput) {
      // 文本清理：移除 img 元素标记，保留纯文本 prompt
      const extracted = extractImages(input)
      input = extracted.input

      // 图片 URL 优先级：
      // 1. action 阶段从 session.elements 提取的 URL（官方方式，直接指令场景，attrs.src 已反转义）
      // 2. 字符串兜底（重画等复用旧 input 的场景）
      const urls = options._imageUrls?.length ? options._imageUrls : extracted.urls
      if (urls.length) {
        if (!allowImage) throw new SessionError('commands.novelai.messages.invalid-content')
        if (urls.length > 1) throw new SessionError('commands.novelai.messages.too-many-images')
        imgUrl = urls[0]
      }

      if (options.enhance && !imgUrl) {
        return session.text('commands.novelai.messages.expect-image')
      }

      // 局部重绘模式：使用 options._originalUrl（在命令 action 中已保存）
      if (options.inpaint) {
        if (options._originalUrl) {
          imgUrl = options._originalUrl
        } else if (!imgUrl) {
          return session.text('commands.novelai.messages.expect-image')
        }
      }

      if (!input.trim() && !runtime.config.basePrompt) {
        return session.text('commands.novelai.messages.expect-prompt')
      }
    }

    if (!allowText && !imgUrl) {
      return session.text('commands.novelai.messages.expect-image')
    }

    if (haveInput && runtime.config.translator && runtime.ctx.translator && !options.noTranslator) {
      try {
        input = await runtime.ctx.translator.translate({ input, target: 'en' })
      } catch (err) {
        runtime.ctx.logger.warn(err)
      }
    }

    const [errPath, prompt, uc] = parseInput(session, input, runtime.config, options.override, options.undesired)
    if (errPath) return session.text(errPath)

    let token: string
    try {
      // 传入session对象以便获取token时使用其runtime
      if (runtime.config.debugLog) runtime.ctx.logger.info('准备调用getToken获取token')
      token = await runtime.getToken(session)
      if (runtime.config.debugLog) runtime.ctx.logger.info('成功获取token')
    } catch (err) {
      runtime.ctx.logger.error(`获取token失败: ${err.message}`, err)
      if (err instanceof NetworkError) {
        return session.text(err.message, err.params)
      }
      runtime.ctx.logger.error(err)
      return session.text('commands.novelai.messages.unknown-error')
    }

    const model = modelMap[options.model]

    // Opus 免费额度耗尽时默认保护 Anlas，不允许 V5 请求继续提交。
    // 开启 opusQuotaAllowAnlas 后跳过此保护，由 NovelAI 按实际规则扣除 Anlas。
    if (['token', 'login'].includes(runtime.config.type) &&
      isNovelAIV5Model(model) &&
      !runtime.config.opusQuotaAllowAnlas) {
      const rejectV5ByQuota = async (message: string) => {
        // novelai 命令会在入队前预扣插件点数；额度熔断属于入队后的检查，必须退款。
        const deductedPoints = (options as any)?._deductedPoints || 0
        if (deductedPoints > 0 && runtime.config.pointsEnabled) {
          await runtime.membershipSystem.refundPoints(session.userId, deductedPoints)
          ; (options as any)._deductedPoints = 0
        }
        return session.text(message)
      }

      try {
        const subscription = await fetchSubscription(runtime.ctx, runtime.config, token)
        if (subscription.tier === 3) {
          if (!subscription.active || !subscription.usage || typeof subscription.usage.percent !== 'number') {
            runtime.ctx.logger.warn('无法确认 Opus 免费额度，已阻止 V5 生图以保护 Anlas')
            return rejectV5ByQuota('commands.novelai.messages.opus-quota-check-failed')
          }
          if (isOpusQuotaExhausted(subscription)) {
            return rejectV5ByQuota('commands.novelai.messages.opus-quota-exhausted')
          }
        }
      } catch (err) {
        runtime.ctx.logger.warn(`查询 Opus 免费额度失败，已阻止 V5 生图: ${err?.message || err}`)
        return rejectV5ByQuota('commands.novelai.messages.opus-quota-check-failed')
      }
    }

    const seed = options.seed || Math.floor(Math.random() * Math.pow(2, 32))

    const parameters: Dict = {
      seed,
      prompt,
      n_samples: options.batch,
      uc,
      ucPreset: 2,
      qualityToggle: false,
      scale: options.scale ?? session.resolve(runtime.config.scale),
      rescale: options.rescale ?? session.resolve(runtime.config.rescale),
      steps: options.steps ?? session.resolve(imgUrl ? runtime.config.imageSteps : runtime.config.textSteps),
    }

    if (imgUrl) {
      try {
        image = await download(runtime.ctx, imgUrl)
      } catch (err) {
        if (err instanceof NetworkError) {
          return session.text(err.message, err.params)
        }
        runtime.ctx.logger.error(err)
        return session.text('commands.novelai.messages.download-error')
      }

      // 局部重绘的"重画"逻辑：如果有 URL 但没有 Base64，说明是重画任务，需要重新计算
      if (options.inpaint && !options._maskBase64 && options._maskUrl) {
        try {
          if (runtime.config.debugLog) runtime.ctx.logger.info('[Inpaint] 检测到重画任务，正在重新下载并处理遮罩...')

          // 确定 -r 指定的目标尺寸（如果有的话）
          let targetWidth: number | undefined
          let targetHeight: number | undefined
          if (options.resolution) {
            targetWidth = options.resolution.width
            targetHeight = options.resolution.height
          }

          // 1. 重新处理原图，获取对齐后的尺寸（传入可选的目标尺寸）
          const darkenResult = await darkenImage(image, 0.5, targetWidth, targetHeight) as any

          // 2. 下载遮罩图
          let maskImageData
          try {
            maskImageData = await download(runtime.ctx, options._maskUrl)
          } catch (err) {
            runtime.ctx.logger.error(`[Inpaint] 遮罩图片下载失败: ${err}`)
            return session.text('commands.novelai.messages.inpaint-url-expired')
          }

          // 3. 重新提取遮罩
          const maskBase64 = await extractMaskWithAntiArtifact(
            maskImageData,
            darkenResult.alignedWidth,
            darkenResult.alignedHeight
          )

          // 4. 恢复 options 中的参数，供后续逻辑使用
          options._maskBase64 = maskBase64
          options._originalBase64 = darkenResult.originalBuffer.toString('base64')
          options._alignedWidth = darkenResult.alignedWidth
          options._alignedHeight = darkenResult.alignedHeight

          if (runtime.config.debugLog) runtime.ctx.logger.info(`[Inpaint] 重画数据重建完成，尺寸: ${darkenResult.alignedWidth}x${darkenResult.alignedHeight}${darkenResult.sizeClamped ? '（已自动缩小）' : ''}`)

        } catch (err) {
          runtime.ctx.logger.error(`[Inpaint] 重画数据恢复失败: ${err}`)
          return session.text('commands.novelai.messages.inpaint-url-expired')
        }
      }

      // 局部重绘模式：mask 数据已在进入队列之前准备好（在命令 action 中完成交互）
      // 这里只需确认数据已就绪
      if (options.inpaint && options._maskBase64) {
        if (runtime.config.debugLog) {
          runtime.ctx.logger.info(`[Inpaint] 使用已准备的 mask 数据，尺寸: ${options._alignedWidth}x${options._alignedHeight}，mask大小: ${options._maskBase64.length} 字节`)
        }
      }

      if (options.enhance) {
        const size = getImageSize(image.buffer)
        if (size.width + size.height !== 1280) {
          return session.text('commands.novelai.messages.invalid-size')
        }
        Object.assign(parameters, {
          height: size.height * 1.5,
          width: size.width * 1.5,
          noise: options.noise ?? 0,
          strength: options.strength ?? 0.2,
        })
      } else {
        if (!options.resolution) {
          const resolution = session.resolve(runtime.config.resolution)
          options.resolution = typeof resolution === 'string' ? orientMap[resolution] : resolution
        }
        Object.assign(parameters, {
          height: options.resolution.height,
          width: options.resolution.width,
          noise: options.noise ?? session.resolve(runtime.config.noise),
          strength: options.strength ?? session.resolve(runtime.config.strength),
        })
      }
    } else {
      if (!options.resolution) {
        const resolution = session.resolve(runtime.config.resolution)
          options.resolution = typeof resolution === 'string' ? orientMap[resolution] : resolution
      }
      Object.assign(parameters, {
        height: options.resolution.height,
        width: options.resolution.width,
      })
    }


    if (options.hiresFix || runtime.config.hiresFix) {
      parameters.strength ??= session.resolve(runtime.config.strength)
    }

    const getRandomId = () => Math.random().toString(36).slice(2)
    const container = Array(iterations).fill(0).map(getRandomId)
    if (runtime.config.maxConcurrency) {
      const store = runtime.tasks[session.cid] ||= new Set()
      if (store.size >= runtime.config.maxConcurrency) {
        return session.text('commands.novelai.messages.concurrent-jobs')
      } else {
        container.forEach((id) => store.add(id))
      }
    }

    container.forEach((id) => runtime.globalTasks.add(id))
    const cleanUp = (id: string) => {
      runtime.tasks[session.cid]?.delete(id)
      runtime.globalTasks.delete(id)
    }

    const path = (() => {
      switch (runtime.config.type) {
        case 'sd-webui':
          return image ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img'
        case 'stable-horde':
          return '/api/v2/generate/async'
        case 'naifu':
          return '/generate-stream'
        case 'comfyui':
          return '/prompt'
        default:
          return '/ai/generate-image'
      }
    })()

    const getPayload = async () => {
      switch (runtime.config.type) {
        case 'login':
        case 'token':
        case 'naifu': {

          const createPrompt = (base, isNegative = false) => ({
            caption: { base_caption: base, char_captions: [] },
            ...(!isNegative && { use_coords: false, use_order: true })
          })

          // 设置基础参数
          const isNAI5 = model === 'nai-diffusion-5-curated' || model === 'nai-diffusion-5-full'
          parameters.params_version = isNAI5 ? 4 : 3 // V5 使用新版参数协议
          parameters.sampler = sampler.sd2nai(options.sampler, model)

          // 处理反向提示词
          if (parameters.uc) {
            parameters.negative_prompt = parameters.uc
            delete parameters.uc
          }

          // 设置通用参数
          parameters.dynamic_thresholding = options.decrisper ?? runtime.config.decrisper
          parameters.qualityToggle = true
          parameters.ucPreset = 0
          parameters.add_original_image = false
          parameters.legacy = false
          parameters.cfg_rescale = options.rescale ?? session.resolve(runtime.config.rescale)
          if (options.skipCfgAboveSigma !== undefined) {
            parameters.skip_cfg_above_sigma = options.skipCfgAboveSigma
          }


          const isNAI3 = model === 'nai-diffusion-3'
          const isNAI4 = model === 'nai-diffusion-4-curated-preview' || model === 'nai-diffusion-4-full' || model === 'nai-diffusion-4-5-curated' || model === 'nai-diffusion-4-5-full' || isNAI5

          if (isNAI3) {
            parameters.legacy_v3_extend = true
            parameters.noise_schedule = options.scheduler ?? runtime.config.scheduler
            parameters.sm_dyn = options.smeaDyn ?? runtime.config.smeaDyn
            parameters.sm = (options.smea ?? runtime.config.smea) || parameters.sm_dyn
            parameters.controlnet_strength = 1 // 为NAI-v3添加controlnet_strength参数
            if (parameters.sampler === 'ddim_v3') {
              parameters.sm = false
              parameters.sm_dyn = false
              delete parameters.noise_schedule
            }
          } else if (isNAI4) {
            parameters.add_original_image = false // unknown
            parameters.noise_schedule = options.scheduler ?? runtime.config.scheduler
            parameters.characterPrompts = [] satisfies NovelAI.V4CharacterPrompt[]
            parameters.controlnet_strength = 1 // unknown
            parameters.deliberate_euler_ancestral_bug = false // unknown
            parameters.prefer_brownian = true // unknown
            parameters.reference_image_multiple = [] // unknown
            parameters.reference_information_extracted_multiple = [] // unknown
            parameters.reference_strength_multiple = [] // unknown
            parameters.skip_cfg_above_sigma = options.skipCfgAboveSigma ?? null // unknown
            parameters.use_coords = false // unknown
            parameters.v4_prompt = {
              caption: {
                base_caption: prompt,
                char_captions: [],
              },
              use_coords: parameters.use_coords,
              use_order: true,
            } satisfies NovelAI.V4PromptPositive
            parameters.v4_negative_prompt = {
              caption: {
                base_caption: parameters.negative_prompt,
                char_captions: [],
              },
            } satisfies NovelAI.V4Prompt

            // 处理 Characters 功能
            if (runtime.config.debugLog) {
              runtime.ctx.logger.info(`[Characters Debug] options.chars = ${options.chars}`)
              runtime.ctx.logger.info(`[Characters Debug] model = ${model}`)
              runtime.ctx.logger.info(`[Characters Debug] modelSupportsCharacters = ${modelSupportsCharacters(model)}`)
            }

            if (options.chars && modelSupportsCharacters(model)) {
              try {
                if (runtime.config.debugLog) {
                  runtime.ctx.logger.info(`[Characters Debug] 开始解析 characters 参数: ${options.chars}`)
                }

                // 使用新的解析函数，支持文本格式和 JSON 格式
                const characters: NovelAI.Character[] = parseCharacters(options.chars)

                if (runtime.config.debugLog) {
                  runtime.ctx.logger.info(`[Characters Debug] 解析成功，characters 数组长度: ${characters.length}`)
                  runtime.ctx.logger.info(`[Characters Debug] 解析结果: ${JSON.stringify(characters)}`)
                }

                if (Array.isArray(characters) && characters.length > 0) {
                  // 检查是否至少有一个角色显式指定了坐标
                  const hasCoords = characters.some(char => char.position !== undefined)

                  // 根据是否有坐标输入来设置 use_coords
                  parameters.use_coords = hasCoords
                  parameters.v4_prompt.use_coords = hasCoords

                  if (runtime.config.debugLog) {
                    runtime.ctx.logger.info(`[Characters Debug] 处理前 - base_caption: ${parameters.v4_prompt.caption.base_caption}`)
                    runtime.ctx.logger.info(`[Characters Debug] 处理前 - char_captions 长度: ${parameters.v4_prompt.caption.char_captions.length}`)
                    runtime.ctx.logger.info(`[Characters Debug] 检测到坐标输入: ${hasCoords}，use_coords 设置为: ${hasCoords}`)
                  }

                  // 处理每个角色
                  for (const character of characters) {
                    if (!character.prompt) continue

                    const position = character.position || 'C3'
                    const uc = character.uc || ''

                    if (runtime.config.debugLog) {
                      runtime.ctx.logger.info(`[Characters Debug] 处理角色: prompt="${character.prompt}", position="${position}", uc="${uc}"`)
                    }

                    // 转换位置坐标
                    const pos = convertPosition(position)

                    if (runtime.config.debugLog) {
                      runtime.ctx.logger.info(`[Characters Debug] 转换后坐标: x=${pos.x}, y=${pos.y}`)
                    }

                    // 添加到 characterPrompts
                    parameters.characterPrompts.push({
                      center: pos,
                      prompt: character.prompt,
                      uc: uc,
                    })

                    // 添加到 v4_prompt.char_captions
                    parameters.v4_prompt.caption.char_captions.push({
                      centers: [pos],
                      char_caption: character.prompt,
                    })

                    // 添加到 v4_negative_prompt.char_captions
                    parameters.v4_negative_prompt.caption.char_captions.push({
                      centers: [pos],
                      char_caption: uc,
                    })
                  }

                  if (runtime.config.debugLog) {
                    runtime.ctx.logger.info(`[Characters Debug] 处理后 - char_captions 长度: ${parameters.v4_prompt.caption.char_captions.length}`)
                    runtime.ctx.logger.info(`[Characters Debug] 处理后 - characterPrompts 长度: ${parameters.characterPrompts.length}`)
                    runtime.ctx.logger.info(`[Characters Debug] 已添加 ${characters.length} 个角色到请求中`)
                  }
                }
              } catch (err) {
                // 报错日志保留
                runtime.ctx.logger.warn(`[Characters] 解析 characters 参数失败: ${err.message}`)
                if (runtime.config.debugLog) {
                  runtime.ctx.logger.warn(`[Characters Debug] 错误堆栈: ${err.stack}`)
                }
              }
            }

            // 处理精准参考功能 (Precise Reference)
            // 仅支持 v4.5 模型
            if (options._preciseRefImages && Array.isArray(options._preciseRefImages) && modelSupportsCharacterReference(model)) {
              for (const imgData of options._preciseRefImages) {
                if (!imgData.base64 && imgData.url) {
                  try {
                    if (runtime.config.debugLog) runtime.ctx.logger.info('[PreciseRef] 检测到重画任务，正在重新下载并处理精准参考图片...')
                    const refImage = await download(runtime.ctx, imgData.url)
                    const processedRef = await processCharacterReferenceImage(refImage)
                    imgData.base64 = processedRef.base64
                    if (runtime.config.debugLog) runtime.ctx.logger.info('[PreciseRef] 重画图片数据重建完成')
                  } catch (err) {
                    runtime.ctx.logger.warn(`[PreciseRef] 重画时重新下载精确参考图片失败: ${err}`)
                  }
                }
              }

              // 过滤掉下载失败或没有base64的图片
              const validImages = options._preciseRefImages.filter(img => img.base64)

              if (validImages.length > 0) {
                // 解析 parameters "-p cs,1,0.8;c,0.9,1"
                // 兼容中英文标点符号以及多余的引号
                const paramStr = (options._preciseRefParams || "cs,1,1")
                  .replace(/“|”|"|'/g, '') // 去除由命令行传入时可能带有的双引号/单引号
                  .replace(/；/g, ';')     // 替换中文分号
                  .replace(/，/g, ',')     // 替换中文逗号
                const paramGroups = paramStr.split(';').map(s => s.trim()).filter(Boolean)

                const modes: string[] = []
                const strengths: number[] = []
                const fidelities: number[] = []

                for (let i = 0; i < validImages.length; i++) {
                  let p = "cs,1,1" // 默认值
                  if (i < paramGroups.length) {
                    p = paramGroups[i]
                  }

                  const parts = p.split(',').map(s => s.trim())
                  const modeRaw = parts[0] || 'cs'
                  const strengthRaw = parseFloat(parts[1])
                  const fidelityRaw = parseFloat(parts[2])

                  let mode = 'character&style'
                  if (modeRaw === 'c' || modeRaw === 'character') mode = 'character'
                  else if (modeRaw === 's' || modeRaw === 'style') mode = 'style'

                  const strength = isNaN(strengthRaw) ? 1 : strengthRaw
                  const fidelity = isNaN(fidelityRaw) ? 1 : fidelityRaw

                  modes.push(mode)
                  strengths.push(strength)
                  fidelities.push(1 - fidelity) // 沿用 1 - 保真度
                }

                // 设置 director_reference 相关参数
                parameters.director_reference_images = validImages.map(img => img.base64)
                parameters.director_reference_descriptions = modes.map(mode => ({
                  caption: {
                    base_caption: mode,
                    char_captions: [],
                  },
                  legacy_uc: false,
                }))
                parameters.director_reference_information_extracted = validImages.map(() => 1) // 默认信息提取1
                parameters.director_reference_strength_values = strengths
                parameters.director_reference_secondary_strength_values = fidelities

                if (runtime.config.debugLog) {
                  runtime.ctx.logger.info(`[PreciseRef] 已添加参数: modes=${modes}, strengths=${strengths}, fidelities=${fidelities}`)
                }

                // clear base64 from options to save memory
                options._preciseRefImages.forEach(img => {
                  delete img.base64
                })
              }
            }
          }

          // 构建最终payload
          let action = 'generate'
          let inpaintModel = model

          // 处理图片上传，参考nai-plugin-main的实现
          if (image) {
            // 检查是否为局部重绘模式
            if (options.inpaint && options._maskBase64) {
              action = 'infill'
              // 将模型名改为inpainting版本
              // NAI 的 V4 模型 inpainting 后缀是固定的
              if (model === 'nai-diffusion-4-curated-preview') {
                inpaintModel = 'nai-diffusion-4-curated-inpainting'
              } else if (!model.endsWith('-inpainting')) {
                inpaintModel = `${model}-inpainting`
              } else {
                inpaintModel = model
              }

              // 使用对齐后的原图（由darkenImage生成）
              parameters.image = options._originalBase64

              // 使用对齐后的尺寸
              parameters.width = options._alignedWidth
              parameters.height = options._alignedHeight

              if (runtime.config.debugLog) {
                runtime.ctx.logger.info(`[Inpaint] 使用局部重绘模式: action=${action}, model=${inpaintModel}, size=${options._alignedWidth}x${options._alignedHeight}`)
              }
            } else {
              action = 'img2img'
              // 普通img2img使用原图
              if (image.base64.includes('base64,')) {
                const base64Data = image.base64.split('base64,')[1]
                parameters.image = base64Data
              } else {
                parameters.image = image.base64
              }
            }

            // 添加必要的img2img参数
            parameters.strength = options.strength ?? session.resolve(runtime.config.strength)
            parameters.noise = options.noise ?? session.resolve(runtime.config.noise)

            // 公共的img2img参数
            parameters.add_original_image = false // 不需要在结果中添加原始图像
            parameters.extra_noise_seed = parameters.seed // 使用相同的种子作为额外噪声种子

            // 局部重绘特有参数
            if (options.inpaint && options._maskBase64) {
              parameters.mask = options._maskBase64
              parameters.color_correct = false // 默认关闭颜色校正

              if (runtime.config.debugLog) {
                runtime.ctx.logger.info(`[Inpaint] 添加遮罩参数，mask大小: ${parameters.mask.length} 字节`)
              }

              // 数据已复制到 parameters，主动释放 options 上的大体积 base64
              delete options._maskBase64
              delete options._originalBase64
            }
          }

          const payload = { model: inpaintModel, input: prompt, action, parameters: omit(parameters, ['prompt']) }

          // 添加 Characters 相关的详细日志（受配置控制）
          if (runtime.config.debugLog && parameters.v4_prompt) {
            runtime.ctx.logger.info(`[Characters Debug] 最终 payload - v4_prompt.caption.base_caption: ${parameters.v4_prompt.caption.base_caption}`)
            runtime.ctx.logger.info(`[Characters Debug] 最终 payload - v4_prompt.caption.char_captions: ${JSON.stringify(parameters.v4_prompt.caption.char_captions)}`)
            runtime.ctx.logger.info(`[Characters Debug] 最终 payload - v4_prompt.use_coords: ${parameters.v4_prompt.use_coords}`)
            runtime.ctx.logger.info(`[Characters Debug] 最终 payload - characterPrompts: ${JSON.stringify(parameters.characterPrompts)}`)
          }

          if (runtime.config.debugLog) {
            runtime.ctx.logger.info(`NovelAI请求参数: ${JSON.stringify(payload, (key, value) => {
              // 避免记录过长的base64字符串
              if (key === 'image' && typeof value === 'string') {
                return `[base64 string length: ${value.length}]`
              }
              return value
            })}`)
          }
          return payload
        }
        case 'sd-webui': {
          return {
            sampler_index: sampler.sd[options.sampler],
            scheduler: options.scheduler,
            init_images: image && [image.dataUrl],
            restore_faces: runtime.config.restoreFaces ?? false,
            enable_hr: options.hiresFix ?? runtime.config.hiresFix ?? false,
            hr_second_pass_steps: options.hiresFixSteps ?? 0,
            hr_upscaler: runtime.config.hiresFixUpscaler ?? 'None',
            ...project(parameters, {
              prompt: 'prompt',
              batch_size: 'n_samples',
              seed: 'seed',
              negative_prompt: 'uc',
              cfg_scale: 'scale',
              cfg_rescale: 'rescale',
              steps: 'steps',
              width: 'width',
              height: 'height',
              denoising_strength: 'strength',
            }),
          }
        }
        case 'stable-horde': {
          const nsfw = session.resolve(runtime.config.nsfw)
          return {
            prompt: parameters.prompt,
            params: {
              sampler_name: options.sampler,
              cfg_scale: parameters.scale,
              denoising_strength: parameters.strength,
              seed: parameters.seed.toString(),
              height: parameters.height,
              width: parameters.width,
              post_processing: [],
              karras: options.scheduler?.toLowerCase() === 'karras',
              hires_fix: options.hiresFix ?? runtime.config.hiresFix ?? false,
              steps: parameters.steps,
              n: parameters.n_samples,
            },
            nsfw: nsfw !== 'disallow',
            trusted_workers: runtime.config.trustedWorkers,
            censor_nsfw: nsfw === 'censor',
            models: [options.model],
            source_image: image?.base64,
            source_processing: image ? 'img2img' : undefined,
            r2: true,
          }
        }
        case 'comfyui': {
          const workflowText2Image = runtime.config.workflowText2Image
            ? resolve(runtime.ctx.baseDir, runtime.config.workflowText2Image)
            : resolve(__dirname, '../data/default-comfyui-t2i-wf.json')
          const workflowImage2Image = runtime.config.workflowImage2Image
            ? resolve(runtime.ctx.baseDir, runtime.config.workflowImage2Image)
            : resolve(__dirname, '../data/default-comfyui-i2i-wf.json')
          const workflow = image ? workflowImage2Image : workflowText2Image
          if (runtime.config.debugLog) runtime.ctx.logger.info('workflow:', workflow)
          const prompt = JSON.parse(await readFile(workflow, 'utf8'))

          if (image) {
            const body = new FormData()
            const capture = /^data:([\w/.+-]+);base64,(.*)$/.exec(image.dataUrl)
            const [, mime] = capture

            let name = Date.now().toString()
            const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : ''
            if (ext) name += `.${ext}`
            const imageFile = new Blob([image.buffer], { type: mime })
            body.append('image', imageFile, name)
            const res = await runtime.ctx.http(trimSlash(runtime.config.endpoint) + '/upload/image', {
              method: 'POST',
              headers: {
                ...runtime.config.headers,
              },
              data: body,
            })
            if (res.status === 200) {
              const data = res.data
              let imagePath = data.name
              if (data.subfolder) imagePath = data.subfolder + '/' + imagePath

              for (const nodeId in prompt) {
                if (prompt[nodeId].class_type === 'LoadImage') {
                  prompt[nodeId].inputs.image = imagePath
                  break
                }
              }
            } else {
              throw new SessionError('commands.novelai.messages.unknown-error')
            }
          }

          for (const nodeId in prompt) {
            if (prompt[nodeId].class_type === 'KSampler') {
              prompt[nodeId].inputs.seed = parameters.seed
              prompt[nodeId].inputs.steps = parameters.steps
              prompt[nodeId].inputs.cfg = parameters.scale
              prompt[nodeId].inputs.sampler_name = options.sampler
              prompt[nodeId].inputs.denoise = options.strength ?? session.resolve(runtime.config.strength)
              prompt[nodeId].inputs.scheduler = options.scheduler ?? runtime.config.scheduler
              const positiveNodeId = prompt[nodeId].inputs.positive[0]
              const negativeeNodeId = prompt[nodeId].inputs.negative[0]
              const latentImageNodeId = prompt[nodeId].inputs.latent_image[0]
              prompt[positiveNodeId].inputs.text = parameters.prompt
              prompt[negativeeNodeId].inputs.text = parameters.uc
              prompt[latentImageNodeId].inputs.width = parameters.width
              prompt[latentImageNodeId].inputs.height = parameters.height
              prompt[latentImageNodeId].inputs.batch_size = parameters.n_samples
              break
            }
          }
          for (const nodeId in prompt) {
            if (prompt[nodeId].class_type === 'CheckpointLoaderSimple') {
              prompt[nodeId].inputs.ckpt_name = options.model ?? runtime.config.model
              break
            }
          }
          if (runtime.config.debugLog) runtime.ctx.logger.info('prompt:', prompt)
          return { prompt }
        }
      }
    }

    const getHeaders = () => {
      switch (runtime.config.type) {
        case 'login':
        case 'token':
        case 'naifu':
          return { Authorization: `Bearer ${token}` }
        case 'stable-horde':
          return { apikey: token }
      }
    }

    let finalPrompt = prompt
    const iterate = async () => {
      const request = async () => {
        const res = await runtime.ctx.http(trimSlash(runtime.config.endpoint) + path, {
          method: 'POST',
          timeout: runtime.config.requestTimeout,
          responseType: runtime.config.type === 'naifu' ? 'text' : ['login', 'token'].includes(runtime.config.type) ? 'arraybuffer' : 'json',
          headers: {
            ...runtime.config.headers,
            ...getHeaders(),
          },
          data: await getPayload(),
        })

        if (runtime.config.type === 'sd-webui') {
          const data = res.data as StableDiffusionWebUI.Response
          if (data?.info?.prompt) {
            finalPrompt = data.info.prompt
          } else {
            try {
              finalPrompt = (JSON.parse(data.info)).prompt
            } catch (err) {
              runtime.ctx.logger.warn(err)
            }
          }
          return forceDataPrefix(data.images[0])
        }
        if (runtime.config.type === 'stable-horde') {
          const uuid = res.data.id

          const check = () => runtime.ctx.http.get(trimSlash(runtime.config.endpoint) + '/api/v2/generate/check/' + uuid).then((res) => res.done)
          const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
          while (await check() === false) {
            await sleep(runtime.config.pollInterval)
          }
          const result = await runtime.ctx.http.get(trimSlash(runtime.config.endpoint) + '/api/v2/generate/status/' + uuid)
          const imgUrl = result.generations[0].img
          if (!imgUrl.startsWith('http')) {
            return forceDataPrefix(result.generations[0].img, 'image/webp')
          }
          const imgRes = await runtime.ctx.http(imgUrl, { responseType: 'arraybuffer' })
          const b64 = Buffer.from(imgRes.data).toString('base64')
          return forceDataPrefix(b64, imgRes.headers.get('content-type'))
        }
        if (runtime.config.type === 'comfyui') {
          const promptId = res.data.prompt_id
          const check = () => runtime.ctx.http.get(trimSlash(runtime.config.endpoint) + '/history/' + promptId)
            .then((res) => res[promptId] && res[promptId].outputs)
          const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
          let outputs
          while (!(outputs = await check())) {
            await sleep(runtime.config.pollInterval)
          }
          const imagesOutput: { data: ArrayBuffer; mime: string }[] = []
          for (const nodeId in outputs) {
            const nodeOutput = outputs[nodeId]
            if ('images' in nodeOutput) {
              for (const image of nodeOutput['images']) {
                const urlValues = new URLSearchParams({ filename: image['filename'], subfolder: image['subfolder'], type: image['type'] }).toString()
                const imgRes = await runtime.ctx.http(trimSlash(runtime.config.endpoint) + '/view?' + urlValues)
                imagesOutput.push({ data: imgRes.data, mime: imgRes.headers.get('content-type') })
                break
              }
            }
          }
          return forceDataPrefix(Buffer.from(imagesOutput[0].data).toString('base64'), imagesOutput[0].mime)
        }
        if (res.headers.get('content-type') === 'application/x-zip-compressed' || res.headers.get('content-disposition')?.includes('.zip')) {
          const buffer = Buffer.from(res.data, 'binary')
          const zip = new AdmZip(buffer)

          const zipEntries = zip.getEntries()
          const firstImageBuffer = zip.readFile(zipEntries[0])
          const b64 = firstImageBuffer.toString('base64')
          return forceDataPrefix(b64, 'image/png')
        }
        return forceDataPrefix(res.data?.trimEnd().slice(27))
      }

      let dataUrl: string, count = 0
      while (true) {
        try {
          dataUrl = await request()
          break
        } catch (err) {
          if (Quester.Error.is(err)) {
            if (err.code && ++count < runtime.config.maxRetryCount) {
              continue
            }
          }
          // 生成失败，退还点数（nai5 预占由外层 finally 释放）
          const deductedPoints = (options as any)?._deductedPoints || 0
          if (deductedPoints > 0 && runtime.config.pointsEnabled) {
            await runtime.membershipSystem.refundPoints(session.userId, deductedPoints)
              ; (options as any)._deductedPoints = 0 // 避免重复退还
            const refundMsg = session.text('commands.novelai.messages.points-refunded', [deductedPoints])
            return await session.send(handleError(runtime.ctx, session, err) + refundMsg)
          }
          return await session.send(handleError(runtime.ctx, session, err))
        }
      }

      if (!dataUrl.trim()) return await session.send(session.text('commands.novelai.messages.empty-response'))

      // 图片审核
      // 审核范围：总开关 → 私聊开关/群聊过滤 → 排除群列表。
      // excludedGroups 优先级高于 enabledGroups；空 enabledGroups 表示所有未排除的群。
      const enabledGroups = runtime.config.enabledGroups || []
      const excludedGroups = runtime.config.excludedGroups || []
      const shouldReview = Boolean(
        runtime.config.imageReviewEnabled &&
        (session.guildId
          ? !excludedGroups.includes(session.guildId) &&
            (!enabledGroups.length || enabledGroups.includes(session.guildId))
          : runtime.config.reviewPrivate === true)
      )

      if (shouldReview) {
        try {
          if (runtime.config.debugLog) {
            runtime.ctx.logger.info('[图片审核] 开始图片审核...')
          }
          const auditResult: AuditResult = await auditImage(runtime.ctx, dataUrl, runtime.config)

          if (!auditResult.pass) {
            // 审核未通过的警告日志保留
            runtime.ctx.logger.warn(`[图片审核] 审核未通过: ${auditResult.message}, 分数: ${auditResult.score}`)

            // 审核不通过也扣减使用次数
            if (runtime.config.membershipEnabled) {
              const nai5Count = options.batch || 1
              runtime.membershipSystem.incrementUsage(session.userId, 1, options.model || runtime.config.model, nai5Count)
              if ((options as any)._reservedNai5) {
                ; (options as any)._reservedNai5 = Math.max(0, (options as any)._reservedNai5 - nai5Count)
              }
            }

            // 如果启用了禁言功能，则禁言用户
            if (runtime.config.muteOnReviewFailed && session.guildId && session.userId) {
              try {
                // 将秒转换为毫秒，Koishi的muteGuildMember API通常需要毫秒单位
                const muteTimeMs = runtime.config.muteTime * 1000
                if (runtime.config.debugLog) runtime.ctx.logger.info(`禁言用户 ${session.username || session.userId} ${runtime.config.muteTime}秒 (${muteTimeMs}毫秒)`)

                try {
                  await session.bot.muteGuildMember(session.guildId, session.userId, muteTimeMs)
                  if (runtime.config.debugLog) runtime.ctx.logger.info('禁言成功')
                } catch (err) {
                  runtime.ctx.logger.error(`禁言失败: ${err}`)
                }
                return await session.send(h('at', { id: session.userId }) + ' ' + session.text('commands.novelai.messages.image-review-failed-muted', [runtime.config.muteTime]))
              } catch (muteError) {
                runtime.ctx.logger.error(`禁言用户失败: ${muteError}, 平台: ${session.platform}, 错误类型: ${muteError?.constructor?.name}`)
              }
            }

            return await session.send(session.text('commands.novelai.messages.image-review-failed'))
          }

          if (runtime.config.debugLog) {
            runtime.ctx.logger.info(`[图片审核] 审核通过: ${auditResult.message}, 分数: ${auditResult.score}`)
          }
        } catch (error) {
          // 错误日志保留
          runtime.ctx.logger.error(`[图片审核] 审核出错: ${error}`)
          // 如果配置为审核失败时阻止，则不发送图片
          if (runtime.config.imageReviewFailAction === 'block') {
            return await session.send(session.text('commands.novelai.messages.image-review-error'))
          }
          // 否则继续发送图片
        }
      }

      function getContent() {
        const output = session.resolve(options.output ?? runtime.config.output)
        const attrs = {
          userId: session.userId,
          nickname: session.author?.nickname || session.username,
        }
        const sessionRuntime = (session as any)?.runtime || {}
        const idx = typeof sessionRuntime._forcedTokenIndex === 'number' ? sessionRuntime._forcedTokenIndex : null
        const prefix = idx != null && runtime.config.showTokenSuccessPrefix ? `token[${idx}] 成功 ` : ''
        if (output === 'minimal') return h('message', attrs, [prefix, h.image(dataUrl)])
        const result = h('figure')
        const lines = [`seed = ${parameters.seed}`]
        if (output === 'verbose') {
          if (!runtime.thirdParty()) {
            lines.push(`model = ${model}`)
          }
          lines.push(
            `sampler = ${options.sampler}`,
            `steps = ${parameters.steps}`,
            `scale = ${parameters.scale}`,
          )
          if (parameters.image) {
            lines.push(
              `strength = ${parameters.strength}`,
              `noise = ${parameters.noise}`,
            )
          }
        }
        result.children.push(h('message', attrs, lines.join('\n')))
        result.children.push(h('message', attrs, `prompt = ${h.escape(finalPrompt)}`))
        if (output === 'verbose') {
          result.children.push(h('message', attrs, `undesired = ${h.escape(uc)}`))
        }
        result.children.push(h('message', attrs, [prefix, h.image(dataUrl)]))
        return result
      }

      runtime.ctx.logger.debug(`${session.uid}: ${finalPrompt}`)
      const messageIds = await session.send(getContent())

      // 图片发送成功后，增加使用次数
      if (runtime.config.membershipEnabled) {
        const nai5Count = options.batch || 1
        runtime.membershipSystem.incrementUsage(session.userId, 1, options.model || runtime.config.model, nai5Count)
        if ((options as any)._reservedNai5) {
          ; (options as any)._reservedNai5 = Math.max(0, (options as any)._reservedNai5 - nai5Count)
        }
      }

      if (messageIds.length && runtime.config.recallTimeout) {
        runtime.ctx.setTimeout(() => {
          for (const id of messageIds) {
            session.bot.deleteMessage(session.channelId, id)
          }
        }, runtime.config.recallTimeout)
      }
    }

    while (container.length) {
      try {
        await iterate()
        cleanUp(container.pop())
        parameters.seed++
      } catch (err) {
        container.forEach(cleanUp)
        // 生成过程中出错，退还点数（nai5 预占由外层 finally 释放）
        const deductedPoints = (options as any)?._deductedPoints || 0
        if (deductedPoints > 0 && runtime.config.pointsEnabled) {
          await runtime.membershipSystem.refundPoints(session.userId, deductedPoints)
            ; (options as any)._deductedPoints = 0
        }
        throw err
      }
    }
  }
