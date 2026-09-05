// 会员系统命令（查询/授予/取消会员、点数管理）与调试命令
import { Context } from 'koishi'
import { Config } from '../config'
import { Runtime } from '../runtime'

export function registerMember(ctx: Context, config: Config, runtime: Runtime) {
  const { membershipSystem, userData } = runtime
  // 会员系统命令
  ctx.command('novelai.member')
    .userFields(['authority'])
    .alias('会员')
    .option('user', '-u <user:string>')
    .option('days', '-d <days:number>')
    .option('tier', '-t <tier:number>')
    .option('addPoints', '-a <points:number>')
    .option('refreshPoints', '-f')
    .option('cancel', '-c')
    .option('list', '-l ')
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

      // 等级参数校验（仅在与 -d / -c / -l 同时使用时生效）
      const tierFilter = options.tier
      if (tierFilter !== undefined && (tierFilter < 1 || tierFilter > 5 || !Number.isInteger(tierFilter))) {
        return '会员等级必须是 1-5 之间的整数（Lv1-Lv5）'
      }

      // 列出所有未过期的会员（显示生效等级，支持 -t 过滤）
      if (options.list) {
        // 需要管理员权限
        if (session.user.authority < config.membershipAuthLv) {
          return '您没有权限查看所有会员信息'
        }

        const now = Date.now()
        const activeMembers: Array<{ id: string; tier: number; remainingDays: number; expiry: number }> = []

        // 遍历所有用户数据，筛选出有有效会员卡的用户
        for (const id in userData) {
          const tier = membershipSystem.getActiveTier(id)
          if (tier <= 0) continue
          if (tierFilter !== undefined && tier !== tierFilter) continue
          // 生效卡中最近的到期时间（同档取最远）
          const validCards = userData[id].cards.filter(card => card.expiry > now)
          const expiry = Math.max(...validCards.filter(card => card.tier === tier).map(card => card.expiry))
          const remainingDays = Math.ceil((expiry - now) / (24 * 60 * 60 * 1000))
          activeMembers.push({ id, tier, remainingDays, expiry })
        }

        if (activeMembers.length === 0) {
          return tierFilter !== undefined ? `当前没有生效等级为 Lv${tierFilter} 的会员` : '当前没有有效会员'
        }

        // 各等级数量提示（按等级从高到低，只列出有人的等级）
        const tierCount: Record<number, number> = {}
        for (const m of activeMembers) tierCount[m.tier] = (tierCount[m.tier] || 0) + 1
        const tierParts = Object.keys(tierCount)
          .map(Number)
          .sort((a, b) => b - a)
          .map(t => `Lv${t} ${tierCount[t]}个`)

        // 按等级降序、剩余天数升序排序
        activeMembers.sort((a, b) => (b.tier - a.tier) || (a.remainingDays - b.remainingDays))

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
        let result = `当前共有 ${activeMembers.length} 个有效会员`;
        if (tierParts.length) result += `，${tierParts.join('，')}`;
        result += `（第 ${currentPage}/${totalPages} 页）：\n\n`;
        membersOnPage.forEach((member, index) => {
          const expireDate = new Date(member.expiry).toLocaleString();
          const globalIndex = startIndex + index + 1;
          result += `${globalIndex}. 用户ID: ${member.id}（Lv${member.tier}）\n   剩余天数: ${member.remainingDays} 天\n   到期时间: ${expireDate}\n\n`;
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
      if ((options.days || options.cancel || options.addPoints !== undefined || options.refreshPoints) && session.user.authority < config.membershipAuthLv) {
        return '您没有权限设置会员状态'
      }

      // 检查并重置每日使用次数
      membershipSystem.checkAndResetDailyUsage(targetId)

      // 如果是刷新点数（按生效等级取刷新量）
      if (options.refreshPoints) {
        if (!config.pointsEnabled) {
          return '点数控制未启用'
        }
        if (config.pointsMode !== 'periodic') {
          return '当前点数模式为永久模式，无需刷新'
        }
        if (!userData[targetId]) {
          return `用户 ${targetId} 暂无使用记录，无法刷新点数`
        }
        if (!config.pointsRefreshIncludeNonMember) {
          if (!membershipSystem.isActiveMember(targetId)) {
            return `刷新范围不包含非会员，无法为该用户刷新点数`
          }
        }
        const tier = membershipSystem.getActiveTier(targetId)
        const refreshAmount = membershipSystem.getTierBenefit(tier > 0 ? tier : 1).pointsRefresh
        userData[targetId].points = refreshAmount
        // 保存用户数据
        await membershipSystem.saveUserData()
        return `已刷新用户 ${targetId} 的点数（Lv${tier > 0 ? tier : 1} 档），当前剩余：${refreshAmount}`
      }

      // 如果是添加点数
      if (options.addPoints !== undefined) {
        if (!Number.isInteger(options.addPoints)) {
          return '点数必须是整数'
        }
        if (!userData[targetId]) {
          return `用户 ${targetId} 暂无使用记录，无法添加点数`
        }
        userData[targetId].points = (userData[targetId].points || 0) + options.addPoints
        // 保存用户数据
        await membershipSystem.saveUserData()
        const action = options.addPoints >= 0 ? '增加' : '扣除'
        return `已为用户 ${targetId} ${action} ${Math.abs(options.addPoints)} 点数，当前剩余：${userData[targetId].points}`
      }

      // 如果是取消会员（-c 全部取消；-c -t n 仅取消该等级卡）
      if (options.cancel) {
        if (!userData[targetId]) {
          return '该用户不存在会员记录'
        }

        const { removed, remainingTier } = await membershipSystem.cancelMembershipCards(targetId, tierFilter)

        if (removed === 0) {
          return tierFilter !== undefined
            ? `用户 ${targetId} 没有 Lv${tierFilter} 会员卡`
            : '该用户没有可取消的会员卡'
        }

        const scope = tierFilter !== undefined ? `Lv${tierFilter} 会员卡` : '全部会员卡'
        return remainingTier > 0
          ? `已取消用户 ${targetId} 的${scope}，当前生效等级：Lv${remainingTier}`
          : `已取消用户 ${targetId} 的${scope}，该用户已恢复为普通用户`
      }

      // 如果是授予/续费会员卡（-d 天数，-t 等级缺省为 1）
      if (options.days) {
        const tier = tierFilter ?? 1
        if (tier < 1 || tier > 5 || !Number.isInteger(tier)) {
          return '会员等级必须是 1-5 之间的整数（Lv1-Lv5）'
        }
        if (tier > 1 && !config.tierEnabled) {
          return '会员等级功能未启用，请在插件配置「会员等级设置」中打开 tierEnabled 后再授予 Lv2-Lv5'
        }

        const result = await membershipSystem.grantMembershipCard(targetId, tier, options.days, userId)
        const expireDate = new Date(result.expiry).toLocaleString()
        return result.renewed
          ? `已为用户 ${targetId} 的 Lv${result.tier} 会员卡增加 ${options.days} 天，到期时间：${expireDate}`
          : `已为用户 ${targetId} 设置 Lv${result.tier} 会员卡 ${options.days} 天，到期时间：${expireDate}`
      }

      // 查询会员状态
      const isQueryingSelf = targetId === userId
      const activeTier = membershipSystem.getActiveTier(targetId)

      if (!userData[targetId] || (!activeTier && !userData[targetId].cards?.length && !userData[targetId].isMember && (userData[targetId].dailyUsage || 0) === 0)) {
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

      if (activeTier > 0) {
        const benefit = membershipSystem.getTierBenefit(activeTier)
        const now = Date.now()

        // 卡片明细
        let cardsInfo = ''
        const sortedCards = (user.cards || [])
          .filter(card => card.expiry > now)
          .sort((a, b) => b.tier - a.tier)
        for (const card of sortedCards) {
          const expireDate = new Date(card.expiry).toLocaleString()
          const remainingDays = Math.ceil((card.expiry - now) / (24 * 60 * 60 * 1000))
          cardsInfo += `\n  Lv${card.tier} 会员卡：到期 ${expireDate}（剩余 ${remainingDays} 天）`
        }

        let usageInfo = ''
        if (benefit.dailyLimit > 0) {
          const remaining = benefit.dailyLimit - user.dailyUsage
          if (isQueryingSelf) {
            usageInfo = session.text('commands.novelai.messages.tier-active', [
              activeTier,
              benefit.dailyLimit,
              remaining
            ])
          } else {
            usageInfo = `用户 ${targetId} 是 Lv${activeTier} 会员\n每日限额：${benefit.dailyLimit} 次，剩余：${remaining} 次`
          }
        } else {
          if (isQueryingSelf) {
            usageInfo = session.text('commands.novelai.messages.tier-active-unlimited', [activeTier])
          } else {
            usageInfo = `用户 ${targetId} 是 Lv${activeTier} 会员，可无限次使用`
          }
        }

        let nai5Info = ''
        if (benefit.nai5DailyLimit > 0) {
          const bucketInfo = membershipSystem.getNai5BucketInfo(targetId)
          if (bucketInfo) {
            // 周桶模式：展示桶余额 / 上限 / 每日入桶
            nai5Info = `\nnai5/nai5c 免费次数余额：${bucketInfo.balance} / 上限 ${bucketInfo.cap} 次（每日到账 ${bucketInfo.dailyLimit} 次，最多累积 7 天）`
            if (config.pointsEnabled && bucketInfo.balance === 0) {
              nai5Info += '（用完后按 Anlas 估算扣点）'
            }
          } else {
            const nai5Used = user.nai5DailyUsage || 0
            const nai5Remaining = Math.max(0, benefit.nai5DailyLimit - nai5Used)
            nai5Info = `\nnai5/nai5c 今日免费：${benefit.nai5DailyLimit} 次，已用 ${nai5Used} 次，剩余 ${nai5Remaining} 次`
            if (config.pointsEnabled && nai5Remaining === 0) {
              nai5Info += '（超出后按 Anlas 估算扣点）'
            }
          }
        }

        let pointsInfo = ''
        if (config.pointsEnabled) {
          const points = user.points || 0
          pointsInfo = `\n点数余额：${points}`
          if (config.pointsMode === 'periodic') {
            const remainDaysRefresh = membershipSystem.getDaysUntilNextRefresh()
            if (remainDaysRefresh >= 0) {
              pointsInfo += `\n下次点数刷新时间：${remainDaysRefresh}天后（Lv${activeTier} 档刷新为 ${benefit.pointsRefresh} 点）`
            }
          }
        }

        return `${usageInfo}\n持有会员卡：${cardsInfo}${nai5Info}${pointsInfo}`
      } else {
        const remaining = config.nonMemberDailyLimit - user.dailyUsage

        let pointsInfo = ''
        if (config.pointsEnabled) {
          pointsInfo = `\n点数余额：${user.points || 0}`
          if (config.pointsMode === 'periodic' && config.pointsRefreshIncludeNonMember) {
            const remainDaysRefresh = membershipSystem.getDaysUntilNextRefresh()
            if (remainDaysRefresh >= 0) {
              pointsInfo += `\n下次点数刷新时间：${remainDaysRefresh}天后`
            }
          }
        }

        if (isQueryingSelf) {
          return session.text('commands.novelai.messages.non-member-usage', [
            config.nonMemberDailyLimit,
            user.dailyUsage,
            remaining
          ]) + pointsInfo
        } else {
          return `用户 ${targetId} 是非会员\n每日限额：${config.nonMemberDailyLimit} 次\n已使用：${user.dailyUsage} 次\n剩余：${remaining} 次${pointsInfo}`
        }
      }
    })

  // 会员系统调试指令（仅在启用时注册）
  if (config.memberDebugCommandEnabled) {
    ctx.command('novelai.member-debug', '会员系统调试指令', { authority: config.memberDebugCommandAuthLv })
      .alias('会员调试')
      .option('cleanup', '-c 立即执行会员信息清理')
      .option('remind', '-r 立即执行会员到期提醒')
      .option('status', '-s 查看定时任务状态')
      .option('resetUsage', '-u <userId:string> 重置指定用户的使用次数')
      .option('addDaysAll', '-a <days:number> 给会员增加天数（配合 -t 仅操作指定等级）')
      .option('tier', '-t <tier:number> 指定生效等级（Lv1-Lv5），缺省对所有会员操作')
      .option('refreshPoints', '-f 立即执行点数刷新（配合 -t 仅刷新指定等级）')
      .option('addPoints', '--add-points <amount:number> 给会员加点数（配合 -t 仅操作指定等级）')
      .option('subPoints', '--sub-points <amount:number> 给会员减点数（配合 -t 仅操作指定等级）')
      .option('setPoints', '--set-points <value:string> 设置指定用户点数，格式: 用户ID:点数')
      .option('addBucket', '--add-bucket [days:number] 给会员赠送免费次数（发福利：每人按各自档位每日额度 × 天数到账，受 7 天上限约束；配合 -t 指定等级、--bucket-user 指定单人）')
      .option('bucketUser', '--bucket-user <userId:string> 配合 --add-bucket 仅给指定用户赠送')
      .option('setBucket', '--set-bucket <value:string> 设置指定用户免费次数余额，格式: 用户ID:次数')
      .option('importData', '--import 从 JSON 文件导入数据')
      .action(async ({ session, options }) => {
        // 如果会员系统未启用
        if (!config.membershipEnabled) {
          return '会员系统未启用'
        }

        // 等级参数校验（配合批量操作使用）
        const debugTierFilter = options.tier
        if (debugTierFilter !== undefined) {
          if (debugTierFilter < 1 || debugTierFilter > 5 || !Number.isInteger(debugTierFilter)) {
            return '会员等级必须是 1-5 之间的整数（Lv1-Lv5）'
          }
          if (!config.tierEnabled && debugTierFilter > 1) {
            return '会员等级功能未启用（tierEnabled 已关闭），无法按 Lv2-Lv5 过滤操作'
          }
        }

        // 给会员增加天数（无 -t 对所有会员，有 -t 仅对该等级会员）
        if (options.addDaysAll !== undefined) {
          const days = options.addDaysAll
          const scope = debugTierFilter !== undefined ? `Lv${debugTierFilter} 会员` : '所有会员'
          await session.send(`正在为${scope}增加 ${days} 天会员时长...`)
          const result = await membershipSystem.addDaysToAllMembers(days, debugTierFilter)
          return result.message
        }

        // 周桶补桶（发福利：每人按各自生效档日限 × 天数入桶，满桶溢出作废）
        if (options.addBucket !== undefined) {
          if (!config.nai5WeeklyBucketEnabled) {
            return '❌ 周额度模式未启用（需在配置中开启「周额度模式」）'
          }
          const days = options.addBucket || 1
          const scope = options.bucketUser
            ? `用户 ${options.bucketUser}`
            : (debugTierFilter !== undefined ? `Lv${debugTierFilter} 会员` : '所有有效会员')
          await session.send(`正在为${scope}赠送 ${days} 天免费次数...`)
          const result = await membershipSystem.addBucketDaysToAllMembers(days, debugTierFilter, options.bucketUser)
          return result.message
        }

        // 设置指定用户周桶余额
        if (options.setBucket !== undefined) {
          if (!config.nai5WeeklyBucketEnabled) {
            return '❌ 周额度模式未启用（需在配置中开启「周额度模式」）'
          }
          const parts = options.setBucket.split(':')
          if (parts.length !== 2) {
            return '❌ 格式错误，请使用格式: 用户ID:次数\n例如: --set-bucket 123456:140'
          }
          const [bucketUserId, bucketStr] = parts
          const amount = parseInt(bucketStr)
          if (isNaN(amount) || amount < 0) {
            return '❌ 余额必须为非负整数'
          }
          const result = await membershipSystem.setNai5Bucket(bucketUserId, amount)
          return result.message
        }

        // 重置指定用户的使用次数
        if (options.resetUsage) {
          const targetId = options.resetUsage
          if (!userData[targetId]) {
            return `用户 ${targetId} 不存在`
          }
          userData[targetId].dailyUsage = 0
          userData[targetId].nai5DailyUsage = 0
          await membershipSystem.saveUserData()
          const user = userData[targetId]
          const tier = membershipSystem.getActiveTier(targetId)
          const benefit = membershipSystem.getTierBenefit(tier > 0 ? tier : 1)
          const dailyLimit = tier > 0 ? benefit.dailyLimit : config.nonMemberDailyLimit
          const remaining = dailyLimit === 0 ? '无限' : dailyLimit - user.dailyUsage
          const nai5Limit = tier > 0 ? benefit.nai5DailyLimit : 0
          const bucketInfo = membershipSystem.getNai5BucketInfo(targetId)
          const nai5Line = bucketInfo
            ? `\nnai5/nai5c 免费次数余额：${bucketInfo.balance} / 上限 ${bucketInfo.cap} 次（每日到账 ${bucketInfo.dailyLimit} 次）`
            : nai5Limit > 0
              ? `\nnai5/nai5c 每日免费：${nai5Limit} 次\nnai5 已使用：${user.nai5DailyUsage || 0} 次`
              : ''

          return `✅ 已重置用户 ${targetId} 的使用次数\n` +
            `当前状态：${tier > 0 ? `Lv${tier} 会员` : '非会员'}\n` +
            `每日限额：${dailyLimit === 0 ? '无限制' : dailyLimit + ' 次'}\n` +
            `已使用：${user.dailyUsage} 次\n` +
            `剩余：${remaining}${typeof remaining === 'string' ? '' : ' 次'}` + nai5Line

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

          // 各等级持卡统计（按生效等级）
          statusMsg += `\n【等级分布】\n`
          statusMsg += `等级制度：${config.tierEnabled ? '已启用' : '未启用（所有会员按 Lv1 生效）'}\n`
          statusMsg += `周额度模式：${config.nai5WeeklyBucketEnabled ? '已启用（免费次数当天不清零，最多累积 7 天）' : '未启用（每日免费次数当天清零）'}\n`
          const tierStats = membershipSystem.getActiveTierStats()
          for (let tier = 1; tier <= 5; tier++) {
            const benefit = membershipSystem.getTierBenefit(tier)
            const count = tierStats[tier] || 0
            const tag = !config.tierEnabled && tier > 1 ? '（未启用）' : ''
            statusMsg += `Lv${tier}：${count} 人（nai5 ${benefit.nai5DailyLimit} 次/天 · 刷新 ${benefit.pointsRefresh} 点）${tag}\n`
          }

          // 点数系统状态
          if (config.pointsEnabled) {
            statusMsg += `\n【点数系统】\n`
            statusMsg += `✅ 点数控制：已启用\n`
            statusMsg += `   点数模式：${config.pointsMode === 'periodic' ? '按周期刷新' : '永久点数'}\n`
            if (config.pointsMode === 'periodic') {
              statusMsg += `   刷新周期：${config.pointsRefreshCycleDays || 30} 天\n`
              statusMsg += `   刷新点数：${config.pointsRefreshAmount || 200}\n`
              statusMsg += `   刷新范围：${config.pointsRefreshIncludeNonMember ? '所有用户' : '仅会员'}\n`
            }
            statusMsg += `   默认点数：${config.pointsDefault || 200}\n`

            // 统计总点数
            let totalPoints = 0
            for (const uid in userData) {
              totalPoints += (userData[uid].points || 0)
            }
            statusMsg += `   全体点数总和：${totalPoints}\n`
          } else {
            statusMsg += `\n❌ 点数控制：未启用\n`
          }

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

        // ========== 点数管理指令 ==========

        // 立即执行点数刷新
        if (options.refreshPoints) {
          if (!config.pointsEnabled) {
            return '❌ 点数控制未启用'
          }
          if (config.pointsMode !== 'periodic') {
            return '❌ 当前点数模式为永久模式，无需刷新'
          }
          const refreshScope = debugTierFilter !== undefined ? `Lv${debugTierFilter} 会员` : '所有会员'
          await session.send(`正在为${refreshScope}执行点数刷新...`)
          const result = await membershipSystem.refreshPoints(debugTierFilter)
          return result.message
        }

        // 给会员加点数（无 -t 对所有会员，有 -t 仅对该等级会员）
        if (options.addPoints !== undefined) {
          if (!config.pointsEnabled) {
            return '❌ 点数控制未启用'
          }
          const amount = Math.abs(options.addPoints)
          const scope = debugTierFilter !== undefined ? `Lv${debugTierFilter} 会员` : '所有会员'
          await session.send(`正在为${scope}增加 ${amount} 点数...`)
          const result = await membershipSystem.addPointsToAll(amount, true, debugTierFilter)
          return result.message
        }

        // 给会员减点数（无 -t 对所有会员，有 -t 仅对该等级会员）
        if (options.subPoints !== undefined) {
          if (!config.pointsEnabled) {
            return '❌ 点数控制未启用'
          }
          const amount = -Math.abs(options.subPoints)
          const scope = debugTierFilter !== undefined ? `Lv${debugTierFilter} 会员` : '所有会员'
          await session.send(`正在为${scope}扣除 ${Math.abs(amount)} 点数...`)
          const result = await membershipSystem.addPointsToAll(amount, true, debugTierFilter)
          return result.message
        }

        // 设置指定用户点数
        if (options.setPoints) {
          if (!config.pointsEnabled) {
            return '❌ 点数控制未启用'
          }
          const parts = options.setPoints.split(':')
          if (parts.length !== 2) {
            return '❌ 格式错误，请使用格式: 用户ID:点数\n例如: --set-points 123456:500'
          }
          const [targetId, pointsStr] = parts
          const points = parseInt(pointsStr)
          if (isNaN(points) || points < 0) {
            return '❌ 点数必须为非负整数'
          }
          if (!userData[targetId]) {
            return `❌ 用户 ${targetId} 不存在`
          }
          userData[targetId].points = points
          await membershipSystem.saveUserData()
          return `✅ 已设置用户 ${targetId} 的点数为 ${points}`
        }

        // 从 JSON 文件导入数据
        if (options.importData) {
          await session.send('正在从 JSON 文件导入数据...')
          const result = await membershipSystem.importFromJson()
          return result.message
        }

        // 如果没有指定任何选项，显示帮助
        return '请使用以下选项：\n-c 立即执行会员信息清理\n-r 立即执行会员到期提醒\n-s 查看定时任务状态（含等级分布）\n-u 重置指定用户的使用次数\n-a <天数> 给会员增加天数（加 -t <等级> 仅操作该等级会员）\n-t <等级> 配合批量操作指定生效等级\n-f 立即刷新点数（按生效等级；加 -t 仅刷新该等级会员）\n--add-points <点数> 给会员加点（可配 -t）\n--sub-points <点数> 给会员减点（可配 -t）\n--set-points <用户ID:点数> 设置指定用户点数\n--add-bucket [天数] 给会员赠送免费次数（发福利，按各自档位每日额度到账；可配 -t / --bucket-user）\n--bucket-user <用户ID> 配合 --add-bucket 仅给指定用户赠送\n--set-bucket <用户ID:次数> 设置指定用户免费次数余额\n--import 从 JSON 导入数据'
      })
  }
}