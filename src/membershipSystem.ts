import { Context, Dict, Session } from 'koishi'
import { Config } from './config'
import { UserData } from './types'
import { resolve } from 'path'
import { readFile } from 'fs/promises'

export class MembershipSystem {
  // 用户数据存储
  public userData: Dict<UserData> = Object.create(null)

  // 数据持久化路径
  private userDataPath: string

  // 定时任务取消函数
  private cleanupTimerDispose: (() => void) | null = null
  private reminderTimerDispose: (() => void) | null = null

  constructor(
    private ctx: Context,
    private config: Config
  ) {
    this.userDataPath = resolve(ctx.baseDir, 'data/hhs-huatu-user-data.json')

    // 初始加载数据
    this.loadUserData()

    // 初始化定时任务
    this.setupCleanupTask()
    this.setupReminderTask()

    // 监听配置变化
    ctx.accept(['membershipEnabled', 'memberCleanupEnabled', 'memberCleanupTime', 'memberExpiryReminderEnabled', 'memberReminderTime', 'memberReminderHours'], () => {
      ctx.logger.info('会员系统配置已更新，重新安排定时任务')
      this.setupCleanupTask()
      this.setupReminderTask()
    })
  }

  // 加载用户数据
  async loadUserData() {
    try {
      const fs = require('fs')
      if (fs.existsSync(this.userDataPath)) {
        const data = await readFile(this.userDataPath, 'utf8')
        const loadedData = JSON.parse(data)
        Object.assign(this.userData, loadedData)
        this.ctx.logger.info('会员系统数据加载成功')
      }
    } catch (err) {
      this.ctx.logger.error('加载会员系统数据失败', err)
    }
  }

  // 保存用户数据
  async saveUserData() {
    try {
      const fs = require('fs')
      const data = JSON.stringify(this.userData, null, 2)
      await fs.promises.writeFile(this.userDataPath, data, 'utf8')
      if (this.config.debugLog) this.ctx.logger.info('会员系统数据保存成功')
    } catch (err) {
      this.ctx.logger.error('保存会员系统数据失败', err)
    }
  }

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
    const cleanedMembers: string[] = []
    const cleanedNonMembers: string[] = []

    // 计算非会员的不活跃阈值时间
    const inactiveThreshold = this.config.nonMemberInactiveDays * 24 * 60 * 60 * 1000

    for (const userId in this.userData) {
      const user = this.userData[userId]

      // 检查是否为过期会员
      if (user.isMember && user.membershipExpiry < now) {
        // 删除已过期的会员信息
        cleanedMembers.push(userId)
        delete this.userData[userId]
        cleanedMemberCount++
        this.ctx.logger.info(`已清理过期会员信息: ${userId}`)
      }
      // 检查是否需要清理非会员
      else if (!user.isMember && this.config.cleanupNonMembers) {
        let shouldCleanup = false

        if (this.config.nonMemberInactiveDays === 0) {
          // 如果设置为0，清理所有非会员
          shouldCleanup = true
        } else {
          // 检查非会员是否长时间未使用
          const lastActiveTime = user.lastUsed || user.lastDrawTime || 0
          const inactiveDuration = now - lastActiveTime

          if (inactiveDuration > inactiveThreshold) {
            shouldCleanup = true
          }
        }

        if (shouldCleanup) {
          cleanedNonMembers.push(userId)
          delete this.userData[userId]
          cleanedNonMemberCount++
          this.ctx.logger.info(`已清理非会员信息: ${userId} (不活跃天数: ${Math.floor((now - (user.lastUsed || 0)) / (24 * 60 * 60 * 1000))})`)
        }
      }
    }

    const totalCleaned = cleanedMemberCount + cleanedNonMemberCount

    if (totalCleaned > 0) {
      await this.saveUserData()
      this.ctx.logger.info(`用户信息清理完成，共清理 ${totalCleaned} 条记录（过期会员: ${cleanedMemberCount}，非会员: ${cleanedNonMemberCount}）`)
    } else {
      if (this.config.debugLog) this.ctx.logger.info('用户信息清理完成，无需清理的记录')
    }
  }

  // 检查并提醒即将到期的会员
  async checkAndRemindExpiringMembers() {
    if (!this.config.membershipEnabled || !this.config.memberExpiryReminderEnabled) return

    // 如果没有配置提醒群组，则不发送提醒
    if (!this.config.memberReminderGroups || this.config.memberReminderGroups.length === 0) {
      if (this.config.debugLog) this.ctx.logger.info('未配置会员提醒群组，跳过提醒检查')
      return
    }

    const now = Date.now()
    const reminderThreshold = this.config.memberReminderHours * 60 * 60 * 1000
    const expiringMembers: Array<{ userId: string; remainingHours: number }> = []

    for (const userId in this.userData) {
      const user = this.userData[userId]

      // 检查是否为有效会员且即将到期
      if (user.isMember && user.membershipExpiry > now) {
        const remainingTime = user.membershipExpiry - now

        // 如果剩余时间小于提醒阈值
        if (remainingTime <= reminderThreshold) {
          const remainingHours = Math.ceil(remainingTime / (60 * 60 * 1000))
          expiringMembers.push({ userId, remainingHours })
        }
      }
    }

    if (expiringMembers.length > 0) {
      this.ctx.logger.info(`发现 ${expiringMembers.length} 位会员即将到期，将发送到配置的群组`)

      // 构建提醒消息
      let message = '【会员到期提醒】\n以下会员即将到期：\n\n'
      expiringMembers.forEach((member, index) => {
        const expireDate = new Date(this.userData[member.userId].membershipExpiry).toLocaleString()
        message += `${index + 1}. <at id="${member.userId}"/> \n   剩余时间: ${member.remainingHours} 小时\n   到期时间: ${expireDate}\n\n`
      })

      // 向配置的群组发送提醒
      for (const groupId of this.config.memberReminderGroups) {
        try {
          // 获取第一个可用的机器人
          const bots = this.ctx.bots
          let sent = false

          for (const bot of bots) {
            try {
              await bot.sendMessage(groupId, message)
              this.ctx.logger.info(`已向群组 ${groupId} 发送会员到期提醒（包含@功能）`)
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
    // 清除旧的定时任务
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
          // 执行完后安排下一次（每24小时执行一次）
          scheduleCleanup()
        }, delay)
      }

      scheduleCleanup()
    }
  }

  // 设置定时提醒任务
  private setupReminderTask() {
    // 清除旧的定时任务
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
          // 执行完后安排下一次（每24小时执行一次）
          scheduleReminder()
        }, delay)
      }

      scheduleReminder()
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

    // 遍历所有用户数据，给有效会员增加天数
    for (const userId in this.userData) {
      const user = this.userData[userId]

      // 检查是否为有效会员
      if (user.isMember && user.membershipExpiry > now) {
        user.membershipExpiry += daysInMs
        updatedCount++
        this.ctx.logger.info(`已为会员 ${userId} 增加 ${days} 天，到期时间：${new Date(user.membershipExpiry).toLocaleString()}`)
      }
    }

    // 保存用户数据
    if (updatedCount > 0) {
      await this.saveUserData()
    }

    const message = updatedCount > 0
      ? `✅ 成功为 ${updatedCount} 位会员增加 ${days} 天会员时长`
      : '⚠️ 当前没有有效会员可增加天数'

    return { success: true, count: updatedCount, message }
  }

  // 检查并重置每日使用次数
  checkAndResetDailyUsage(userId: string) {
    if (!this.userData[userId]) {
      this.userData[userId] = {
        isMember: false,
        membershipExpiry: 0,
        dailyUsage: 0,
        lastUsed: Date.now(),
        dailyLimit: this.config.nonMemberDailyLimit
      }
      return
    }

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

    if (!this.userData[userId]) {
      this.userData[userId] = {
        isMember: false,
        membershipExpiry: 0,
        dailyUsage: drawCount,
        lastUsed: now,
        dailyLimit: this.config.nonMemberDailyLimit
      }
      return
    }

    this.userData[userId].dailyUsage += drawCount
    this.userData[userId].lastUsed = now

    // 保存用户数据
    this.saveUserData()
  }

  // 更新最后绘图时间
  updateLastDrawTime(userId: string, time?: number) {
    if (!this.config.membershipEnabled) return

    const now = time || Date.now()

    if (!this.userData[userId]) {
      this.userData[userId] = {
        isMember: false,
        membershipExpiry: 0,
        dailyUsage: 0,
        lastUsed: now,
        lastDrawTime: now,
        dailyLimit: this.config.nonMemberDailyLimit
      }
    } else {
      this.userData[userId].lastDrawTime = now
    }

    this.saveUserData()
  }
}

