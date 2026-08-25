import { Context, Dict, Session } from 'koishi'
import { Config } from './config'
import { MembershipSystem } from './membershipSystem'

export interface TaskQueueItem {
  session: Session<'authority', never, Context>
  options: any
  input: string
  resolve: (value: any) => void
  reject: (reason: any) => void
  isRedraw?: boolean
}

export class QueueSystem {
  // 任务队列
  public taskQueue: TaskQueueItem[] = []
  // 正在处理的任务数
  public processingTasks: number = 0
  // 用户任务计数
  public userTasks: Dict<number> = Object.create(null)
  // 用户冷却时间
  public userCooldowns: Dict<number> = Object.create(null)
  // 用户最后一次任务
  public userLastTask: Dict<{
    session: Session<'authority'>,
    options: any,
    input: string,
    pointsCost?: number
  }> = Object.create(null)

  // 重画相关
  private lastRedrawTime = 0
  private redrawLock = false
  private redrawWaitQueue: (() => void)[] = []

  // 最大并发任务数
  public maxConcurrentTasks: number

  // 会员系统引用
  private membershipSystem: MembershipSystem | null = null

  // Token管理相关
  private tokenPool: boolean[] = []
  // tokenPool 使用紧凑槽位，tokenIndices 保留配置数组中的真实下标，
  // 这样可以忽略配置中为了方便填写而保留的空白行。
  private tokenIndices: number[] = []
  // 轮询分配的起始索引。每次成功分配后指向下一个 token。
  private nextTokenIndex = 0

  constructor(
    private ctx: Context,
    private config: Config,
    private generateImageFn: (session: Session<'authority'>, options: any, input: string) => Promise<any>,
    membershipSystem?: MembershipSystem,
    initialTokenUsage?: Dict<boolean>
  ) {
    this.membershipSystem = membershipSystem || null
    // 初始化 Token 池（每个 token 只允许同时一个任务）。
    // 配置可能在插件运行期间从多 Token 改成单 Token，具体同步逻辑统一由
    // syncTokenPool() 处理，避免热更新后仍保留旧的并发槽位。
    this.syncTokenPool()
  }

  /**
   * 根据当前配置同步 Token 池。
   *
   * 需要保留仍在执行中的槽位状态：如果双 Token 运行期间切换成单 Token，
   * 被移除的槽位对应的旧任务仍可能在运行，不能因为重建数组就立刻复用剩余
   * 槽位，否则两个任务会再次共用同一个 Token。processQueue() 还会结合
   * processingTasks 做总量保护，等所有旧任务结束后再恢复单 Token 串行。
   */
  public syncTokenPool(): void {
    const previousIndices = this.tokenIndices
    const previousPool = this.tokenPool

    let nextIndices: number[]
    if (Array.isArray(this.config.token) && this.config.token.length > 0) {
      nextIndices = this.config.token
        .map((token, index) => typeof token === 'string' && token.trim() ? index : -1)
        .filter(index => index >= 0)
    } else {
      // 单 Token、非 Token 授权模式以及空配置都保持串行行为。
      nextIndices = [0]
    }

    this.tokenIndices = nextIndices
    this.tokenPool = nextIndices.map((index) => {
      const previousSlot = previousIndices.indexOf(index)
      return previousSlot >= 0 ? previousPool[previousSlot] : false
    })
    this.maxConcurrentTasks = this.tokenPool.length
  }

  // 获取锁
  async acquireRedrawLock(): Promise<void> {
    if (!this.redrawLock) {
      this.redrawLock = true
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      this.redrawWaitQueue.push(resolve)
    })
  }

  // 释放锁
  releaseRedrawLock(): void {
    const next = this.redrawWaitQueue.shift()
    if (next) {
      // 延迟释放锁，确保不同的操作有足够的间隔
      setTimeout(() => {
        next()
      }, 100)
    } else {
      this.redrawLock = false
    }
  }

  // 从 Token 池中获取一个空闲的 token 索引（并标记为占用）。
  // 轮询时从 nextTokenIndex 开始查找，因此即使任务是串行执行，
  // 也会在每次任务之间切换到下一个 token，而不是始终命中 token[0]。
  private acquireTokenIndex(): number | null {
    if (!this.tokenPool.length) return null

    const strategy = this.config.tokenStrategy || 'round-robin'
    if (strategy === 'random') {
      const available = this.tokenPool
        .map((busy, slot) => busy ? -1 : slot)
        .filter(slot => slot >= 0)
      if (!available.length) return null
      const slot = available[Math.floor(Math.random() * available.length)]
      this.tokenPool[slot] = true
      return this.tokenIndices[slot]
    }

    if (strategy === 'round-robin') {
      for (let offset = 0; offset < this.tokenPool.length; offset++) {
        const slot = (this.nextTokenIndex + offset) % this.tokenPool.length
        if (!this.tokenPool[slot]) {
          this.tokenPool[slot] = true
          this.nextTokenIndex = (slot + 1) % this.tokenPool.length
          return this.tokenIndices[slot]
        }
      }
      return null
    }

    // first-available、fallback、parallel 以及未知旧值均保持旧行为：
    // 从前往后选择第一个空闲 token。
    for (let slot = 0; slot < this.tokenPool.length; slot++) {
      if (!this.tokenPool[slot]) {
        this.tokenPool[slot] = true
        return this.tokenIndices[slot]
      }
    }
    return null
  }

  // 释放指定的 token 索引（标记为空闲）
  private releaseTokenIndex(index: number) {
    if (index == null) return
    if (!this.tokenPool.length) return
    const slot = this.tokenIndices.indexOf(index)
    if (slot >= 0) {
      this.tokenPool[slot] = false
    }
  }

  // 提供给外部任务借用/归还 token 索引
  public borrowTokenIndex(): number | null {
    return this.acquireTokenIndex()
  }

  public returnTokenIndex(index: number): void {
    this.releaseTokenIndex(index)
  }

  // 处理队列
  async processQueue() {
    if (this.taskQueue.length === 0) return

    // 配置可能通过 Koishi 热更新，此时构造函数中的 Token 池已经过期。
    this.syncTokenPool()

    // 按照 Token 池的空闲数量并行启动任务
    let dispatchCount = 0
    while (this.taskQueue.length > 0) {
      // 配置从多 Token 切换为单 Token 时，旧槽位可能还有任务在运行，
      // 不能只看重建后的 tokenPool，否则剩余槽位会被提前再次占用。
      if (this.processingTasks >= this.maxConcurrentTasks) break

      const tokenIndex = this.acquireTokenIndex()
      if (tokenIndex == null) break

      const task = this.taskQueue.shift()!
      this.processingTasks++

      // 将分配的 token 索引写入 session.runtime，供 getToken() 使用
      const taskSession = task.session as any
      taskSession.runtime = taskSession.runtime || {}
      taskSession.runtime._forcedTokenIndex = tokenIndex

      Promise.resolve().then(async () => {
        try {
          const result = await this.generateImageFn(task.session, task.options, task.input)
          task.resolve(result)
        } catch (err) {
          task.reject(err)
        } finally {
          this.processingTasks--
          this.releaseTokenIndex(tokenIndex)
          // 每完成一个任务，继续处理队列中的后续任务
          this.processQueue()
        }
      })
    }
  }

  // 添加任务到队列
  addTask(task: TaskQueueItem): Promise<any> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({
        ...task,
        resolve: (value) => {
          this.userTasks[task.session.userId]--
          resolve(value)
        },
        reject: (reason) => {
          this.userTasks[task.session.userId]--
          reject(reason)
        }
      })

      this.processQueue()
    })
  }

  // 获取队列状态
  getQueueStatus(userId: string): { totalWaiting: number; userQueue: number } {
    const totalWaiting = this.taskQueue.length + this.processingTasks
    const userQueue = this.userTasks[userId] || 0

    return { totalWaiting, userQueue }
  }

  // 检查用户是否可以添加任务
  canAddTask(userId: string): { canAdd: boolean; message?: string } {
    const now = Date.now()

    // 检查冷却时间
    if (this.userCooldowns[userId] && now < this.userCooldowns[userId]) {
      const remainingTime = Math.ceil((this.userCooldowns[userId] - now) / 1000)
      return {
        canAdd: false,
        message: `penalty-cooldown:${remainingTime}`
      }
    }

    // 检查用户队列大小
    const userTaskCount = this.userTasks[userId] || 0
    if (userTaskCount >= this.config.maxUserQueueSize) {
      this.userCooldowns[userId] = now + this.config.penaltyCooldown
      return {
        canAdd: false,
        message: `exceed-user-queue:${this.config.maxUserQueueSize}`
      }
    }

    return { canAdd: true }
  }

  // 增加用户任务计数
  incrementUserTask(userId: string, count: number = 1): void {
    this.userTasks[userId] = (this.userTasks[userId] || 0) + count
  }

  // 重置用户队列状态
  resetUserQueue(userId: string): void {
    this.userTasks[userId] = 0
    delete this.userCooldowns[userId]
  }

  // 保存用户最后一次任务
  saveLastTask(userId: string, session: Session<'authority'>, options: any, input: string, pointsCost?: number): void {
    // 1. 深拷贝 options
    const optionsToSave = JSON.parse(JSON.stringify(options))

    // 2. 删除占内存的 Base64 数据
    // 因为我们已经存了 _originalUrl / _maskUrl / _charRefUrl，这些大字符串就不需要了
    if (optionsToSave._originalBase64) delete optionsToSave._originalBase64
    if (optionsToSave._maskBase64) delete optionsToSave._maskBase64
    if (optionsToSave._alignedWidth) delete optionsToSave._alignedWidth
    if (optionsToSave._alignedHeight) delete optionsToSave._alignedHeight
    // 清理角色参考的 base64 数据（一张 1536x1024 的 PNG 可达数 MB）
    if (optionsToSave._charRefBase64) delete optionsToSave._charRefBase64
    // 清理旧的扣费记录，重画时由外部统一管理扣费
    if (optionsToSave._deductedPoints) delete optionsToSave._deductedPoints

    // 3. 保存瘦身后的数据到内存
    this.userLastTask[userId] = { session, options: optionsToSave, input, pointsCost: pointsCost || 0 }
  }

  // 获取用户最后一次任务
  getLastTask(userId: string): { session: Session<'authority'>, options: any, input: string, pointsCost?: number } | undefined {
    return this.userLastTask[userId]
  }

  // 获取 lastRedrawTime
  getLastRedrawTime(): number {
    return this.lastRedrawTime
  }

  // 设置 lastRedrawTime
  setLastRedrawTime(time: number): void {
    this.lastRedrawTime = time
  }
}
