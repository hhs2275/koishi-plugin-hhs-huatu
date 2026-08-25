import { Computed, Context, Dict, Quester, Session, SessionError } from 'koishi'
import { Config, orientMap } from './config'
import { Size, closestMultiple, createContextWithRuntime, login } from './utils'
import { QueueSystem } from './queueSystem'
import { MembershipSystem } from './membershipSystem'
import { UserData } from './types'

export type HiddenCallback = (session: Session<'authority'>) => boolean

export function handleError({ logger }: Context, session: Session, err: Error) {
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

export interface Runtime {
  ctx: Context
  config: Config
  membershipSystem: MembershipSystem
  userData: Dict<UserData>
  tasks: Dict<Set<string>>
  globalTasks: Set<string>
  queueSystem: QueueSystem
  syncTokenUsage(): void
  getToken(session?: Session): Promise<string>
  useFilter(filter: Computed<boolean>): HiddenCallback
  useBackend(...types: Config['type'][]): HiddenCallback
  thirdParty(): boolean
  noImage: HiddenCallback
  some(...args: HiddenCallback[]): HiddenCallback
  step(source: string, session: Session): number
  resolution(source: string, session: Session<'authority'>): Size
  initQueueSystem(generateImageFn: (session: Session<'authority'>, options: any, input: string) => Promise<any>): QueueSystem
}

export function createRuntime(ctx: Context, config: Config): Runtime {
  // 创建会员系统实例
  const membershipSystem = new MembershipSystem(ctx, config)

  // 获取用户数据的引用（用于后续访问）
  const userData = membershipSystem.userData

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
    // Token 配置可以在 Koishi 中热更新，必须同步队列的并发槽位。
    queueSystem?.syncTokenPool()
    queueSystem?.processQueue()
  })

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

  // 初始化token使用状态
  syncTokenUsage()

  const initQueueSystem = (generateImageFn: (session: Session<'authority'>, options: any, input: string) => Promise<any>): QueueSystem => {
    queueSystem = new QueueSystem(ctx, config, generateImageFn, membershipSystem, ctx.runtime?.tokenUsage)
    return queueSystem
  }

  return {
    ctx,
    config,
    membershipSystem,
    userData,
    tasks,
    globalTasks,
    get queueSystem() {
      return queueSystem
    },
    syncTokenUsage,
    getToken,
    useFilter,
    useBackend,
    thirdParty,
    noImage,
    some,
    step,
    resolution,
    initQueueSystem,
  }
}
