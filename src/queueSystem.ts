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
    input: string
  }> = Object.create(null)
  
  // 重画相关
  private lastRedrawTime = 0
  private usedTokenIndices: Set<number> = new Set()
  private redrawLock = false
  private redrawWaitQueue: (() => void)[] = []

  // 最大并发任务数
  public maxConcurrentTasks: number
  
  // 会员系统引用
  private membershipSystem: MembershipSystem | null = null
  
  // Token管理相关
  private tokenPool: boolean[] = []
  
  constructor(
    private ctx: Context,
    private config: Config,
    private generateImageFn: (session: Session<'authority'>, options: any, input: string) => Promise<any>,
    membershipSystem?: MembershipSystem,
    initialTokenUsage?: Dict<boolean>
  ) {
    this.membershipSystem = membershipSystem || null
    // 初始化 Token 池（每个 token 只允许同时一个任务）
    if (Array.isArray(config.token) && config.token.length > 0) {
      this.tokenPool = new Array(config.token.length).fill(false)
      this.maxConcurrentTasks = this.tokenPool.length
    } else if (typeof (config as any).token === 'string' && (config as any).token) {
      this.tokenPool = [false]
      this.maxConcurrentTasks = 1
    } else {
      // 非 token 授权模式时，默认串行
      this.tokenPool = [false]
      this.maxConcurrentTasks = 1
    }
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
  
  // 生成唯一且未被最近使用的 token 索引
  getUniqueTokenIndex(currentIndex: number, tokenCount: number): number {
    if (tokenCount <= 1) return 0
    
    // 如果所有索引都被使用了，清空集合
    if (this.usedTokenIndices.size >= tokenCount) {
      this.usedTokenIndices.clear()
    }
    
    // 尝试找到一个未使用的索引
    let newIndex = currentIndex
    let attempts = 0
    const maxAttempts = tokenCount * 2 // 设置最大尝试次数，避免死循环
    
    while (this.usedTokenIndices.has(newIndex) && attempts < maxAttempts) {
      newIndex = (newIndex + 1) % tokenCount
      attempts++
    }
    
    // 将新索引添加到使用过的集合中
    this.usedTokenIndices.add(newIndex)
    
    return newIndex
  }
  
  // 从 Token 池中获取一个空闲的 token 索引（并标记为占用）
  private acquireTokenIndex(): number | null {
    if (!this.tokenPool.length) return null
    for (let i = 0; i < this.tokenPool.length; i++) {
      if (!this.tokenPool[i]) {
        this.tokenPool[i] = true
        return i
      }
    }
    return null
  }

  // 释放指定的 token 索引（标记为空闲）
  private releaseTokenIndex(index: number) {
    if (index == null) return
    if (!this.tokenPool.length) return
    if (index >= 0 && index < this.tokenPool.length) {
      this.tokenPool[index] = false
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
    
    // 按照 Token 池的空闲数量并行启动任务
    while (this.taskQueue.length > 0) {
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
  saveLastTask(userId: string, session: Session<'authority'>, options: any, input: string): void {
    this.userLastTask[userId] = { session, options, input }
  }
  
  // 获取用户最后一次任务
  getLastTask(userId: string): { session: Session<'authority'>, options: any, input: string } | undefined {
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

