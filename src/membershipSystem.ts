import { Context, Dict, Session } from 'koishi'
import { Config } from './config'
import { UserData, HhsHuatuUser } from './types'
import { resolve } from 'path'
import { readFile } from 'fs/promises'

export class MembershipSystem {
  // 用户数据内存缓存
  public userData: Dict<UserData> = Object.create(null)

  // 定时任务取消函数
  private cleanupTimerDispose: (() => void) | null = null
  private reminderTimerDispose: (() => void) | null = null
  private pointsRefreshTimerDispose: (() => void) | null = null

  // 上次点数刷新时间（从数据库元数据读取或首次设置）
  private lastPointsRefreshTime: number = 0

  constructor(
    private ctx: Context,
    private config: Config
  ) {
    // 确保导入文件夹存在
    this.ensureImportDir()

    // 注册数据库表
    this.registerDatabase()

    // 初始加载数据
    this.loadUserDataFromDB()

    // 初始化定时任务
    this.setupCleanupTask()
    this.setupReminderTask()
    this.setupPointsRefreshTask()

    // 监听配置变化
    ctx.accept(['membershipEnabled', 'memberCleanupEnabled', 'memberCleanupTime', 'memberExpiryReminderEnabled', 'memberReminderTime', 'memberReminderHours', 'pointsEnabled', 'pointsMode', 'pointsRefreshCycleDays'], () => {
      ctx.logger.info('会员系统配置已更新，重新安排定时任务')
      if (this.config.membershipEnabled && Object.keys(this.userData).length === 0) {
        this.loadUserDataFromDB().catch(err => this.ctx.logger.error('动态加载用户数据失败', err))
      }
      this.setupCleanupTask()
      this.setupReminderTask()
      this.setupPointsRefreshTask()
    })
  }

  // 确保导入文件夹存在
  private ensureImportDir() {
    try {
      const fs = require('fs')
      const importDir = resolve(this.ctx.baseDir, 'data/hhs-huatu-import')
      if (!fs.existsSync(importDir)) {
        fs.mkdirSync(importDir, { recursive: true })
        if (this.config.debugLog) {
          this.ctx.logger.info(`已自动创建导入数据文件夹: ${importDir}`)
        }
      }
    } catch (err) {
      this.ctx.logger.error('自动创建导入数据文件夹失败', err)
    }
  }

  // 注册数据库模型
  private registerDatabase() {
    this.ctx.model.extend('hhs_huatu_user', {
      id: 'unsigned',
      visitorId: 'string',
      isMember: 'boolean',
      membershipExpiry: 'unsigned',
      dailyUsage: 'unsigned',
      lastUsed: 'unsigned',
      dailyLimit: 'unsigned',
      lastDrawTime: 'unsigned',
      points: 'integer',
    }, {
      autoInc: true,
      unique: ['visitorId'],
    })
  }

  // 从数据库加载数据到内存缓存
  async loadUserDataFromDB() {
    if (!this.config.membershipEnabled) {
      if (this.config.debugLog) this.ctx.logger.info('会员系统未启用，跳过从数据库加载用户数据')
      return;
    }
    
    try {
      const rows = await this.ctx.database.get('hhs_huatu_user', {})
      let loadedCount = 0;
      for (const row of rows) {
        if (row.visitorId === '_system_points_refresh') {
          this.lastPointsRefreshTime = row.lastUsed || 0;
          continue;
        }
        loadedCount++;
        this.userData[row.visitorId] = {
          isMember: row.isMember,
          membershipExpiry: row.membershipExpiry,
          dailyUsage: row.dailyUsage,
          lastUsed: row.lastUsed,
          dailyLimit: row.dailyLimit,
          lastDrawTime: row.lastDrawTime,
          points: row.points,
        }
      }
      this.ctx.logger.info(`会员系统数据从数据库加载成功，共 ${loadedCount} 条记录`)
    } catch (err) {
      this.ctx.logger.error('从数据库加载会员系统数据失败', err)
    }
  }

  // 保存点数刷新时间记录
  async saveLastPointsRefreshTime() {
    try {
      await this.ctx.database.upsert('hhs_huatu_user', [{
        visitorId: '_system_points_refresh',
        isMember: false,
        membershipExpiry: 0,
        dailyUsage: 0,
        lastUsed: this.lastPointsRefreshTime,
        dailyLimit: 0,
        lastDrawTime: 0,
        points: 0,
      }], ['visitorId'])
    } catch (err) {
      this.ctx.logger.error('保存点数刷新时间失败', err)
    }
  }

  // 将单个用户数据同步到数据库
  async syncUserToDB(userId: string) {
    try {
      const user = this.userData[userId]
      if (!user) return
      await this.ctx.database.upsert('hhs_huatu_user', [{
        visitorId: userId,
        isMember: user.isMember,
        membershipExpiry: user.membershipExpiry,
        dailyUsage: user.dailyUsage,
        lastUsed: user.lastUsed,
        dailyLimit: user.dailyLimit,
        lastDrawTime: user.lastDrawTime || 0,
        points: user.points || 0,
      }], ['visitorId'])
      if (this.config.debugLog) this.ctx.logger.info(`用户 ${userId} 数据已同步到数据库`)
    } catch (err) {
      this.ctx.logger.error(`同步用户 ${userId} 数据到数据库失败`, err)
    }
  }

  // 保存所有用户数据到数据库（批量）
  async saveUserData() {
    try {
      const rows: Partial<HhsHuatuUser>[] = []
      for (const userId in this.userData) {
        const user = this.userData[userId]
        rows.push({
          visitorId: userId,
          isMember: user.isMember,
          membershipExpiry: user.membershipExpiry,
          dailyUsage: user.dailyUsage,
          lastUsed: user.lastUsed,
          dailyLimit: user.dailyLimit,
          lastDrawTime: user.lastDrawTime || 0,
          points: user.points || 0,
        })
      }
      if (rows.length > 0) {
        await this.ctx.database.upsert('hhs_huatu_user', rows, ['visitorId'])
      }
      if (this.config.debugLog) this.ctx.logger.info('会员系统数据批量保存成功')
    } catch (err) {
      this.ctx.logger.error('批量保存会员系统数据失败', err)
    }
  }

  // ========== 点数计算相关 ==========

  /**
   * 计算预估消耗点数（基于 Opus 套餐）
   * 社区逆向工程的 NAI Anlas 估算公式
   */
  calculatePointsCost(params: {
    width: number
    height: number
    steps: number
    smea?: boolean
    smeaDyn?: boolean
    strength?: number
    isImg2Img?: boolean
    preciseRefCount?: number
  }): number {
    if (!this.config.pointsEnabled) return 0

    const {
      width, height, steps,
      smea = false, smeaDyn = false,
      strength = 1, isImg2Img = false,
      preciseRefCount = 0,
    } = params

    const pixels = width * height

    // Opus 免费范围判定：标准分辨率 + 28步以下
    if (pixels <= 1048576 && steps <= 28) {
      // 即使 Opus 免费，精准参考仍有额外费用
      return preciseRefCount * 5
    }

    // 基础消耗计算
    let L = Math.ceil((2.951823174884865e-15 * pixels + 5.753298233447344e-7 * pixels * steps) * 1.21)

    // SMEA/DYN 加成
    if (smeaDyn) L = Math.ceil(L * 1.4)
    else if (smea) L = Math.ceil(L * 1.2)

    // img2img 强度调整
    if (isImg2Img) {
      L = Math.max(Math.ceil(L * strength), 2)
    }

    // 精准参考额外消耗
    L += preciseRefCount * 5

    return L
  }

  /**
   * 导演工具点数计算
   * 1024×1024 及以下（像素数 ≤ 1,048,576）：0 点数
   * 大于 1,048,576 像素时：点数 = 像素数 ÷ 50,000 - 1.8（结果向上）
   */
  calculateDirectorPointsCost(width: number, height: number, toolType?: string): number {
    if (!this.config.pointsEnabled) return 0
    let points = 0
    const pixels = width * height
    
    if (pixels > 1048576) {
      points = Math.ceil(pixels / 50000 - 1.8)
    }

    if (toolType === 'bg-removal') {
      points += 65
    }
    
    return points
  }

  /**
   * 预扣点数
   * @returns 实际扣除的点数，不足返回 -1
   */
  async deductPoints(userId: string, amount: number): Promise<number> {
    if (!this.config.pointsEnabled || amount <= 0) return 0

    this.ensureUserData(userId)
    const user = this.userData[userId]
    const currentPoints = user.points || 0

    if (currentPoints < amount) {
      return -1 // 点数不足
    }

    user.points = currentPoints - amount
    await this.syncUserToDB(userId)
    return amount
  }

  /**
   * 退还点数
   */
  async refundPoints(userId: string, amount: number): Promise<void> {
    if (!this.config.pointsEnabled || amount <= 0) return

    this.ensureUserData(userId)
    const user = this.userData[userId]
    user.points = (user.points || 0) + amount
    await this.syncUserToDB(userId)
  }

  /**
   * 获取用户当前点数
   */
  getPoints(userId: string): number {
    if (!this.config.pointsEnabled) return 0
    return this.userData[userId]?.points || 0
  }

  /**
   * 批量给所有用户加减点数
   */
  async addPointsToAll(amount: number, membersOnly: boolean = true): Promise<{ count: number; message: string }> {
    if (!this.config.pointsEnabled) {
      return { count: 0, message: '点数控制未启用' }
    }

    let updatedCount = 0
    const now = Date.now()

    for (const userId in this.userData) {
      const user = this.userData[userId]

      if (membersOnly && (!user.isMember || user.membershipExpiry < now)) {
        continue
      }

      user.points = Math.max((user.points || 0) + amount, 0)
      updatedCount++
    }

    if (updatedCount > 0) {
      await this.saveUserData()
    }

    const action = amount >= 0 ? '增加' : '扣除'
    const message = updatedCount > 0
      ? `✅ 成功为 ${updatedCount} 位用户${action} ${Math.abs(amount)} 点数`
      : `⚠️ 没有符合条件的用户`

    return { count: updatedCount, message }
  }

  /**
   * 刷新点数（定期任务）
   */
  async refreshPoints(): Promise<{ count: number; message: string }> {
    if (!this.config.pointsEnabled || this.config.pointsMode !== 'periodic') {
      return { count: 0, message: '点数刷新未启用或不是周期模式' }
    }

    let refreshedCount = 0
    const now = Date.now()
    const refreshAmount = this.config.pointsRefreshAmount || 200

    for (const userId in this.userData) {
      const user = this.userData[userId]

      // 检查是否在刷新范围内
      if (!this.config.pointsRefreshIncludeNonMember) {
        // 仅会员：必须是有效会员
        if (!user.isMember || user.membershipExpiry < now) {
          continue
        }
      }

      user.points = refreshAmount
      refreshedCount++
    }

    this.lastPointsRefreshTime = now
    await this.saveLastPointsRefreshTime()

    if (refreshedCount > 0) {
      await this.saveUserData()
    }

    const message = refreshedCount > 0
      ? `✅ 点数刷新完成，共刷新 ${refreshedCount} 位用户的点数为 ${refreshAmount}`
      : '⚠️ 没有符合条件的用户需要刷新点数'

    this.ctx.logger.info(message)
    return { count: refreshedCount, message }
  }

  /**
   * 获取距离下次点数刷新的天数
   */
  getDaysUntilNextRefresh(): number {
    if (!this.config.pointsEnabled || this.config.pointsMode !== 'periodic') return -1

    const cycleDays = this.config.pointsRefreshCycleDays || 30
    const cycleMs = cycleDays * 24 * 60 * 60 * 1000
    const now = Date.now()

    if (this.lastPointsRefreshTime === 0) return 0

    const remainDays = Math.ceil((this.lastPointsRefreshTime + cycleMs - now) / (24 * 60 * 60 * 1000))
    return remainDays > 0 ? remainDays : 0
  }

  /**
   * 从 JSON 文件导入数据到数据库
   */
  async importFromJson(filePath?: string): Promise<{ success: number; failed: number; message: string }> {
    const importPath = filePath || resolve(this.ctx.baseDir, 'data/hhs-huatu-import/hhs-huatu-user-data.json')

    try {
      const fs = require('fs')
      if (!fs.existsSync(importPath)) {
        return { success: 0, failed: 0, message: `❌ 文件不存在: ${importPath}` }
      }

      const data = await readFile(importPath, 'utf8')
      const jsonData = JSON.parse(data)

      let success = 0
      let failed = 0

      for (const userId in jsonData) {
        try {
          const user = jsonData[userId]
          const defaultPoints = this.config.pointsDefault || 200

          this.userData[userId] = {
            isMember: user.isMember || false,
            membershipExpiry: user.membershipExpiry || 0,
            dailyUsage: user.dailyUsage || 0,
            lastUsed: user.lastUsed || 0,
            dailyLimit: user.dailyLimit || this.config.nonMemberDailyLimit,
            lastDrawTime: user.lastDrawTime || 0,
            // 导入时如果是会员，给予默认点数；否则给 0
            points: user.points !== undefined ? user.points : (user.isMember ? defaultPoints : 0),
          }
          success++
        } catch (err) {
          failed++
          this.ctx.logger.error(`导入用户 ${userId} 失败: ${err}`)
        }
      }

      // 批量保存到数据库
      if (success > 0) {
        await this.saveUserData()
      }

      return {
        success,
        failed,
        message: `✅ 导入完成: 成功 ${success} 条，失败 ${failed} 条`,
      }
    } catch (err) {
      this.ctx.logger.error('导入 JSON 数据失败', err)
      return { success: 0, failed: 0, message: `❌ 导入失败: ${err.message}` }
    }
  }

  // ========== 定时任务 ==========

  // 解析时间字符串（HH:MM）为今天的毫秒时间戳
  private parseTimeToToday(timeStr: string): number {
    const [hours, minutes] = timeStr.split(':').map(Number)
    const now = new Date()
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0)
    return target.getTime()
  }

  // 计算距离下一次执行的延迟时间
  private getDelayUntilTime(timeStr: string): number {
    const now = Date.now()
    const targetTime = this.parseTimeToToday(timeStr)
    let delay = targetTime - now

    // 如果今天的时间已经过了，则安排到明天
    if (delay < 0) {
      delay += 24 * 60 * 60 * 1000
    }

    return delay
  }

  // 清理过期会员信息
  async cleanupExpiredMembers() {
    if (!this.config.membershipEnabled || !this.config.memberCleanupEnabled) return

    const now = Date.now()
    let cleanedMemberCount = 0
    let cleanedNonMemberCount = 0

    // 计算非会员的不活跃阈值时间
    const inactiveThreshold = this.config.nonMemberInactiveDays * 24 * 60 * 60 * 1000

    for (const userId in this.userData) {
      const user = this.userData[userId]

      // 检查是否为过期会员
      if (user.isMember && user.membershipExpiry < now) {
        // 删除已过期的会员信息
        delete this.userData[userId]
        // 从数据库中也删除
        try {
          await this.ctx.database.remove('hhs_huatu_user', { visitorId: userId })
        } catch (err) {
          this.ctx.logger.error(`从数据库删除用户 ${userId} 失败`, err)
        }
        cleanedMemberCount++
        this.ctx.logger.info(`已清理过期会员信息: ${userId}`)
      }
      // 检查是否需要清理非会员
      else if (!user.isMember && this.config.cleanupNonMembers) {
        let shouldCleanup = false

        if (this.config.nonMemberInactiveDays === 0) {
          shouldCleanup = true
        } else {
          const lastActiveTime = user.lastUsed || user.lastDrawTime || 0
          const inactiveDuration = now - lastActiveTime
          if (inactiveDuration > inactiveThreshold) {
            shouldCleanup = true
          }
        }

        if (shouldCleanup) {
          delete this.userData[userId]
          try {
            await this.ctx.database.remove('hhs_huatu_user', { visitorId: userId })
          } catch (err) {
            this.ctx.logger.error(`从数据库删除非会员 ${userId} 失败`, err)
          }
          cleanedNonMemberCount++
          this.ctx.logger.info(`已清理非会员信息: ${userId}`)
        }
      }
    }

    const totalCleaned = cleanedMemberCount + cleanedNonMemberCount

    if (totalCleaned > 0) {
      this.ctx.logger.info(`用户信息清理完成，共清理 ${totalCleaned} 条记录（过期会员: ${cleanedMemberCount}，非会员: ${cleanedNonMemberCount}）`)
    } else {
      if (this.config.debugLog) this.ctx.logger.info('用户信息清理完成，无需清理的记录')
    }
  }

  // 检查并提醒即将到期的会员
  async checkAndRemindExpiringMembers() {
    if (!this.config.membershipEnabled || !this.config.memberExpiryReminderEnabled) return

    if (!this.config.memberReminderGroups || this.config.memberReminderGroups.length === 0) {
      if (this.config.debugLog) this.ctx.logger.info('未配置会员提醒群组，跳过提醒检查')
      return
    }

    const now = Date.now()
    const reminderThreshold = this.config.memberReminderHours * 60 * 60 * 1000
    const expiringMembers: Array<{ userId: string; remainingHours: number }> = []

    for (const userId in this.userData) {
      const user = this.userData[userId]

      if (user.isMember && user.membershipExpiry > now) {
        const remainingTime = user.membershipExpiry - now
        if (remainingTime <= reminderThreshold) {
          const remainingHours = Math.ceil(remainingTime / (60 * 60 * 1000))
          expiringMembers.push({ userId, remainingHours })
        }
      }
    }

    if (expiringMembers.length > 0) {
      this.ctx.logger.info(`发现 ${expiringMembers.length} 位会员即将到期，将发送到配置的群组`)

      let message = '【会员到期提醒】\n以下会员即将到期：\n\n'
      expiringMembers.forEach((member, index) => {
        const expireDate = new Date(this.userData[member.userId].membershipExpiry).toLocaleString()
        message += `${index + 1}. <at id="${member.userId}"/> \n   剩余时间: ${member.remainingHours} 小时\n   到期时间: ${expireDate}\n\n`
      })

      for (const groupId of this.config.memberReminderGroups) {
        try {
          const bots = this.ctx.bots
          let sent = false

          for (const bot of bots) {
            try {
              await bot.sendMessage(groupId, message)
              this.ctx.logger.info(`已向群组 ${groupId} 发送会员到期提醒`)
              sent = true
              break
            } catch (err) {
              this.ctx.logger.warn(`使用 bot ${bot.selfId} 向群组 ${groupId} 发送提醒失败: ${err.message}`)
            }
          }

          if (!sent) {
            this.ctx.logger.error(`无法向群组 ${groupId} 发送提醒，所有机器人都失败了`)
          }
        } catch (err) {
          this.ctx.logger.error(`向群组 ${groupId} 发送提醒时出错: ${err}`)
        }
      }
    } else {
      if (this.config.debugLog) this.ctx.logger.info('会员到期检查完成，无即将到期的会员')
    }
  }

  // 设置定时清理任务
  private setupCleanupTask() {
    if (this.cleanupTimerDispose) {
      this.cleanupTimerDispose()
      this.cleanupTimerDispose = null
    }

    if (this.config.membershipEnabled && this.config.memberCleanupEnabled) {
      const scheduleCleanup = () => {
        const delay = this.getDelayUntilTime(this.config.memberCleanupTime)
        this.ctx.logger.info(`会员信息清理任务已安排，将在 ${new Date(Date.now() + delay).toLocaleString()} 执行`)

        this.cleanupTimerDispose = this.ctx.setTimeout(() => {
          this.cleanupExpiredMembers()
          scheduleCleanup()
        }, delay)
      }

      scheduleCleanup()
    }
  }

  // 设置定时提醒任务
  private setupReminderTask() {
    if (this.reminderTimerDispose) {
      this.reminderTimerDispose()
      this.reminderTimerDispose = null
    }

    if (this.config.membershipEnabled && this.config.memberExpiryReminderEnabled) {
      const scheduleReminder = () => {
        const delay = this.getDelayUntilTime(this.config.memberReminderTime)
        this.ctx.logger.info(`会员到期提醒任务已安排，将在 ${new Date(Date.now() + delay).toLocaleString()} 执行`)

        this.reminderTimerDispose = this.ctx.setTimeout(() => {
          this.checkAndRemindExpiringMembers()
          scheduleReminder()
        }, delay)
      }

      scheduleReminder()
    }
  }

  // 设置点数刷新定时任务（每天检查一次是否需要刷新）
  private setupPointsRefreshTask() {
    if (this.pointsRefreshTimerDispose) {
      this.pointsRefreshTimerDispose()
      this.pointsRefreshTimerDispose = null
    }

    if (this.config.membershipEnabled && this.config.pointsEnabled && this.config.pointsMode === 'periodic') {
      const cycleDays = this.config.pointsRefreshCycleDays || 30
      const cycleMs = cycleDays * 24 * 60 * 60 * 1000
      const ONE_DAY = 24 * 60 * 60 * 1000

      // 每天凌晨 00:05 检查一次是否需要刷新
      const scheduleDailyCheck = () => {
        const delay = this.getDelayUntilTime('00:05')

        this.ctx.logger.info(`点数刷新检查任务已安排，将在 ${new Date(Date.now() + delay).toLocaleString()} 检查（刷新周期: ${cycleDays} 天）`)

        this.pointsRefreshTimerDispose = this.ctx.setTimeout(async () => {
          const now = Date.now()
          const shouldRefresh = this.lastPointsRefreshTime === 0 || (now - this.lastPointsRefreshTime >= cycleMs)

          if (shouldRefresh) {
            this.ctx.logger.info(`已达到刷新周期 (${cycleDays} 天)，正在执行点数刷新...`)
            await this.refreshPoints()
          } else {
            const remainDays = Math.ceil((this.lastPointsRefreshTime + cycleMs - now) / ONE_DAY)
            if (this.config.debugLog) {
              this.ctx.logger.info(`点数刷新检查：距离下次刷新还有 ${remainDays} 天`)
            }
          }

          // 重新安排明天的检查
          scheduleDailyCheck()
        }, delay)
      }

      scheduleDailyCheck()
    }
  }

  // 给所有会员增加天数
  async addDaysToAllMembers(days: number): Promise<{ success: boolean; count: number; message: string }> {
    if (!this.config.membershipEnabled) {
      return { success: false, count: 0, message: '会员系统未启用' }
    }

    const now = Date.now()
    let updatedCount = 0
    const daysInMs = days * 24 * 60 * 60 * 1000

    for (const userId in this.userData) {
      const user = this.userData[userId]

      if (user.isMember && user.membershipExpiry > now) {
        user.membershipExpiry += daysInMs
        updatedCount++
        this.ctx.logger.info(`已为会员 ${userId} 增加 ${days} 天，到期时间：${new Date(user.membershipExpiry).toLocaleString()}`)
      }
    }

    if (updatedCount > 0) {
      await this.saveUserData()
    }

    const message = updatedCount > 0
      ? `✅ 成功为 ${updatedCount} 位会员增加 ${days} 天会员时长`
      : '⚠️ 当前没有有效会员可增加天数'

    return { success: true, count: updatedCount, message }
  }

  // 确保用户数据已初始化
  private ensureUserData(userId: string) {
    if (!this.userData[userId]) {
      this.userData[userId] = {
        isMember: false,
        membershipExpiry: 0,
        dailyUsage: 0,
        lastUsed: Date.now(),
        dailyLimit: this.config.nonMemberDailyLimit,
        points: 0,
      }
    }
  }

  // 检查并重置每日使用次数
  checkAndResetDailyUsage(userId: string) {
    this.ensureUserData(userId)

    const now = new Date()
    const lastUsed = new Date(this.userData[userId].lastUsed)

    // 如果不是同一天，重置使用次数
    if (now.getDate() !== lastUsed.getDate() ||
      now.getMonth() !== lastUsed.getMonth() ||
      now.getFullYear() !== lastUsed.getFullYear()) {
      this.userData[userId].dailyUsage = 0
    }

    // 检查会员是否过期
    if (this.userData[userId].isMember && this.userData[userId].membershipExpiry < Date.now()) {
      this.userData[userId].isMember = false
      this.userData[userId].dailyLimit = this.config.nonMemberDailyLimit

      if (this.config.pointsEnabled && this.config.pointsMode === 'periodic' && !this.config.pointsRefreshIncludeNonMember) {
        this.userData[userId].points = 0
      }
    }
  }

  // 检查用户是否可以使用画图功能
  canUseDrawing(userId: string, session: Session): boolean | string {
    if (!this.config.membershipEnabled) return true

    this.checkAndResetDailyUsage(userId)

    const user = this.userData[userId]

    // 检查会员状态和使用次数
    if (user.isMember) {
      // 会员用户
      if (this.config.memberDailyLimit > 0 && user.dailyUsage >= this.config.memberDailyLimit) {
        return session.text('commands.novelai.messages.member-daily-limit-reached', [this.config.memberDailyLimit])
      }

      // 检查会员CD时间
      if (this.config.memberCooldown > 0 && user.lastDrawTime) {
        const now = Date.now()
        const cooldownMs = this.config.memberCooldown * 1000
        const timeSinceLastDraw = now - user.lastDrawTime

        if (timeSinceLastDraw < cooldownMs) {
          const remainingTime = Math.ceil((cooldownMs - timeSinceLastDraw) / 1000)
          return session.text('commands.novelai.messages.cooldown', [remainingTime])
        }
      }
    } else {
      // 非会员用户
      if (user.dailyUsage >= this.config.nonMemberDailyLimit) {
        return session.text('commands.novelai.messages.daily-limit-reached', [this.config.nonMemberDailyLimit])
      }

      // 检查非会员CD时间
      if (user.lastDrawTime) {
        const now = Date.now()
        const cooldownMs = this.config.nonMemberCooldown * 1000
        const timeSinceLastDraw = now - user.lastDrawTime

        if (timeSinceLastDraw < cooldownMs) {
          const remainingTime = Math.ceil((cooldownMs - timeSinceLastDraw) / 1000)
          return session.text('commands.novelai.messages.cooldown', [remainingTime])
        }
      }
    }

    return true
  }

  // 增加用户使用次数
  incrementUsage(userId: string, drawCount: number = 1) {
    if (!this.config.membershipEnabled) return

    const now = Date.now()

    this.ensureUserData(userId)

    this.userData[userId].dailyUsage += drawCount
    this.userData[userId].lastUsed = now

    // 保存用户数据
    this.syncUserToDB(userId)
  }

  // 更新最后绘图时间
  updateLastDrawTime(userId: string, time?: number) {
    if (!this.config.membershipEnabled) return

    const now = time || Date.now()

    this.ensureUserData(userId)
    this.userData[userId].lastDrawTime = now

    this.syncUserToDB(userId)
  }
}
