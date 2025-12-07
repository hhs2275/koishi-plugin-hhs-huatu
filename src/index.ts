import { Computed, Context, Dict, h, Logger, omit, Quester, Session, SessionError, trimSlash } from 'koishi'
import { Config, modelMap, models, orientMap, parseInput, sampler, upscalers, scheduler } from './config'
import { ImageData, NovelAI, StableDiffusionWebUI, UserData, DirectorTools } from './types'
import { closestMultiple, download, forceDataPrefix, getImageSize, login, NetworkError, project, resizeInput, Size, createContextWithRuntime, convertPosition, modelSupportsCharacters, parseCharacters, darkenImage, extractMaskWithAntiArtifact } from './utils'
import { } from '@koishijs/translator'
import { } from '@koishijs/plugin-help'
import AdmZip from 'adm-zip'
import { resolve } from 'path'
import { readFile } from 'fs/promises'
import { auditImage, AuditResult } from './imageAudit'
import { QueueSystem } from './queueSystem'
import { MembershipSystem } from './membershipSystem'

// Director Tools 表情映射表
const EMOTION_MAP: Record<string, DirectorTools.Emotion> = {
  '平静': 'neutral',
  '开心': 'happy',
  '伤心': 'sad',
  '生气': 'angry',
  '害怕': 'scared',
  '吃惊': 'surprised',
  '疲惫': 'tired',
  '兴奋': 'excited',
  '紧张': 'nervous',
  '思考': 'thinking',
  '困惑': 'confused',
  '害羞': 'shy',
  '厌恶': 'disgusted',
  '得意': 'smug',
  '无聊': 'bored',
  '大笑': 'laughing',
  '恼怒': 'irritated',
  '激情': 'aroused',
  '尴尬': 'embarrassed',
  '担心': 'worried',
  '爱意': 'love',
  '坚定': 'determined',
  '受伤': 'hurt',
  '调皮': 'playful',
}

// 反向映射（英文到中文）
const EMOTION_REVERSE_MAP: Record<DirectorTools.Emotion, string> = Object.fromEntries(
  Object.entries(EMOTION_MAP).map(([cn, en]) => [en, cn])
) as Record<DirectorTools.Emotion, string>
export const usage = `
# 🎨 hhs-huatu 插件

> **基于 [novelai-bot](https://bot.novelai.dev/) 的增强版 AI 绘图插件，提供更智能、便捷的 NovelAI 体验。**

[![](https://img.shields.io/badge/QQ群-112879548-blue)](https://qm.qq.com/q/4nKKvckKbu) [![](https://img.shields.io/badge/GitHub-仓库地址-black)](https://github.com/hhs2275/koishi-plugin-hhs-huatu)

### ✨ 核心亮点

本插件针对 **NovelAI V4 & V4.5** 模型进行了深度适配，预设快捷指令，助你快速切换模型：

| 指令 | 对应模型 (Model) | 说明 |
| :--- | :--- | :--- |
| \`nai4\` | \`nai-diffusion-4-full\` | V4 全量模型 |
| \`nai4c\` | \`nai-diffusion-4-curated\` | V4 精选模型 |
| \`nai4-5\` | \`nai-diffusion-4-5-full\` | V4.5 全量模型 |
| \`nai4-5c\` | \`nai-diffusion-4-5-curated\` | V4.5 精选模型 |

### 🛠️ 功能列表

**🎨 绘图核心**
* **全面支持**：文生图、图生图基础功能完整。
* **局部重绘 (Inpaint)**：支持对图片特定区域进行重绘。
* **导演工具**：novelai官网的导演工具功能。
* **V4 角色提示词**：novelai官网的多角色提示词系统。

**⚙️ 系统与管理**
* **高并发优化**：内置队列系统与 Token 池轮询，多账号负载均衡。
* **会员管理**：支持用户分级管理（数据存为 JSON，方便备份/迁移）。
* **智能审核**：集成腾讯 AI 或 API4AI，自动过滤违规内容。

### 🗓️ 开发计划
- [ ] **点数控制系统**：精细化控制用户点数消耗（配置项完善中）。
- [ ] **氛围传输功能**：实现novelai官网的氛围传输功能。
- [ ] **角色参考功能**：实现novelai官网的角色参考功能。

---

### 📖 更多资源
* 详细教程请移步 [GitHub 仓库](https://github.com/hhs2275/koishi-plugin-hhs-huatu)
* 遇到问题？欢迎加入交流群：[112879548](https://qm.qq.com/q/4nKKvckKbu) (联系群主反馈问题/提交建议/愉快玩耍)
`
export * from './config'

export const reactive = true
export const name = 'hhs-huatu'

function handleError({ logger }: Context, session: Session, err: Error) {
  const runtime = (session as any)?.runtime || {}
  const idx = typeof runtime._forcedTokenIndex === 'number' ? runtime._forcedTokenIndex : null
  const prefix = idx != null ? `token[${idx}] ` : ''
  if (Quester.Error.is(err)) {
    if (err.response?.status === 402) {
      return prefix + session.text('commands.novelai.messages.unauthorized')
    } else if (err.response?.status) {
      return prefix + session.text('commands.novelai.messages.response-error', [err.response.status])
    } else if (err.code === 'ETIMEDOUT') {
      return prefix + session.text('commands.novelai.messages.request-timeout')
    } else if (err.code) {
      return prefix + session.text('commands.novelai.messages.request-failed', [err.code])
    }
  }
  logger.error(err)
  return prefix + '发生未知错误'
}

export const inject = {
  required: ['http'],
  optional: ['translator'],
}

// 从 undesired 参数中提取被错误包含的选项
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
    { pattern: /-H\s*/g, key: 'hiresFix', value: true },
    { pattern: /-S\s*/g, key: 'smea', value: true },
    { pattern: /-d\s*/g, key: 'smeaDyn', value: true },
    { pattern: /-C\s+(\w+)/g, key: 'scheduler' },
    { pattern: /-D\s*/g, key: 'decrisper', value: true },
    { pattern: /-T\s*/g, key: 'noTranslator', value: true },
    { pattern: /-i\s+(\d+)/g, key: 'iterations' },
    { pattern: /-b\s+(\d+)/g, key: 'batch' },
    { pattern: /-I\s*/g, key: 'ignoreSpace', value: true },
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

export function apply(ctx: Context, config: Config) {
  // 创建会员系统和队列系统实例
  const membershipSystem = new MembershipSystem(ctx, config)

  // 获取用户数据的引用（用于后续访问）
  const userData = membershipSystem.userData

  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))
  ctx.i18n.define('zh-TW', require('./locales/zh-TW'))
  ctx.i18n.define('en-US', require('./locales/en-US'))
  ctx.i18n.define('fr-FR', require('./locales/fr-FR'))
  ctx.i18n.define('ja-JP', require('./locales/ja-JP'))

  const tasks: Dict<Set<string>> = Object.create(null)
  const globalTasks = new Set<string>()

  // 稍后会在 generateImage 函数定义后创建队列系统实例
  let queueSystem: QueueSystem

  // Token使用状态同步函数
  const syncTokenUsage = () => {
    if (ctx.runtime && Array.isArray(ctx.config.token)) {
      // 初始化tokenUsage
      if (!ctx.runtime.tokenUsage) {
        ctx.runtime.tokenUsage = {}
        for (let i = 0; i < ctx.config.token.length; i++) {
          ctx.runtime.tokenUsage[i] = false
        }
      }
    }
  }

  // 获取 token（仅尊重队列分配的 _forcedTokenIndex）
  let tokenTask: Promise<string> = null
  const getToken = async (session?: Session) => {
    if (config.debugLog) ctx.logger.info(`getToken called, config type: ${ctx.config.type}`)
    const runtime = (session as any)?.runtime || ctx.runtime || {}
    const forcedIndex = runtime._forcedTokenIndex
    const context = createContextWithRuntime(ctx, { _forcedTokenIndex: forcedIndex })
    if (config.debugLog) ctx.logger.info(`getToken: 使用 _forcedTokenIndex=${forcedIndex}`)
    return login(context, ctx.config.email, ctx.config.password)
  }

  // 当配置变更时重置token任务
  ctx.accept(['token', 'type', 'email', 'password'], () => {
    tokenTask = null
    // 不再维护 currentTokenIndex（使用 token 池并依赖 _forcedTokenIndex）
  })

  type HiddenCallback = (session: Session<'authority'>) => boolean

  const useFilter = (filter: Computed<boolean>): HiddenCallback => (session) => {
    return session.resolve(filter) ?? true
  }

  const useBackend = (...types: Config['type'][]): HiddenCallback => () => {
    return types.includes(config.type)
  }

  const thirdParty = () => !['login', 'token'].includes(config.type)



  const noImage: HiddenCallback = (session) => {
    return !useFilter(config.features.image)(session)
  }

  const some = (...args: HiddenCallback[]): HiddenCallback => (session) => {
    return args.some(callback => callback(session))
  }

  const step = (source: string, session: Session) => {
    const value = +source
    if (value * 0 === 0 && Math.floor(value) === value && value > 0 && value <= session.resolve(config.maxSteps || Infinity)) return value
    throw new Error()
  }

  const resolution = (source: string, session: Session<'authority'>): Size => {
    if (source in orientMap) return orientMap[source]
    const cap = source.match(/^(\d+)[x×X*](\d+)$/i)
    if (!cap) throw new Error()
    const width = closestMultiple(+cap[1])
    const height = closestMultiple(+cap[2])
    if (Math.max(width, height) > session.resolve(config.maxResolution || Infinity)) {
      throw new SessionError('commands.novelai.messages.invalid-resolution')
    }
    return { width, height, custom: true }
  }

  // 队列系统将在 generateImage 函数定义后初始化

  // 初始化token使用状态
  syncTokenUsage()

  async function generateImage(session: Session<'authority'>, options: any, input: string) {
    // 添加调试日志，检查session对象
    if (config.debugLog) ctx.logger.info(`generateImage开始处理，sessionId=${session.id}，userId=${session.userId}`)

    // 简化重画调度：不再基于策略延迟或切换索引，队列系统会分配 _forcedTokenIndex

    // 检查session是否包含runtime对象，这对于后续getToken调用很重要
    if ('runtime' in session) {
      if (config.debugLog) ctx.logger.info(`session包含runtime对象: ${JSON.stringify(session.runtime)}`)
    } else {
      if (config.debugLog) ctx.logger.info('session不包含runtime对象，将使用ctx默认runtime')
    }

    if (config.defaultPromptSw) {
      if (session.user.authority < session.resolve(config.authLvDefault)) {
        return session.text('internal.low-authority')
      }
      if (session.user.authority < session.resolve(config.authLv)) {
        input = ''
        options = options.resolution ? { resolution: options.resolution } : {}
      }
    } else if (
      !config.defaultPromptSw
      && session.user.authority < session.resolve(config.authLv)
    ) return session.text('internal.low-auth')

    const haveInput = !!input?.trim()
    if (!haveInput && !config.defaultPromptSw) return session.execute('help novelai')



    const { batch = 1, iterations = 1 } = options
    const total = batch * iterations
    if (total > config.maxIterations) {
      return session.text('commands.novelai.messages.exceed-max-iteration', [config.maxIterations])
    }

    const allowText = useFilter(config.features.text)(session)
    const allowImage = useFilter(config.features.image)(session)

    let imgUrl: string, image: ImageData
    if (haveInput) {
      input = h('', h.transform(h.parse(input), {
        img(attrs) {
          if (!allowImage) throw new SessionError('commands.novelai.messages.invalid-content')
          if (imgUrl) throw new SessionError('commands.novelai.messages.too-many-images')
          imgUrl = attrs.src
          return ''
        },
      })).toString(true)

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

      if (!input.trim() && !config.basePrompt) {
        return session.text('commands.novelai.messages.expect-prompt')
      }
    }

    if (!allowText && !imgUrl) {
      return session.text('commands.novelai.messages.expect-image')
    }

    if (haveInput && config.translator && ctx.translator && !options.noTranslator) {
      try {
        input = await ctx.translator.translate({ input, target: 'en' })
      } catch (err) {
        ctx.logger.warn(err)
      }
    }

    const [errPath, prompt, uc] = parseInput(session, input, config, options.override, options.undesired)
    if (errPath) return session.text(errPath)

    let token: string
    try {
      // 传入session对象以便获取token时使用其runtime
      if (config.debugLog) ctx.logger.info('准备调用getToken获取token')
      token = await getToken(session)
      if (config.debugLog) ctx.logger.info('成功获取token')
    } catch (err) {
      ctx.logger.error(`获取token失败: ${err.message}`, err)
      if (err instanceof NetworkError) {
        return session.text(err.message, err.params)
      }
      ctx.logger.error(err)
      return session.text('commands.novelai.messages.unknown-error')
    }

    const model = modelMap[options.model]
    const seed = options.seed || Math.floor(Math.random() * Math.pow(2, 32))

    const parameters: Dict = {
      seed,
      prompt,
      n_samples: options.batch,
      uc,
      ucPreset: 2,
      qualityToggle: false,
      scale: options.scale ?? session.resolve(config.scale),
      rescale: options.rescale ?? session.resolve(config.rescale),
      steps: options.steps ?? session.resolve(imgUrl ? config.imageSteps : config.textSteps),
    }

    if (imgUrl) {
      try {
        image = await download(ctx, imgUrl)
      } catch (err) {
        if (err instanceof NetworkError) {
          return session.text(err.message, err.params)
        }
        ctx.logger.error(err)
        return session.text('commands.novelai.messages.download-error')
      }

      // 局部重绘的"重画"逻辑：如果有 URL 但没有 Base64，说明是重画任务，需要重新计算
      if (options.inpaint && !options._maskBase64 && options._maskUrl) {
        try {
          if (config.debugLog) ctx.logger.info('[Inpaint] 检测到重画任务，正在重新下载并处理遮罩...')

          // 1. 重新处理原图，获取对齐后的尺寸
          const darkenResult = await darkenImage(image, 0.5)

          // 2. 下载遮罩图
          let maskImageData
          try {
            maskImageData = await download(ctx, options._maskUrl)
          } catch (err) {
            ctx.logger.error(`[Inpaint] 遮罩图片下载失败: ${err}`)
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

          if (config.debugLog) ctx.logger.info('[Inpaint] 重画数据重建完成')

        } catch (err) {
          ctx.logger.error(`[Inpaint] 重画数据恢复失败: ${err}`)
          return session.text('commands.novelai.messages.inpaint-url-expired')
        }
      }

      // 局部重绘模式：mask 数据已在进入队列之前准备好（在命令 action 中完成交互）
      // 这里只需确认数据已就绪
      if (options.inpaint && options._maskBase64) {
        if (config.debugLog) {
          ctx.logger.info(`[Inpaint] 使用已准备的 mask 数据，尺寸: ${options._alignedWidth}x${options._alignedHeight}，mask大小: ${options._maskBase64.length} 字节`)
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
        options.resolution ||= resizeInput(getImageSize(image.buffer))
        Object.assign(parameters, {
          height: options.resolution.height,
          width: options.resolution.width,
          noise: options.noise ?? session.resolve(config.noise),
          strength: options.strength ?? session.resolve(config.strength),
        })
      }
    } else {
      if (!options.resolution) {
        const resolution = session.resolve(config.resolution)
        options.resolution = typeof resolution === 'string' ? orientMap[resolution] : resolution
      }
      Object.assign(parameters, {
        height: options.resolution.height,
        width: options.resolution.width,
      })
    }

    if (options.hiresFix || config.hiresFix) {
      parameters.strength ??= session.resolve(config.strength)
    }

    const getRandomId = () => Math.random().toString(36).slice(2)
    const container = Array(iterations).fill(0).map(getRandomId)
    if (config.maxConcurrency) {
      const store = tasks[session.cid] ||= new Set()
      if (store.size >= config.maxConcurrency) {
        return session.text('commands.novelai.messages.concurrent-jobs')
      } else {
        container.forEach((id) => store.add(id))
      }
    }

    container.forEach((id) => globalTasks.add(id))
    const cleanUp = (id: string) => {
      tasks[session.cid]?.delete(id)
      globalTasks.delete(id)
    }

    const path = (() => {
      switch (config.type) {
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
      switch (config.type) {
        case 'login':
        case 'token':
        case 'naifu': {

          const createPrompt = (base, isNegative = false) => ({
            caption: { base_caption: base, char_captions: [] },
            ...(!isNegative && { use_coords: false, use_order: true })
          })

          // 设置基础参数
          parameters.params_version = 3 // 使用最新的参数版本
          parameters.sampler = sampler.sd2nai(options.sampler, model)

          // 处理反向提示词
          if (parameters.uc) {
            parameters.negative_prompt = parameters.uc
            delete parameters.uc
          }

          // 设置通用参数
          parameters.dynamic_thresholding = options.decrisper ?? config.decrisper
          parameters.qualityToggle = true
          parameters.ucPreset = 0
          parameters.add_original_image = false
          parameters.legacy = false
          parameters.cfg_rescale = options.rescale ?? session.resolve(config.rescale)


          const isNAI3 = model === 'nai-diffusion-3'
          const isNAI4 = model === 'nai-diffusion-4-curated-preview' || model === 'nai-diffusion-4-full' || model === 'nai-diffusion-4-5-curated' || model === 'nai-diffusion-4-5-full'

          if (isNAI3) {
            parameters.legacy_v3_extend = true
            parameters.noise_schedule = options.scheduler ?? config.scheduler
            parameters.sm_dyn = options.smeaDyn ?? config.smeaDyn
            parameters.sm = (options.smea ?? config.smea) || parameters.sm_dyn
            parameters.controlnet_strength = 1 // 为NAI-v3添加controlnet_strength参数
            if (parameters.sampler === 'ddim_v3') {
              parameters.sm = false
              parameters.sm_dyn = false
              delete parameters.noise_schedule
            }
          } else if (isNAI4) {
            parameters.add_original_image = false // unknown
            parameters.noise_schedule = options.scheduler ?? config.scheduler
            parameters.characterPrompts = [] satisfies NovelAI.V4CharacterPrompt[]
            parameters.controlnet_strength = 1 // unknown
            parameters.deliberate_euler_ancestral_bug = false // unknown
            parameters.prefer_brownian = true // unknown
            parameters.reference_image_multiple = [] // unknown
            parameters.reference_information_extracted_multiple = [] // unknown
            parameters.reference_strength_multiple = [] // unknown
            parameters.skip_cfg_above_sigma = null // unknown
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
            if (config.debugLog) {
              ctx.logger.info(`[Characters Debug] options.chars = ${options.chars}`)
              ctx.logger.info(`[Characters Debug] model = ${model}`)
              ctx.logger.info(`[Characters Debug] modelSupportsCharacters = ${modelSupportsCharacters(model)}`)
            }

            if (options.chars && modelSupportsCharacters(model)) {
              try {
                if (config.debugLog) {
                  ctx.logger.info(`[Characters Debug] 开始解析 characters 参数: ${options.chars}`)
                }

                // 使用新的解析函数，支持文本格式和 JSON 格式
                const characters: NovelAI.Character[] = parseCharacters(options.chars)

                if (config.debugLog) {
                  ctx.logger.info(`[Characters Debug] 解析成功，characters 数组长度: ${characters.length}`)
                  ctx.logger.info(`[Characters Debug] 解析结果: ${JSON.stringify(characters)}`)
                }

                if (Array.isArray(characters) && characters.length > 0) {
                  // 检查是否至少有一个角色显式指定了坐标
                  const hasCoords = characters.some(char => char.position !== undefined)

                  // 根据是否有坐标输入来设置 use_coords
                  parameters.use_coords = hasCoords
                  parameters.v4_prompt.use_coords = hasCoords

                  if (config.debugLog) {
                    ctx.logger.info(`[Characters Debug] 处理前 - base_caption: ${parameters.v4_prompt.caption.base_caption}`)
                    ctx.logger.info(`[Characters Debug] 处理前 - char_captions 长度: ${parameters.v4_prompt.caption.char_captions.length}`)
                    ctx.logger.info(`[Characters Debug] 检测到坐标输入: ${hasCoords}，use_coords 设置为: ${hasCoords}`)
                  }

                  // 处理每个角色
                  for (const character of characters) {
                    if (!character.prompt) continue

                    const position = character.position || 'C3'
                    const uc = character.uc || ''

                    if (config.debugLog) {
                      ctx.logger.info(`[Characters Debug] 处理角色: prompt="${character.prompt}", position="${position}", uc="${uc}"`)
                    }

                    // 转换位置坐标
                    const pos = convertPosition(position)

                    if (config.debugLog) {
                      ctx.logger.info(`[Characters Debug] 转换后坐标: x=${pos.x}, y=${pos.y}`)
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

                  if (config.debugLog) {
                    ctx.logger.info(`[Characters Debug] 处理后 - char_captions 长度: ${parameters.v4_prompt.caption.char_captions.length}`)
                    ctx.logger.info(`[Characters Debug] 处理后 - characterPrompts 长度: ${parameters.characterPrompts.length}`)
                    ctx.logger.info(`[Characters Debug] 已添加 ${characters.length} 个角色到请求中`)
                  }
                }
              } catch (err) {
                // 报错日志保留
                ctx.logger.warn(`[Characters] 解析 characters 参数失败: ${err.message}`)
                if (config.debugLog) {
                  ctx.logger.warn(`[Characters Debug] 错误堆栈: ${err.stack}`)
                }
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
              if (!model.endsWith('-inpainting')) {
                inpaintModel = `${model}-inpainting`
              } else {
                inpaintModel = model
              }

              // 使用对齐后的原图（由darkenImage生成）
              parameters.image = options._originalBase64

              // 使用对齐后的尺寸
              parameters.width = options._alignedWidth
              parameters.height = options._alignedHeight

              if (config.debugLog) {
                ctx.logger.info(`[Inpaint] 使用局部重绘模式: action=${action}, model=${inpaintModel}, size=${options._alignedWidth}x${options._alignedHeight}`)
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
            parameters.strength = options.strength ?? session.resolve(config.strength)
            parameters.noise = options.noise ?? session.resolve(config.noise)

            // 公共的img2img参数
            parameters.add_original_image = false // 不需要在结果中添加原始图像
            parameters.extra_noise_seed = parameters.seed // 使用相同的种子作为额外噪声种子

            // 局部重绘特有参数
            if (options.inpaint && options._maskBase64) {
              parameters.mask = options._maskBase64
              parameters.color_correct = false // 默认关闭颜色校正

              if (config.debugLog) {
                ctx.logger.info(`[Inpaint] 添加遮罩参数，mask大小: ${parameters.mask.length} 字节`)
              }
            }
          }

          const payload = { model: inpaintModel, input: prompt, action, parameters: omit(parameters, ['prompt']) }

          // 添加 Characters 相关的详细日志（受配置控制）
          if (config.debugLog && parameters.v4_prompt) {
            ctx.logger.info(`[Characters Debug] 最终 payload - v4_prompt.caption.base_caption: ${parameters.v4_prompt.caption.base_caption}`)
            ctx.logger.info(`[Characters Debug] 最终 payload - v4_prompt.caption.char_captions: ${JSON.stringify(parameters.v4_prompt.caption.char_captions)}`)
            ctx.logger.info(`[Characters Debug] 最终 payload - v4_prompt.use_coords: ${parameters.v4_prompt.use_coords}`)
            ctx.logger.info(`[Characters Debug] 最终 payload - characterPrompts: ${JSON.stringify(parameters.characterPrompts)}`)
          }

          if (config.debugLog) {
            ctx.logger.info(`NovelAI请求参数: ${JSON.stringify(payload, (key, value) => {
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
            restore_faces: config.restoreFaces ?? false,
            enable_hr: options.hiresFix ?? config.hiresFix ?? false,
            hr_second_pass_steps: options.hiresFixSteps ?? 0,
            hr_upscaler: config.hiresFixUpscaler ?? 'None',
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
          const nsfw = session.resolve(config.nsfw)
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
              hires_fix: options.hiresFix ?? config.hiresFix ?? false,
              steps: parameters.steps,
              n: parameters.n_samples,
            },
            nsfw: nsfw !== 'disallow',
            trusted_workers: config.trustedWorkers,
            censor_nsfw: nsfw === 'censor',
            models: [options.model],
            source_image: image?.base64,
            source_processing: image ? 'img2img' : undefined,
            r2: true,
          }
        }
        case 'comfyui': {
          const workflowText2Image = config.workflowText2Image
            ? resolve(ctx.baseDir, config.workflowText2Image)
            : resolve(__dirname, '../data/default-comfyui-t2i-wf.json')
          const workflowImage2Image = config.workflowImage2Image
            ? resolve(ctx.baseDir, config.workflowImage2Image)
            : resolve(__dirname, '../data/default-comfyui-i2i-wf.json')
          const workflow = image ? workflowImage2Image : workflowText2Image
          if (config.debugLog) ctx.logger.info('workflow:', workflow)
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
            const res = await ctx.http(trimSlash(config.endpoint) + '/upload/image', {
              method: 'POST',
              headers: {
                ...config.headers,
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
              prompt[nodeId].inputs.denoise = options.strength ?? session.resolve(config.strength)
              prompt[nodeId].inputs.scheduler = options.scheduler ?? config.scheduler
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
              prompt[nodeId].inputs.ckpt_name = options.model ?? config.model
              break
            }
          }
          if (config.debugLog) ctx.logger.info('prompt:', prompt)
          return { prompt }
        }
      }
    }

    const getHeaders = () => {
      switch (config.type) {
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
        const res = await ctx.http(trimSlash(config.endpoint) + path, {
          method: 'POST',
          timeout: config.requestTimeout,
          responseType: config.type === 'naifu' ? 'text' : ['login', 'token'].includes(config.type) ? 'arraybuffer' : 'json',
          headers: {
            ...config.headers,
            ...getHeaders(),
          },
          data: await getPayload(),
        })

        if (config.type === 'sd-webui') {
          const data = res.data as StableDiffusionWebUI.Response
          if (data?.info?.prompt) {
            finalPrompt = data.info.prompt
          } else {
            try {
              finalPrompt = (JSON.parse(data.info)).prompt
            } catch (err) {
              ctx.logger.warn(err)
            }
          }
          return forceDataPrefix(data.images[0])
        }
        if (config.type === 'stable-horde') {
          const uuid = res.data.id

          const check = () => ctx.http.get(trimSlash(config.endpoint) + '/api/v2/generate/check/' + uuid).then((res) => res.done)
          const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
          while (await check() === false) {
            await sleep(config.pollInterval)
          }
          const result = await ctx.http.get(trimSlash(config.endpoint) + '/api/v2/generate/status/' + uuid)
          const imgUrl = result.generations[0].img
          if (!imgUrl.startsWith('http')) {
            return forceDataPrefix(result.generations[0].img, 'image/webp')
          }
          const imgRes = await ctx.http(imgUrl, { responseType: 'arraybuffer' })
          const b64 = Buffer.from(imgRes.data).toString('base64')
          return forceDataPrefix(b64, imgRes.headers.get('content-type'))
        }
        if (config.type === 'comfyui') {
          const promptId = res.data.prompt_id
          const check = () => ctx.http.get(trimSlash(config.endpoint) + '/history/' + promptId)
            .then((res) => res[promptId] && res[promptId].outputs)
          const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
          let outputs
          while (!(outputs = await check())) {
            await sleep(config.pollInterval)
          }
          const imagesOutput: { data: ArrayBuffer; mime: string }[] = []
          for (const nodeId in outputs) {
            const nodeOutput = outputs[nodeId]
            if ('images' in nodeOutput) {
              for (const image of nodeOutput['images']) {
                const urlValues = new URLSearchParams({ filename: image['filename'], subfolder: image['subfolder'], type: image['type'] }).toString()
                const imgRes = await ctx.http(trimSlash(config.endpoint) + '/view?' + urlValues)
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
            if (err.code && err.code !== 'ETIMEDOUT' && ++count < config.maxRetryCount) {
              continue
            }
          }
          return await session.send(handleError(ctx, session, err))
        }
      }

      if (!dataUrl.trim()) return await session.send(session.text('commands.novelai.messages.empty-response'))

      // 图片审核
      // 检查是否启用了审核功能，以及当前群聊是否在启用审核的群列表中
      const shouldReview = config.imageReviewEnabled &&
        session.guildId &&
        (!config.enabledGroups ||
          !config.enabledGroups.length ||
          config.enabledGroups.includes(session.guildId)
        );

      if (shouldReview) {
        try {
          if (config.debugLog) {
            ctx.logger.info('[图片审核] 开始图片审核...')
          }
          const auditResult: AuditResult = await auditImage(ctx, dataUrl, config)

          if (!auditResult.pass) {
            // 审核未通过的警告日志保留
            ctx.logger.warn(`[图片审核] 审核未通过: ${auditResult.message}, 分数: ${auditResult.score}`)

            // 审核不通过也扣减使用次数
            if (config.membershipEnabled) {
              membershipSystem.incrementUsage(session.userId, 1)
            }

            // 如果启用了禁言功能，则禁言用户
            if (config.muteOnReviewFailed && session.guildId && session.userId) {
              try {
                // 将秒转换为毫秒，Koishi的muteGuildMember API通常需要毫秒单位
                const muteTimeMs = config.muteTime * 1000
                if (config.debugLog) ctx.logger.info(`禁言用户 ${session.username || session.userId} ${config.muteTime}秒 (${muteTimeMs}毫秒)`)

                try {
                  await session.bot.muteGuildMember(session.guildId, session.userId, muteTimeMs)
                  if (config.debugLog) ctx.logger.info('禁言成功')
                } catch (err) {
                  ctx.logger.error(`禁言失败: ${err}`)
                }
                return await session.send(h('at', { id: session.userId }) + ' ' + session.text('commands.novelai.messages.image-review-failed-muted', [config.muteTime]))
              } catch (muteError) {
                ctx.logger.error(`禁言用户失败: ${muteError}, 平台: ${session.platform}, 错误类型: ${muteError?.constructor?.name}`)
              }
            }

            return await session.send(session.text('commands.novelai.messages.image-review-failed'))
          }

          if (config.debugLog) {
            ctx.logger.info(`[图片审核] 审核通过: ${auditResult.message}, 分数: ${auditResult.score}`)
          }
        } catch (error) {
          // 错误日志保留
          ctx.logger.error(`[图片审核] 审核出错: ${error}`)
          // 如果配置为审核失败时阻止，则不发送图片
          if (config.imageReviewFailAction === 'block') {
            return await session.send(session.text('commands.novelai.messages.image-review-error'))
          }
          // 否则继续发送图片
        }
      }

      function getContent() {
        const output = session.resolve(options.output ?? config.output)
        const attrs = {
          userId: session.userId,
          nickname: session.author?.nickname || session.username,
        }
        const runtime = (session as any)?.runtime || {}
        const idx = typeof runtime._forcedTokenIndex === 'number' ? runtime._forcedTokenIndex : null
        const prefix = idx != null && config.showTokenSuccessPrefix ? `token[${idx}] 成功 ` : ''
        if (output === 'minimal') return h('message', attrs, [prefix, h.image(dataUrl)])
        const result = h('figure')
        const lines = [`seed = ${parameters.seed}`]
        if (output === 'verbose') {
          if (!thirdParty()) {
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

      ctx.logger.debug(`${session.uid}: ${finalPrompt}`)
      const messageIds = await session.send(getContent())

      // 图片发送成功后，增加使用次数
      if (config.membershipEnabled) {
        membershipSystem.incrementUsage(session.userId, 1)
      }

      if (messageIds.length && config.recallTimeout) {
        ctx.setTimeout(() => {
          for (const id of messageIds) {
            session.bot.deleteMessage(session.channelId, id)
          }
        }, config.recallTimeout)
      }
    }

    while (container.length) {
      try {
        await iterate()
        cleanUp(container.pop())
        parameters.seed++
      } catch (err) {
        container.forEach(cleanUp)
        throw err
      }
    }
  }

  // 在 generateImage 函数定义后创建队列系统实例
  queueSystem = new QueueSystem(ctx, config, generateImage, membershipSystem, ctx.runtime?.tokenUsage)

  const cmd = ctx.command('novelai [prompts...]')
    .alias('nai')
    .alias('imagine')
    .alias('nai4', { options: { model: 'nai-v4-full', sampler: 'k_euler_a', iterations: 1, batch: 1 } })
    .alias('nai4c', { options: { model: 'nai-v4-curated-preview', sampler: 'k_euler_a', iterations: 1, batch: 1 } })
    .alias('nai4-5c', { options: { model: 'nai-v4-5-curated', sampler: 'k_euler_a', iterations: 1, batch: 1 } })
    .alias('nai4-5', { options: { model: 'nai-v4-5-full', sampler: 'k_euler_a', iterations: 1, batch: 1 } })
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
    .option('ignoreSpace', '-I', { hidden: true })
    .action(async ({ session, options, name }, ...prompts) => {
      // 将 prompts 数组转换为字符串
      let input = prompts.join(' ')

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
      }

      const now = Date.now()
      const userId = session.userId

      // ========== 局部重绘交互流程（在进入队列之前完成） ==========
      if (options.inpaint) {
        try {
          // 1. 解析输入中的图片URL
          let imgUrl: string
          h.transform(h.parse(input), {
            img(attrs) {
              imgUrl = attrs.src
              return ''
            },
          })

          // 2. 如果没有图片，提示用户发送并等待
          if (!imgUrl) {
            await session.send(session.text('commands.novelai.messages.inpaint-wait-image'))
            const imageResponse = await session.prompt(60000)

            if (!imageResponse) {
              return session.text('commands.novelai.messages.inpaint-timeout')
            }

            // 解析用户发送的图片
            h.transform(h.parse(imageResponse), {
              img(attrs) {
                imgUrl = attrs.src
                return ''
              },
            })

            if (!imgUrl) {
              return session.text('commands.novelai.messages.inpaint-no-mask')
            }
          }

          // 2. 下载原图
          const image = await download(ctx, imgUrl)

          // 3. 调暗原图并对齐尺寸
          // 利用 JavaScript 闭包特性，darkenResult 在 await session.prompt() 期间会保留在内存中
          const darkenResult = await darkenImage(image, 0.5)

          // 4. 发送调暗后的图片给用户
          await session.send(h('', [
            h.text(session.text('commands.novelai.messages.inpaint-step1')),
            h.image(darkenResult.dataUrl)
          ]))

          // 5. 等待用户发送涂白的图片（在队列外等待，不占用资源）
          // ⚠️ 此时函数暂停执行，darkenResult 被闭包保留
          const maskImgUrl = await session.prompt(120000)
          if (!maskImgUrl) {
            return session.text('commands.novelai.messages.inpaint-timeout')
          }

          // 6. 解析用户发送的图片
          let maskUrl: string
          h.transform(h.parse(maskImgUrl), {
            img(attrs) {
              maskUrl = attrs.src
              return ''
            },
          })

          if (!maskUrl) {
            return session.text('commands.novelai.messages.inpaint-no-mask')
          }

          // 7. 下载用户涂白的图片并使用防伪影算法提取遮罩
          // 直接使用 darkenResult.alignedWidth 和 darkenResult.alignedHeight
          const maskImageData = await download(ctx, maskUrl)
          const maskBase64 = await extractMaskWithAntiArtifact(
            maskImageData,
            darkenResult.alignedWidth,
            darkenResult.alignedHeight
          )

            // 8. 保存 URL 到 options 中（供重画功能使用，避免存储 Base64 占用内存）
            ; (options as any)._originalUrl = imgUrl
            ; (options as any)._maskUrl = maskUrl

            // 9. 保存遮罩和原图到options中（这些会传递给 generateImage）
            ; (options as any)._maskBase64 = maskBase64
            ; (options as any)._originalBase64 = darkenResult.originalBuffer.toString('base64')
            ; (options as any)._alignedWidth = darkenResult.alignedWidth
            ; (options as any)._alignedHeight = darkenResult.alignedHeight

          if (config.debugLog) {
            ctx.logger.info(`[Inpaint] 交互完成，成功提取遮罩，尺寸: ${darkenResult.alignedWidth}x${darkenResult.alignedHeight}，mask大小: ${maskBase64.length} 字节`)
          }
        } catch (err) {
          ctx.logger.error(err)
          if (err instanceof NetworkError) {
            return session.text(err.message, err.params)
          }
          return session.text('commands.novelai.messages.inpaint-error')
        }
      }
      // ========== 局部重绘交互流程结束 ==========

      // 检查用户是否可以添加任务
      const canAddResult = queueSystem.canAddTask(userId)
      if (!canAddResult.canAdd) {
        const [msgKey, ...params] = canAddResult.message.split(':')
        return session.text(`commands.novelai.messages.${msgKey}`, params.map(p => parseInt(p) || p))
      }

      // 先增加用户任务计数，再显示队列信息
      queueSystem.incrementUserTask(userId, 1)

      // 修改队列信息显示逻辑，显示添加任务后的数量
      const { totalWaiting, userQueue } = queueSystem.getQueueStatus(userId)
      const totalWithCurrent = totalWaiting + 1  // +1 表示包含当前即将添加的任务

      if ((totalWithCurrent > 0 || userQueue > 0) && config.showQueueInfo) {
        // 添加调试日志
        ctx.logger.debug(`队列信息 - 总队列: ${totalWithCurrent}, 用户队列: ${userQueue}`)
        const queueMsg = await session.text('commands.novelai.messages.queue-position', [
          totalWithCurrent,
          userQueue
        ])
        await session.send(queueMsg)

        // 在发送队列信息后立即更新lastDrawTime，而不是等到图片生成完成
        if (config.membershipEnabled) {
          membershipSystem.updateLastDrawTime(userId, now)
        }
      }

      // 保存用户最后一次任务
      queueSystem.saveLastTask(userId, session, options, input)

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
          return { ...sampler.nai, ...sampler.nai3 }
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
      h.transform(input, {
        image(attrs) {
          imgUrl = attrs.url
          return ''
        },
      })

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

  ctx.command('重画 [count:text]')
    .userFields(['authority'])
    .option('ignoreSpace', '-I', { hidden: true })
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
          await session.send(queueMsg)

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

            queueSystem.taskQueue.push({
              session: taskSession,  // 使用新创建的session对象
              options: lastTask.options,
              input: lastTask.input,
              isRedraw: true,
              resolve: (value) => {
                queueSystem.userTasks[currentUserId]--
                targetBot.sendMessage(targetChannelId, value)
              },
              reject: (err) => {
                queueSystem.userTasks[currentUserId]--
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
  ctx.command('novelai.reset-queue <user>', '重置用户队列状态')
    .userFields(['authority'])
    .action(({ session }, user) => {
      const targetUserId = user?.replace(/^@|&#\d+;?/g, '')
      if (!targetUserId) return '请输入要重置的用户ID'

      // 权限检查（示例：需要3级权限）
      if (session.user.authority < 3) {
        return '权限不足'
      }

      queueSystem.resetUserQueue(targetUserId)
      return `已重置用户 ${targetUserId} 的队列状态`
    })

  // 会员系统命令
  ctx.command('novelai.member')
    .userFields(['authority'])
    .alias('会员')
    .option('user', '-u <user:string>')
    .option('days', '-d <days:number>')
    .option('cancel', '-c')
    .option('list', '-l 列出所有未过期的会员')
    .option('page', '-p <page:number>', { fallback: 1 })
    .option('size', '-s <size:number>', { fallback: 10 })
    .action(async ({ session, options }) => {
      // 如果会员系统未启用，返回提示
      if (!config.membershipEnabled) {
        return '会员系统未启用'
      }

      const userId = session.userId
      const targetId = options.user || userId

      // 如果查询的不是自己，需要管理员权限
      if (options.user && options.user !== userId) {
        if (session.user.authority < config.membershipAuthLv) {
          return '您没有权限查看其他用户的会员信息'
        }
      }

      // 列出所有未过期的会员
      if (options.list) {
        // 需要管理员权限
        if (session.user.authority < config.membershipAuthLv) {
          return '您没有权限查看所有会员信息'
        }

        const now = Date.now()
        const activeMembers = []

        // 遍历所有用户数据，筛选出未过期的会员
        for (const id in userData) {
          const user = userData[id]
          if (user.isMember && user.membershipExpiry > now) {
            const remainingDays = Math.ceil((user.membershipExpiry - now) / (24 * 60 * 60 * 1000))
            activeMembers.push({ id, remainingDays, expiry: user.membershipExpiry })
          }
        }

        if (activeMembers.length === 0) {
          return '当前没有有效会员'
        }

        // 按剩余天数排序
        activeMembers.sort((a, b) => a.remainingDays - b.remainingDays)

        // 分页处理
        const pageSize = Math.max(1, Math.min(options.size, 20)); // 每页显示数量，限制在1-20之间
        const currentPage = Math.max(1, options.page); // 当前页码，至少为1
        const totalPages = Math.ceil(activeMembers.length / pageSize);

        // 检查页码是否有效
        if (currentPage > totalPages) {
          return `页码超出范围，总共只有 ${totalPages} 页`;
        }

        // 获取当前页的会员
        const startIndex = (currentPage - 1) * pageSize;
        const endIndex = Math.min(startIndex + pageSize, activeMembers.length);
        const membersOnPage = activeMembers.slice(startIndex, endIndex);

        // 格式化输出
        let result = `当前共有 ${activeMembers.length} 个有效会员（第 ${currentPage}/${totalPages} 页）：\n\n`;
        membersOnPage.forEach((member, index) => {
          const expireDate = new Date(member.expiry).toLocaleString();
          const globalIndex = startIndex + index + 1;
          result += `${globalIndex}. 用户ID: ${member.id}\n   剩余天数: ${member.remainingDays} 天\n   到期时间: ${expireDate}\n\n`;
        });

        // 添加分页导航提示
        if (totalPages > 1) {
          result += `\n使用 -p <页码> 参数查看其他页，如: 会员 -l -p 2`;
          if (pageSize !== 10) {
            result += `\n使用 -s <数量> 参数调整每页显示数量，如: 会员 -l -s 15`;
          }
        }

        return result;
      }

      // 设置或取消会员需要管理员权限
      if ((options.days || options.cancel) && session.user.authority < config.membershipAuthLv) {
        return '您没有权限设置会员状态'
      }

      // 检查并重置每日使用次数
      membershipSystem.checkAndResetDailyUsage(targetId)

      // 如果是取消会员
      if (options.cancel) {
        if (!userData[targetId]) {
          return '该用户不存在会员记录'
        }

        userData[targetId].isMember = false
        userData[targetId].membershipExpiry = 0
        userData[targetId].dailyLimit = config.nonMemberDailyLimit

        // 保存用户数据
        await membershipSystem.saveUserData()

        return `已取消用户 ${targetId} 的会员资格`
      }

      // 如果是设置会员
      if (options.days) {
        if (!userData[targetId]) {
          userData[targetId] = {
            isMember: true,
            membershipExpiry: Date.now() + options.days * 24 * 60 * 60 * 1000,
            dailyUsage: 0,
            lastUsed: Date.now(),
            dailyLimit: config.memberDailyLimit || 0
          }
        } else {
          // 如果用户已经是会员且会员未过期，则在原有期限上增加天数
          if (userData[targetId].isMember && userData[targetId].membershipExpiry > Date.now()) {
            userData[targetId].membershipExpiry += options.days * 24 * 60 * 60 * 1000
          } else {
            // 如果用户不是会员或会员已过期，则从当前时间开始计算
            userData[targetId].isMember = true
            userData[targetId].membershipExpiry = Date.now() + options.days * 24 * 60 * 60 * 1000
          }
          userData[targetId].dailyLimit = config.memberDailyLimit || 0
        }

        // 保存用户数据
        await membershipSystem.saveUserData()

        const expireDate = new Date(userData[targetId].membershipExpiry)
        // 根据是增加天数还是新设置会员返回不同的提示
        if (userData[targetId].isMember && userData[targetId].membershipExpiry > Date.now()) {
          return `已为用户 ${targetId} 增加 ${options.days} 天会员，到期时间：${expireDate.toLocaleString()}`
        } else {
          return `已为用户 ${targetId} 设置 ${options.days} 天会员，到期时间：${expireDate.toLocaleString()}`
        }
      }

      // 查询会员状态
      const isQueryingSelf = targetId === userId

      if (!userData[targetId]) {
        if (isQueryingSelf) {
          return session.text('commands.novelai.messages.non-member-usage', [
            config.nonMemberDailyLimit,
            0,
            config.nonMemberDailyLimit
          ])
        } else {
          return `用户 ${targetId} 暂无使用记录\n每日使用上限：${config.nonMemberDailyLimit} 次`
        }
      }

      const user = userData[targetId]

      if (user.isMember) {
        const expireDate = new Date(user.membershipExpiry)
        const remainingDays = Math.ceil((user.membershipExpiry - Date.now()) / (24 * 60 * 60 * 1000))

        let usageInfo = ''
        if (config.memberDailyLimit > 0) {
          const remaining = config.memberDailyLimit - user.dailyUsage
          if (isQueryingSelf) {
            usageInfo = session.text('commands.novelai.messages.membership-active', [
              config.memberDailyLimit,
              remaining
            ])
          } else {
            usageInfo = `用户 ${targetId} 是会员用户\n每日限额：${config.memberDailyLimit} 次，剩余：${remaining} 次`
          }
        } else {
          if (isQueryingSelf) {
            usageInfo = '您当前是会员用户，可无限次使用'
          } else {
            usageInfo = `用户 ${targetId} 是会员用户，可无限次使用`
          }
        }

        return `${usageInfo}\n会员到期时间：${expireDate.toLocaleString()}（剩余${remainingDays}天）`
      } else {
        const remaining = config.nonMemberDailyLimit - user.dailyUsage
        if (isQueryingSelf) {
          return session.text('commands.novelai.messages.non-member-usage', [
            config.nonMemberDailyLimit,
            user.dailyUsage,
            remaining
          ])
        } else {
          return `用户 ${targetId} 是非会员\n每日限额：${config.nonMemberDailyLimit} 次\n已使用：${user.dailyUsage} 次\n剩余：${remaining} 次`
        }
      }
    })

  // 添加查询nai队列指令
  ctx.command('novelai.queue', '查询nai队列状态')
    .alias('查队列', '查询队列', '查nai队列')
    .action(async ({ session }) => {
      const userId = session.userId
      const { totalWaiting, userQueue } = queueSystem.getQueueStatus(userId)

      return session.text('commands.novelai.messages.queue-position', [
        totalWaiting,
        userQueue
      ])
    })

  // 会员系统调试指令（仅在启用时注册）
  if (config.memberDebugCommandEnabled) {
    ctx.command('novelai.member-debug', '会员系统调试指令')
      .userFields(['authority'])
      .alias('会员调试')
      .option('cleanup', '-c 立即执行会员信息清理')
      .option('remind', '-r 立即执行会员到期提醒')
      .option('status', '-s 查看定时任务状态')
      .option('resetUsage', '-u <userId:string> 重置指定用户的使用次数')
      .option('addDaysAll', '-a <days:number> 给所有会员增加天数')
      .action(async ({ session, options }) => {
        // 权限检查
        if (session.user.authority < config.memberDebugCommandAuthLv) {
          return `权限不足，需要权限等级 ${config.memberDebugCommandAuthLv} 或以上`
        }

        // 如果会员系统未启用
        if (!config.membershipEnabled) {
          return '会员系统未启用'
        }

        // 给所有会员增加天数
        if (options.addDaysAll !== undefined) {
          const days = options.addDaysAll
          await session.send(`正在为所有会员增加 ${days} 天会员时长...`)
          const result = await membershipSystem.addDaysToAllMembers(days)
          return result.message
        }

        // 重置指定用户的使用次数
        if (options.resetUsage) {
          const targetId = options.resetUsage
          if (!userData[targetId]) {
            return `用户 ${targetId} 不存在`
          }
          userData[targetId].dailyUsage = 0
          await membershipSystem.saveUserData()
          const user = userData[targetId]
          const dailyLimit = user.isMember ? config.memberDailyLimit : config.nonMemberDailyLimit
          const remaining = dailyLimit - user.dailyUsage

          return `✅ 已重置用户 ${targetId} 的使用次数\n` +
            `当前状态：${user.isMember ? '会员' : '非会员'}\n` +
            `每日限额：${dailyLimit} 次\n` +
            `已使用：${user.dailyUsage} 次\n` +
            `剩余：${remaining} 次`

        }

        // 查看定时任务状态
        if (options.status) {
          let statusMsg = '【会员系统状态】\n\n'

          // 清理任务状态
          if (config.memberCleanupEnabled) {
            // 使用一个简单的计算来预估下次执行时间
            const [hours, minutes] = config.memberCleanupTime.split(':').map(Number)
            const now = new Date()
            let nextCleanup = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0)
            if (nextCleanup <= now) {
              nextCleanup = new Date(nextCleanup.getTime() + 24 * 60 * 60 * 1000)
            }

            statusMsg += `✅ 自动清理：已启用\n`
            statusMsg += `   清理时间：每天 ${config.memberCleanupTime}\n`
            statusMsg += `   清理范围：过期会员`
            if (config.cleanupNonMembers) {
              statusMsg += ` + 非会员 (${config.nonMemberInactiveDays}天未使用)\n`
            } else {
              statusMsg += ` 仅\n`
            }
            statusMsg += `   下次执行：${nextCleanup.toLocaleString()}\n\n`
          } else {
            statusMsg += `❌ 自动清理：未启用\n\n`
          }

          // 提醒任务状态
          if (config.memberExpiryReminderEnabled) {
            const [hours, minutes] = config.memberReminderTime.split(':').map(Number)
            const now = new Date()
            let nextReminder = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0)
            if (nextReminder <= now) {
              nextReminder = new Date(nextReminder.getTime() + 24 * 60 * 60 * 1000)
            }

            statusMsg += `✅ 到期提醒：已启用\n`
            statusMsg += `   检查时间：每天 ${config.memberReminderTime}\n`
            statusMsg += `   提醒阈值：提前 ${config.memberReminderHours} 小时\n`
            statusMsg += `   提醒群组：${config.memberReminderGroups?.length || 0} 个\n`
            statusMsg += `   下次执行：${nextReminder.toLocaleString()}\n\n`
          } else {
            statusMsg += `❌ 到期提醒：未启用\n\n`
          }

          // 统计会员信息
          const now = Date.now()
          let totalUsers = 0
          let activeMembers = 0
          let expiredMembers = 0
          let nonMembers = 0

          for (const userId in userData) {
            totalUsers++
            const user = userData[userId]
            if (user.isMember) {
              if (user.membershipExpiry > now) {
                activeMembers++
              } else {
                expiredMembers++
              }
            } else {
              nonMembers++
            }
          }

          statusMsg += `【用户统计】\n`
          statusMsg += `总用户数：${totalUsers}\n`
          statusMsg += `有效会员：${activeMembers}\n`
          statusMsg += `过期会员：${expiredMembers}\n`
          statusMsg += `非会员：${nonMembers}\n`

          return statusMsg
        }

        // 立即执行清理
        if (options.cleanup) {
          await session.send('正在执行用户信息清理...')
          await membershipSystem.cleanupExpiredMembers()
          return '✅ 清理完成！请查看控制台日志获取详细信息。'
        }

        // 立即执行提醒
        if (options.remind) {
          if (!config.memberReminderGroups || config.memberReminderGroups.length === 0) {
            return '❌ 未配置提醒群组，无法发送提醒'
          }

          await session.send('正在检查即将到期的会员...')
          await membershipSystem.checkAndRemindExpiringMembers()
          return '✅ 提醒完成！请查看控制台日志获取详细信息。'
        }

        // 如果没有指定任何选项，显示帮助
        return '请使用以下选项：\n-c 立即执行会员信息清理\n-r 立即执行会员到期提醒\n-s 查看定时任务状态\n-u 重置指定用户的使用次数\n-a <天数> 给所有会员增加天数'
      })
  }

  // ========== Director Tools 功能 ==========
  if (config.directorToolsEnabled !== false) {  // 默认启用

    // Director Tools 图像处理核心函数
    async function callDirectorToolsAPI(
      toolType: DirectorTools.ToolType,
      imageData: ImageData,
      token: string,
      options: {
        defry?: number
        prompt?: string
      } = {}
    ): Promise<string> {

      if (config.debugLog) {
        ctx.logger.info(`[Director Tools API] 开始处理，工具类型: ${toolType}`)
        ctx.logger.info(`[Director Tools API] 图像尺寸: ${imageData.buffer.byteLength} bytes`)
      }

      // 获取图像尺寸
      const size = getImageSize(imageData.buffer)

      if (config.debugLog) {
        ctx.logger.info(`[Director Tools API] 图像分辨率: ${size.width}x${size.height}`)
      }

      // 构建请求
      const request: DirectorTools.Request = {
        height: size.height,
        width: size.width,
        image: imageData.base64,
        req_type: toolType,
      }

      // 添加可选参数
      if (options.defry !== undefined) {
        request.defry = options.defry
      }

      if (options.prompt) {
        request.prompt = options.prompt
      }

      if (config.debugLog) {
        ctx.logger.info(`[Director Tools API] 请求参数: ${JSON.stringify({
          ...request,
          image: `[base64 data, length: ${request.image.length}]`
        })}`)
      }

      // 发送请求到 NovelAI API
      const res = await ctx.http(trimSlash(config.endpoint) + '/ai/augment-image', {
        method: 'POST',
        timeout: config.requestTimeout,
        responseType: 'arraybuffer',
        headers: {
          ...config.headers,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: request,
      })

      if (config.debugLog) {
        ctx.logger.info(`[Director Tools API] 请求成功，响应大小: ${res.data.byteLength} bytes`)
      }

      // NovelAI Director Tools 返回的是 ZIP 压缩文件，需要解压
      const buffer = Buffer.from(res.data)

      // 检查是否为 ZIP 文件（魔数 50 4B 03 04 = "PK\x03\x04"）
      const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04

      if (config.debugLog) {
        const magic = buffer.slice(0, 4).toString('hex')
        ctx.logger.info(`[Director Tools API] 文件魔数: ${magic}, 是否为ZIP: ${isZip}`)
      }

      let resultBase64: string

      if (isZip) {
        // 解压 ZIP 文件提取 PNG
        if (config.debugLog) {
          ctx.logger.info('[Director Tools API] 检测到 ZIP 文件，开始解压')
        }

        try {
          const zip = new AdmZip(buffer)
          const zipEntries = zip.getEntries()

          if (config.debugLog) {
            ctx.logger.info(`[Director Tools API] ZIP 包含 ${zipEntries.length} 个文件`)
            zipEntries.forEach((entry, idx) => {
              ctx.logger.info(`[Director Tools API] 文件 ${idx}: ${entry.entryName}, ${entry.header.size} bytes`)
            })
          }

          // 提取第一个图片文件
          const firstImageBuffer = zip.readFile(zipEntries[0])
          resultBase64 = firstImageBuffer.toString('base64')

          if (config.debugLog) {
            ctx.logger.info(`[Director Tools API] 成功提取 PNG 文件: ${zipEntries[0].entryName}`)
            ctx.logger.info(`[Director Tools API] PNG 大小: ${Math.round(firstImageBuffer.length / 1024)}KB`)
          }
        } catch (zipErr) {
          ctx.logger.error(`[Director Tools API] ZIP 解压失败: ${zipErr.message}`, zipErr)
          throw new Error('解压图片失败')
        }
      } else {
        // 不是 ZIP，直接使用
        if (config.debugLog) {
          ctx.logger.info('[Director Tools API] 不是 ZIP 文件，直接使用')
        }
        resultBase64 = buffer.toString('base64')
      }

      const dataUrl = forceDataPrefix(resultBase64, 'image/png')

      if (config.debugLog) {
        ctx.logger.info('[Director Tools API] 图像转换完成')
        ctx.logger.info(`[Director Tools API] Base64 长度: ${resultBase64.length}, DataURL 长度: ${dataUrl.length}`)
      }

      return dataUrl
    }

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

        // 2. 提取图片并清理 prompt 中的图片标签
        let imgUrl: string
        const inputContent = session.content || ''

        // 使用 h.transform 提取图片并移除图片元素
        const cleanedInput = h('', h.transform(h.parse(inputContent), {
          img(attrs) {
            imgUrl = attrs.src
            return ''  // 移除图片元素
          },
        })).toString(true)

        // 如果消息中没有图片，尝试从引用消息中提取
        if (!imgUrl && session.quote) {
          h.transform(h.parse(session.quote.content), {
            img(attrs) {
              imgUrl = attrs.src
              return ''
            },
          })

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
            h.transform(h.parse(userInput), {
              img(attrs) {
                imgUrl = attrs.src
                return ''
              },
            })

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

        // 增加用户任务计数
        queueSystem.incrementUserTask(userId, 1)

        // 显示队列信息
        const now = Date.now()
        const { totalWaiting, userQueue } = queueSystem.getQueueStatus(userId)
        const totalWithCurrent = totalWaiting + 1

        if ((totalWithCurrent > 0 || userQueue > 0) && config.showQueueInfo) {
          ctx.logger.debug(`[Director Tools] 队列信息 - 总队列: ${totalWithCurrent}, 用户队列: ${userQueue}`)
          const queueMsg = await session.text('commands.novelai.messages.queue-position', [totalWithCurrent, userQueue])
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
            // 步骤 1: 下载图片
            if (config.debugLog) {
              ctx.logger.info(`[Director Tools Task] 开始下载图片`)
            }

            let imageData: ImageData
            try {
              imageData = await download(ctx, imgUrl)
              if (config.debugLog) {
                ctx.logger.info(`[Director Tools Task] 图片下载完成，大小: ${imageData.buffer.byteLength} bytes`)
              }
            } catch (err) {
              ctx.logger.error(`[Director Tools Task] 图片下载失败: ${err.message}`, err)
              if (err instanceof NetworkError) {
                throw err
              }
              throw new NetworkError('commands.novelai.messages.download-error')
            }

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
              resultDataUrl = await callDirectorToolsAPI(toolType, imageData, token, requestOptions)

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

declare module 'koishi' {
  namespace Command {
    interface Config {
      ignoreSpace?: boolean
    }
  }
}