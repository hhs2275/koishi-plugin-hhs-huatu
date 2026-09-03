import { Context, Dict, Session } from 'koishi'
import { Config, modelMap } from './config'
import { UserData, MembershipCard, TierBenefit, HhsHuatuUser } from './types'
import { resolve } from 'path'
import { readFile } from 'fs/promises'
import { isNovelAIV5Model } from './services/opusQuota'

/** 会员等级上下限 */
export const MIN_TIER = 1
export const MAX_TIER = 5

export class MembershipSystem {
  // 用户数据内存缓存
  public userData: Dict<UserData> = Object.create(null)
  // 已进队但尚未出图的 nai5 次数，避免并发任务都按免费档计费
  private pendingNai5Usage: Dict<number> = Object.create(null)

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
      nai5DailyUsage: 'unsigned',
    }, {
      autoInc: true,
      unique: ['visitorId'],
    })
    // 会员卡表（多卡叠加制）。
    // 注意：minato 的 unique 配置语义是「逐列各自唯一」而非复合唯一，会导致不同用户无法持有同等级卡，
    // 因此这里不声明 unique；(visitorId, tier) 的唯一性由应用层保证（grantMembershipCard 每等级仅一张卡）。
    this.ctx.model.extend('hhs_huatu_membership_cards', {
      id: 'unsigned',
      visitorId: 'string',
      tier: 'unsigned',
      expiry: 'unsigned',
      grantedAt: 'unsigned',
      grantedBy: 'string',
    }, {
      autoInc: true,
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
          nai5DailyUsage: row.nai5DailyUsage || 0,
        }
      }
      this.ctx.logger.info(`会员系统数据从数据库加载成功，共 ${loadedCount} 条记录`)

      // 加载会员卡数据
      await this.loadCardsFromDB()
      // 存量会员迁移：isMember=true 但没有任何会员卡的用户 → 生成 Lv1 卡
      await this.migrateLegacyMembers()
    } catch (err) {
      this.ctx.logger.error('从数据库加载会员系统数据失败', err)
    }
  }

  // 从数据库加载会员卡到内存
  private async loadCardsFromDB() {
    try {
      const cardRows = await this.ctx.database.get('hhs_huatu_membership_cards', {})
      let cardCount = 0
      for (const row of cardRows) {
        if (!this.userData[row.visitorId]) continue
        if (!this.userData[row.visitorId].cards) this.userData[row.visitorId].cards = []
        this.userData[row.visitorId].cards.push({
          tier: row.tier,
          expiry: row.expiry,
          grantedAt: row.grantedAt,
          grantedBy: row.grantedBy,
        })
        cardCount++
      }
      this.ctx.logger.info(`会员卡数据加载成功，共 ${cardCount} 张卡`)
    } catch (err) {
      this.ctx.logger.error('加载会员卡数据失败', err)
    }
  }

  /**
   * 存量会员迁移（幂等）：isMember=true 且名下无卡 → 按原 membershipExpiry 生成 Lv1 卡。
   * Lv1 权益直接沿用现有全局配置字段，迁移后行为与升级前逐项一致。
   */
  private async migrateLegacyMembers() {
    let migrated = 0
    for (const userId in this.userData) {
      const user = this.userData[userId]
      if (user.isMember && (!user.cards || user.cards.length === 0)) {
        user.cards = [{
          tier: 1,
          expiry: user.membershipExpiry,
          grantedAt: Date.now(),
          grantedBy: 'migration',
        }]
        migrated++
      }
    }
    if (migrated > 0) {
      await this.saveAllCards()
      this.ctx.logger.info(`会员等级迁移完成：已为 ${migrated} 位存量会员生成 Lv1 会员卡`)
    }
  }

  // 将指定用户的所有卡同步到数据库（先删后建，卡数量小，简单可靠）
  private async syncCardsToDB(userId: string) {
    try {
      const user = this.userData[userId]
      if (!user) return
      const cards = user.cards || []
      await this.ctx.database.remove('hhs_huatu_membership_cards', { visitorId: userId })
      for (const card of cards) {
        await this.ctx.database.create('hhs_huatu_membership_cards', {
          visitorId: userId,
          tier: card.tier,
          expiry: card.expiry,
          grantedAt: card.grantedAt,
          grantedBy: card.grantedBy || '',
        })
      }
    } catch (err) {
      this.ctx.logger.error(`同步用户 ${userId} 的会员卡到数据库失败`, err)
    }
  }

  // 将内存中全部用户的卡写回数据库（逐用户先删后建，仅在迁移/批量导入等低频场景调用）
  private async saveAllCards() {
    try {
      for (const userId in this.userData) {
        const cards = this.userData[userId].cards || []
        await this.ctx.database.remove('hhs_huatu_membership_cards', { visitorId: userId })
        for (const card of cards) {
          await this.ctx.database.create('hhs_huatu_membership_cards', {
            visitorId: userId,
            tier: card.tier,
            expiry: card.expiry,
            grantedAt: card.grantedAt,
            grantedBy: card.grantedBy || '',
          })
        }
      }
    } catch (err) {
      this.ctx.logger.error('批量保存会员卡数据失败', err)
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
        nai5DailyUsage: 0,
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
        nai5DailyUsage: user.nai5DailyUsage || 0,
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
          nai5DailyUsage: user.nai5DailyUsage || 0,
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

  // ========== 会员卡与等级制度 ==========

  // 获取用户会员卡列表（确保已初始化）
  getCards(userId: string): MembershipCard[] {
    this.ensureUserData(userId)
    if (!this.userData[userId].cards) this.userData[userId].cards = []
    return this.userData[userId].cards
  }

  // 获取用户当前有效卡（expiry > now）
  getValidCards(userId: string): MembershipCard[] {
    const now = Date.now()
    return this.getCards(userId).filter(card => card.expiry > now)
  }

  // 计算生效等级：有效卡中的最高等级；无有效卡返回 0（非会员）
  private computeActiveTier(cards: MembershipCard[]): number {
    const now = Date.now()
    let max = 0
    for (const card of cards) {
      if (card.expiry > now && card.tier > max) max = card.tier
    }
    return max
  }

  /**
   * 获取用户当前生效等级（0 = 非会员，1-5）。
   * tierEnabled 关闭时高等级卡不产生权益：生效等级一律视为 Lv1（或非会员 0）。
   * 内部通过 checkAndResetDailyUsage 维护 isMember / membershipExpiry 冗余字段。
   */
  getActiveTier(userId: string): number {
    this.checkAndResetDailyUsage(userId)
    const tier = this.computeActiveTier(this.userData[userId]?.cards || [])
    return this.config.tierEnabled === false && tier > 1 ? 1 : tier
  }

  /**
   * 获取指定等级的权益。
   * Lv1 = 现有全局会员配置字段（兼容层）；Lv2-Lv5 = tierBenefits 配置；越界/缺失时回落 Lv1 数值。
   */
  getTierBenefit(tier: number): TierBenefit {
    const lv1: TierBenefit = {
      tier: 1,
      nai5DailyLimit: this.config.memberNai5DailyLimit || 0,
      pointsRefresh: this.config.pointsRefreshAmount || 200,
      dailyLimit: this.config.memberDailyLimit || 0,
      cooldown: this.config.memberCooldown || 0,
    }
    if (!tier || tier <= 1) return lv1
    const found = (this.config.tierBenefits || []).find(b => b.tier === tier)
    if (!found) return { ...lv1, tier }
    return {
      tier,
      nai5DailyLimit: found.nai5DailyLimit || 0,
      pointsRefresh: found.pointsRefresh ?? lv1.pointsRefresh,
      dailyLimit: found.dailyLimit || 0,
      cooldown: found.cooldown || 0,
    }
  }

  // 获取用户当前生效档位的权益；非会员返回 null
  getMemberBenefit(userId: string): TierBenefit | null {
    const tier = this.getActiveTier(userId)
    if (tier <= 0) return null
    return this.getTierBenefit(tier)
  }

  /**
   * 授予/续费会员卡。
   * - 同等级存在有效卡 → 时长叠加；该等级无有效卡 → 新增/替换该等级卡
   * - **低级卡联动**：授予/续费 LvN 时，该用户名下所有更低等级的有效卡同步延长相同天数（保证高档到期后低档衔接）
   * - **升档补差额**：周期刷新模式下，已是会员且升到更高档时，按新旧档位刷新量的「差额」累加补点（用户已充值/已获点数不受影响）
   * - 用户此前没有任何有效卡（首次成为会员）→ 按所授等级初始化点数（periodic 用该档 pointsRefresh，permanent 用全局 pointsDefault）
   * - tierEnabled 关闭时 Lv2+ 授予被拒绝（等级功能未启用）
   * 返回 { renewed, expiry, tier }
   */
  async grantMembershipCard(userId: string, tier: number, days: number, grantedBy?: string): Promise<{ renewed: boolean; expiry: number; tier: number }> {
    this.ensureUserData(userId)
    const user = this.userData[userId]
    const now = Date.now()
    let safeTier = Math.min(Math.max(Math.round(tier), MIN_TIER), MAX_TIER)
    if (safeTier > 1 && this.config.tierEnabled === false) {
      safeTier = 1 // 等级功能未启用，回落 Lv1
    }
    const durationMs = days * 24 * 60 * 60 * 1000
    const prevTier = this.getActiveTier(userId)
    const wasActiveMember = prevTier > 0

    const cards = this.getCards(userId)
    const existing = cards.find(card => card.tier === safeTier && card.expiry > now)
    let renewed = false
    if (existing) {
      existing.expiry += durationMs
      renewed = true
    } else {
      const newCard: MembershipCard = { tier: safeTier, expiry: now + durationMs, grantedAt: now, grantedBy }
      const idx = cards.findIndex(card => card.tier === safeTier)
      if (idx >= 0) cards[idx] = newCard
      else cards.push(newCard)
    }

    // 低级卡联动：更低等级的有效卡同步延长相同天数（tierEnabled 关闭时不延长，避免卡时长被隐性修改）
    if (this.config.tierEnabled !== false) {
      let extended = 0
      for (const card of cards) {
        if (card.tier < safeTier && card.expiry > now) {
          card.expiry += durationMs
          extended++
        }
      }
      if (extended > 0) {
        this.ctx.logger.info(`[会员系统] 已同步延长用户 ${userId} 的 ${extended} 张更低等级会员卡 ${days} 天`)
      }
    }

    // 重算冗余字段（isMember / membershipExpiry / dailyLimit）
    this.checkAndResetDailyUsage(userId)

    // 点数处理（已开点数系统时）
    if (this.config.pointsEnabled) {
      if (!wasActiveMember) {
        // 首次成为会员 → 按所授等级初始化
        if (this.config.pointsMode === 'periodic') {
          const refreshAmount = this.getTierBenefit(safeTier).pointsRefresh
          user.points = refreshAmount
          this.ctx.logger.info(`[会员系统] 用户 ${userId} 首次成为 Lv${safeTier} 会员，点数已初始化为 ${refreshAmount}`)
        } else if (!user.points) {
          user.points = this.config.pointsDefault || 200
        }
      } else if (this.config.pointsMode === 'periodic' && safeTier > prevTier) {
        // 升档 → 按档位刷新量「差额」补点（累加而非置值，用户已充值/已获的点数不受影响）
        // 例：Lv1(200) → Lv2(1400) 差额 1200，用户余额 5000 → 6200
        const newRefresh = this.getTierBenefit(safeTier).pointsRefresh
        const oldRefresh = this.getTierBenefit(prevTier).pointsRefresh
        const diff = newRefresh - oldRefresh
        if (diff > 0) {
          const before = user.points || 0
          user.points = before + diff
          this.ctx.logger.info(`[会员系统] 用户 ${userId} 升级至 Lv${safeTier}，按档位差额补点 +${diff}（${before} → ${before + diff}）`)
        }
      }
    }

    await this.syncUserToDB(userId)
    await this.syncCardsToDB(userId)
    this.ctx.logger.info(`[会员系统] 已为用户 ${userId} ${renewed ? '续费' : '授予'} Lv${safeTier} 会员卡 ${days} 天${grantedBy ? `（操作人：${grantedBy}）` : ''}`)
    return { renewed, expiry: cards.find(card => card.tier === safeTier)!.expiry, tier: safeTier }
  }

  /**
   * 取消会员卡。
   * - tier 缺省 → 取消全部卡（含过期卡）
   * - tier 指定 → 仅取消该等级卡
   * 全部取消后用户降为非会员（复用现有降级规则：周期模式下点数清零）。
   */
  async cancelMembershipCards(userId: string, tier?: number): Promise<{ removed: number; remainingTier: number }> {
    const user = this.userData[userId]
    if (!user) return { removed: 0, remainingTier: 0 }

    const cards = this.getCards(userId)
    const before = cards.length
    const rest = tier ? cards.filter(card => card.tier !== tier) : []
    user.cards = rest
    const removed = before - rest.length

    const wasMember = user.isMember
    // 重算冗余字段与降级处理
    this.checkAndResetDailyUsage(userId)

    if (!user.isMember && wasMember) {
      // 与现有取消会员行为保持一致
      user.membershipExpiry = 0
      user.dailyLimit = this.config.nonMemberDailyLimit
      if (this.config.pointsEnabled && this.config.pointsMode === 'periodic' && !this.config.pointsRefreshIncludeNonMember) {
        user.points = 0
      }
      this.ctx.logger.info(`[会员系统] 用户 ${userId} 的全部会员卡已被取消，降为非会员`)
    }

    if (removed > 0) {
      await this.syncUserToDB(userId)
      await this.syncCardsToDB(userId)
      this.ctx.logger.info(`[会员系统] 已取消用户 ${userId} 的 ${removed} 张会员卡${tier ? `（Lv${tier}）` : ''}`)
    }
    return { removed, remainingTier: this.getActiveTier(userId) }
  }

  // 统计各等级有效持卡人数（按生效等级统计，一名用户只计入其最高档；tierEnabled 关闭时全部计入 Lv1）
  getActiveTierStats(): Dict<number> {
    const stats: Dict<number> = Object.create(null)
    for (const userId in this.userData) {
      let tier = this.computeActiveTier(this.userData[userId].cards || [])
      if (tier > 1 && this.config.tierEnabled === false) tier = 1
      if (tier > 0) stats[tier] = (stats[tier] || 0) + 1
    }
    return stats
  }

  // ========== 点数计算相关 ==========

  /**
   * 按 NovelAI 官网前端公式计算 Anlas。
   * 来源：novelai.net/_next/static/chunks/1052-*.js
   * SDXL / V4 / V4.5 / V5：
   *   M = ceil(2.951823174884865e-6 * pixels + 5.753298233447344e-7 * pixels * steps)
   *   M *= sm_dyn ? 1.4 : smea ? 1.2 : 1
   *   V5 再乘 1.5
   *   cost = max(ceil(M * strength), 2)
   * Opus 免费：像素 ≤ 1048576、步数 ≤ 28 时基础生图为 0。
   * 精准参考（Precise Reference）不取消免费档，只在基础价之外每张 +5。
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
    chargeOpusFreeRange?: boolean
    model?: string
  }): number {
    if (!this.config.pointsEnabled) return 0

    const {
      width, height, steps,
      smea = false, smeaDyn = false,
      strength = 1, isImg2Img = false,
      preciseRefCount = 0,
      chargeOpusFreeRange = false,
      model,
    } = params

    let pixels = width * height
    if (pixels < 65536) pixels = 65536

    // 官网 Opus 免费档只看分辨率和步数；精准参考是额外附加费，不取消免费
    const opusFree = !chargeOpusFreeRange
      && pixels <= 1048576
      && steps <= 28
    const extraRefCost = preciseRefCount * 5
    if (opusFree) return extraRefCost

    let L = Math.ceil(2.951823174884865e-6 * pixels + 5.753298233447344e-7 * pixels * steps)

    // SMEA/DYN 加成写在 ceil 之外，与官网一致
    if (smeaDyn) L *= 1.4
    else if (smea) L *= 1.2

    if (this.isNai5Model(model)) L *= 1.5

    const resolvedStrength = isImg2Img ? strength : 1
    L = Math.max(Math.ceil(L * resolvedStrength), 2)

    // 精准参考额外消耗：每张参考图 +5，不取消 Opus 免费档
    L += extraRefCost

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
   * 批量给所有用户加减点数。
   * @param tierFilter 指定生效等级时仅操作该等级会员；缺省对所有（会员）操作
   */
  async addPointsToAll(amount: number, membersOnly: boolean = true, tierFilter?: number): Promise<{ count: number; message: string }> {
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

      // 按生效等级过滤
      if (tierFilter !== undefined) {
        if (this.getActiveTier(userId) !== tierFilter) continue
      }

      user.points = Math.max((user.points || 0) + amount, 0)
      updatedCount++
    }

    if (updatedCount > 0) {
      await this.saveUserData()
    }

    const action = amount >= 0 ? '增加' : '扣除'
    const scope = tierFilter !== undefined ? `Lv${tierFilter} 会员` : (membersOnly ? '会员' : '用户')
    const message = updatedCount > 0
      ? `✅ 成功为 ${updatedCount} 位用户${action} ${Math.abs(amount)} 点数`
      : `⚠️ 没有符合条件的用户`

    return { count: updatedCount, message }
  }

  /**
   * 刷新点数（定期任务 / 手动触发）。
   * 等级制度下按刷新时刻的生效等级取刷新量：Lv1 = pointsRefreshAmount，Lv2-Lv5 = 各档 pointsRefresh；
   * 非会员若在刷新范围内，刷为 Lv1 档值（与现有行为一致）。
   * @param tierFilter 指定生效等级时仅刷新该等级会员；缺省刷新全部范围
   */
  async refreshPoints(tierFilter?: number): Promise<{ count: number; message: string }> {
    if (!this.config.pointsEnabled || this.config.pointsMode !== 'periodic') {
      return { count: 0, message: '点数刷新未启用或不是周期模式' }
    }

    let refreshedCount = 0
    const now = Date.now()

    for (const userId in this.userData) {
      const user = this.userData[userId]

      let tier = this.computeActiveTier(user.cards || [])
      if (tier > 1 && this.config.tierEnabled === false) tier = 1
      const isActive = tier > 0

      // 检查是否在刷新范围内
      if (!this.config.pointsRefreshIncludeNonMember && !isActive) {
        continue
      }

      // 按生效等级过滤
      if (tierFilter !== undefined && tier !== tierFilter) continue

      // 按生效等级取刷新量；非会员（范围包含时）刷为 Lv1 档值
      user.points = this.getTierBenefit(tier > 0 ? tier : 1).pointsRefresh
      refreshedCount++
    }

    this.lastPointsRefreshTime = now
    await this.saveLastPointsRefreshTime()

    if (refreshedCount > 0) {
      await this.saveUserData()
    }

    const scope = tierFilter !== undefined ? `Lv${tierFilter} 会员` : '用户'
    const message = refreshedCount > 0
      ? `✅ 点数刷新完成，共刷新 ${refreshedCount} 位${scope}的点数（按各自生效等级）`
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
   * 从 JSON 文件导入数据到数据库。
   * 支持两种格式：
   * - 旧格式：isMember + membershipExpiry → 自动生成 Lv1 卡
   * - 新格式：cards: [{ tier, expiry, grantedAt?, grantedBy? }]
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

          // 解析会员卡：优先使用新格式 cards，否则从 isMember + membershipExpiry 生成 Lv1 卡
          let cards: MembershipCard[] = []
          if (Array.isArray(user.cards) && user.cards.length > 0) {
            cards = user.cards
              .filter((card: any) => card && typeof card.tier === 'number' && typeof card.expiry === 'number')
              .map((card: any) => ({
                tier: Math.min(Math.max(Math.round(card.tier), MIN_TIER), MAX_TIER),
                expiry: card.expiry,
                grantedAt: card.grantedAt || Date.now(),
                grantedBy: card.grantedBy || 'import',
              }))
          } else if (user.isMember) {
            cards = [{ tier: 1, expiry: user.membershipExpiry || 0, grantedAt: Date.now(), grantedBy: 'import' }]
          }

          // 周期模式下的初始点数：取生效等级的刷新量；无有效会员卡则给 0
          const now = Date.now()
          const activeTier = this.computeActiveTier(cards)
          const importedPoints = user.points !== undefined
            ? user.points
            : (activeTier > 0
              ? (this.config.pointsMode === 'periodic' ? this.getTierBenefit(activeTier).pointsRefresh : defaultPoints)
              : 0)

          this.userData[userId] = {
            isMember: activeTier > 0,
            membershipExpiry: activeTier > 0 ? Math.max(...cards.filter(c => c.expiry > now).map(c => c.expiry)) : (user.membershipExpiry || 0),
            dailyUsage: user.dailyUsage || 0,
            lastUsed: user.lastUsed || 0,
            dailyLimit: activeTier > 0 ? this.getTierBenefit(activeTier).dailyLimit : this.config.nonMemberDailyLimit,
            lastDrawTime: user.lastDrawTime || 0,
            points: importedPoints,
            nai5DailyUsage: user.nai5DailyUsage || 0,
            cards,
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
        await this.saveAllCards()
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

  // 清理过期会员信息（按卡粒度：只删过期卡；名下已无任何有效卡的用户按原规则删除）
  async cleanupExpiredMembers() {
    if (!this.config.membershipEnabled || !this.config.memberCleanupEnabled) return

    const now = Date.now()
    let cleanedMemberCount = 0
    let cleanedCardCount = 0
    let cleanedNonMemberCount = 0

    // 计算非会员的不活跃阈值时间
    const inactiveThreshold = this.config.nonMemberInactiveDays * 24 * 60 * 60 * 1000

    for (const userId in this.userData) {
      const user = this.userData[userId]
      const cards = user.cards || []
      const validCards = cards.filter(card => card.expiry > now)

      // 有效会员：修剪过期卡后保留用户行
      if (validCards.length > 0) {
        if (validCards.length < cards.length) {
          user.cards = validCards
          try {
            await this.syncCardsToDB(userId)
          } catch (err) {
            this.ctx.logger.error(`清理用户 ${userId} 的过期卡失败`, err)
          }
          cleanedCardCount++
          this.ctx.logger.info(`已清理用户 ${userId} 的过期会员卡（保留 Lv${Math.max(...validCards.map(c => c.tier))}）`)
        }
        continue
      }

      // 无任何有效卡：
      const wasMember = user.isMember || cards.length > 0

      if (wasMember) {
        // 过期会员（名下卡已全部过期，或旧数据的 isMember 标记）→ 删除用户行
        delete this.userData[userId]
        try {
          await this.ctx.database.remove('hhs_huatu_user', { visitorId: userId })
          await this.ctx.database.remove('hhs_huatu_membership_cards', { visitorId: userId })
        } catch (err) {
          this.ctx.logger.error(`从数据库删除用户 ${userId} 失败`, err)
        }
        cleanedMemberCount++
        this.ctx.logger.info(`已清理过期会员信息: ${userId}`)
      } else if (this.config.cleanupNonMembers) {
        // 非会员：按不活跃策略清理
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
            await this.ctx.database.remove('hhs_huatu_membership_cards', { visitorId: userId })
          } catch (err) {
            this.ctx.logger.error(`从数据库删除非会员 ${userId} 失败`, err)
          }
          cleanedNonMemberCount++
          this.ctx.logger.info(`已清理非会员信息: ${userId}`)
        }
      }
    }

    const totalCleaned = cleanedMemberCount + cleanedCardCount + cleanedNonMemberCount

    if (totalCleaned > 0) {
      this.ctx.logger.info(`用户信息清理完成，共处理 ${totalCleaned} 条（过期会员: ${cleanedMemberCount}，过期卡: ${cleanedCardCount}，非会员: ${cleanedNonMemberCount}）`)
    } else {
      if (this.config.debugLog) this.ctx.logger.info('用户信息清理完成，无需清理的记录')
    }
  }

  // 检查并提醒即将到期的会员（按卡粒度，每张即将到期的卡单独提醒）
  async checkAndRemindExpiringMembers() {
    if (!this.config.membershipEnabled || !this.config.memberExpiryReminderEnabled) return

    if (!this.config.memberReminderGroups || this.config.memberReminderGroups.length === 0) {
      if (this.config.debugLog) this.ctx.logger.info('未配置会员提醒群组，跳过提醒检查')
      return
    }

    const now = Date.now()
    const reminderThreshold = this.config.memberReminderHours * 60 * 60 * 1000
    const expiringMembers: Array<{ userId: string; tier: number; remainingHours: number; expiry: number }> = []

    for (const userId in this.userData) {
      const user = this.userData[userId]
      for (const card of user.cards || []) {
        if (card.expiry > now) {
          const remainingTime = card.expiry - now
          if (remainingTime <= reminderThreshold) {
            const remainingHours = Math.ceil(remainingTime / (60 * 60 * 1000))
            expiringMembers.push({ userId, tier: card.tier, remainingHours, expiry: card.expiry })
          }
        }
      }
    }

    if (expiringMembers.length > 0) {
      this.ctx.logger.info(`发现 ${expiringMembers.length} 张会员卡即将到期，将发送到配置的群组`)

      let message = '【会员到期提醒】\n以下会员卡即将到期：\n\n'
      expiringMembers.forEach((member, index) => {
        const expireDate = new Date(member.expiry).toLocaleString()
        message += `${index + 1}. <at id="${member.userId}"/> 的 Lv${member.tier} 会员卡\n   剩余时间: ${member.remainingHours} 小时\n   到期时间: ${expireDate}\n\n`
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

  // 给所有有效会员卡增加天数（按卡粒度，每张有效卡独立延长）。
  // @param tierFilter 指定生效等级时仅操作该等级会员；缺省操作全部会员
  async addDaysToAllMembers(days: number, tierFilter?: number): Promise<{ success: boolean; count: number; message: string }> {
    if (!this.config.membershipEnabled) {
      return { success: false, count: 0, message: '会员系统未启用' }
    }

    const now = Date.now()
    let updatedCount = 0
    const daysInMs = days * 24 * 60 * 60 * 1000

    for (const userId in this.userData) {
      const user = this.userData[userId]

      // 按生效等级过滤
      if (tierFilter !== undefined && this.getActiveTier(userId) !== tierFilter) continue

      let touched = false
      for (const card of user.cards || []) {
        if (card.expiry > now) {
          card.expiry += daysInMs
          updatedCount++
          touched = true
        }
      }
      if (touched) {
        // 重算冗余字段（生效卡到期时间可能变化）
        this.checkAndResetDailyUsage(userId)
        await this.syncUserToDB(userId)
        await this.syncCardsToDB(userId)
        this.ctx.logger.info(`已为用户 ${userId} 的全部有效会员卡增加 ${days} 天`)
      }
    }

    const scope = tierFilter !== undefined ? `Lv${tierFilter} 会员` : ''
    const message = updatedCount > 0
      ? `✅ 成功为 ${updatedCount} 张有效会员卡增加 ${days} 天会员时长${scope ? `（${scope}）` : ''}`
      : '⚠️ 当前没有有效会员卡可增加天数'

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
        nai5DailyUsage: 0,
        cards: [],
      }
    }
    if (!this.userData[userId].cards) this.userData[userId].cards = []
  }

  // 检查并重置每日使用次数；同时按会员卡维护会员状态（冗余字段 + 降级处理）
  checkAndResetDailyUsage(userId: string) {
    this.ensureUserData(userId)

    const user = this.userData[userId]

    const now = new Date()
    const lastUsed = new Date(user.lastUsed)

    // 如果不是同一天，重置使用次数
    if (now.getDate() !== lastUsed.getDate() ||
      now.getMonth() !== lastUsed.getMonth() ||
      now.getFullYear() !== lastUsed.getFullYear()) {
      user.dailyUsage = 0
      user.nai5DailyUsage = 0
    }

    // ========== 会员卡状态维护（等级制度） ==========
    // 过期卡在计算生效等级时被逻辑忽略；物理清理交给定时清理任务，便于区分「过期会员」
    const nowMs = Date.now()
    const validCards = (user.cards || []).filter(card => card.expiry > nowMs)
    let activeTier = this.computeActiveTier(validCards)
    // tierEnabled 关闭时高等级卡不产生权益：生效等级视为 Lv1
    if (activeTier > 1 && this.config.tierEnabled === false) activeTier = 1
    const wasMember = user.isMember

    if (activeTier > 0) {
      // 仍有有效卡：权益按生效等级（已按开关 clamp）；membershipExpiry = 全部有效卡中最远的到期时间（「会员资格」整体到期）
      user.isMember = true
      user.membershipExpiry = Math.max(...validCards.map(card => card.expiry))
      user.dailyLimit = this.getTierBenefit(activeTier).dailyLimit
    } else {
      // 无任何有效卡
      user.isMember = false
      user.dailyLimit = this.config.nonMemberDailyLimit
      if (wasMember) {
        // 由会员降级为非会员：清空冗余到期时间，并按现有规则处理点数
        user.membershipExpiry = 0
        if (this.config.pointsEnabled && this.config.pointsMode === 'periodic' && !this.config.pointsRefreshIncludeNonMember) {
          user.points = 0
        }
        this.ctx.logger.info(`[会员系统] 用户 ${userId} 的会员卡已全部到期，降为非会员`)
      }
    }
  }

  // 检查用户是否可以使用画图功能（会员的限额/CD 按生效等级取值）
  canUseDrawing(userId: string, session: Session): boolean | string {
    if (!this.config.membershipEnabled) return true

    this.checkAndResetDailyUsage(userId)

    const user = this.userData[userId]

    // 检查会员状态和使用次数
    if (user.isMember) {
      // 会员用户：按生效等级权益判定
      const benefit = this.getMemberBenefit(userId)

      if (benefit && benefit.dailyLimit > 0 && user.dailyUsage >= benefit.dailyLimit) {
        return session.text('commands.novelai.messages.member-daily-limit-reached', [benefit.dailyLimit])
      }

      // 检查会员CD时间
      if (benefit && benefit.cooldown > 0 && user.lastDrawTime) {
        const now = Date.now()
        const cooldownMs = benefit.cooldown * 1000
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

  // 当前用户是否为未过期会员
  isActiveMember(userId: string): boolean {
    this.checkAndResetDailyUsage(userId)
    const user = this.userData[userId]
    return !!user?.isMember && user.membershipExpiry > Date.now()
  }

  // nai5 / nai5c 会消耗 NovelAI 配额，可配置为仅会员可用
  canUseNai5(userId: string, session: Session, model?: string): boolean | string {
    if (!this.config.membershipEnabled || !this.config.nai5MemberOnly) return true
    if (!isNovelAIV5Model(modelMap[model] || model)) return true
    if (this.isActiveMember(userId)) return true
    return session.text('commands.novelai.messages.nai5-member-only')
  }

  isNai5Model(model?: string): boolean {
    return isNovelAIV5Model(modelMap[model] || model)
  }

  /**
   * 获取用户生效等级的 nai5 / nai5c 每日免费限额。
   * - 传入 userId：Lv1 = 配置字段 memberNai5DailyLimit，Lv2-Lv5 = tierBenefits；非会员返回 0
   * - 不传 userId：返回 Lv1 档值（兼容无上下文的调用）
   * 0 表示不额外限制（全部走 Opus 免费档）。
   */
  getNai5DailyLimit(userId?: string): number {
    if (!userId) return this.getTierBenefit(1).nai5DailyLimit
    const tier = this.getActiveTier(userId)
    if (tier <= 0) return 0
    return this.getTierBenefit(tier).nai5DailyLimit
  }

  getNai5DailyUsage(userId: string): number {
    this.checkAndResetDailyUsage(userId)
    return this.userData[userId]?.nai5DailyUsage || 0
  }

  /**
   * 本次 nai5 任务中，超出会员免费日限、需要按 Anlas 计费的张数。
   * 日限按用户生效等级取值；日限为 0 表示不额外限制，全部走 Opus 免费档（标准分辨率不扣点）。
   */
  getNai5OverageCount(userId: string, drawCount: number = 1): number {
    if (!this.config.membershipEnabled) return 0
    const limit = this.getNai5DailyLimit(userId)
    if (limit <= 0 || drawCount <= 0) return 0
    if (!this.isActiveMember(userId)) return 0

    const used = this.getNai5DailyUsage(userId) + (this.pendingNai5Usage[userId] || 0)
    return Math.min(drawCount, Math.max(0, used + drawCount - limit))
  }

  shouldChargeNai5Overage(userId: string, model?: string, drawCount: number = 1): boolean {
    return this.isNai5Model(model) && this.getNai5OverageCount(userId, drawCount) > 0
  }

  reserveNai5Usage(userId: string, count: number) {
    if (!this.config.membershipEnabled || count <= 0) return
    this.pendingNai5Usage[userId] = (this.pendingNai5Usage[userId] || 0) + count
  }

  releaseNai5Usage(userId: string, count: number) {
    if (count <= 0) return
    const current = this.pendingNai5Usage[userId] || 0
    const next = Math.max(0, current - count)
    if (next) this.pendingNai5Usage[userId] = next
    else delete this.pendingNai5Usage[userId]
  }

  // 增加用户使用次数
  incrementUsage(userId: string, drawCount: number = 1, model?: string, nai5Count?: number) {
    if (!this.config.membershipEnabled) return

    const now = Date.now()

    this.ensureUserData(userId)

    // 跨零点完成的任务：累加前先按日期滚动清零上一日的计数。
    // 否则下方 lastUsed = now 会把「最后使用日」更新为新的一天，
    // checkAndResetDailyUsage 的惰性重置（对比 lastUsed 日期）当天不再触发，
    // 昨天的 dailyUsage / nai5DailyUsage 会被整日带入新的一天。
    this.checkAndResetDailyUsage(userId)

    this.userData[userId].dailyUsage += drawCount
    this.userData[userId].lastUsed = now
    if (this.isNai5Model(model)) {
      const add = nai5Count ?? drawCount
      this.userData[userId].nai5DailyUsage = (this.userData[userId].nai5DailyUsage || 0) + add
      this.releaseNai5Usage(userId, add)
    }

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
