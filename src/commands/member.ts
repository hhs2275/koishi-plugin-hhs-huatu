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
      if ((options.days || options.cancel || options.addPoints !== undefined || options.refreshPoints) && session.user.authority < config.membershipAuthLv) {
        return '您没有权限设置会员状态'
      }

      // 检查并重置每日使用次数
      membershipSystem.checkAndResetDailyUsage(targetId)

      // 如果是刷新点数
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
          const user = userData[targetId]
          if (!user.isMember || user.membershipExpiry < Date.now()) {
            return `刷新范围不包含非会员，无法为该用户刷新点数`
          }
        }
        const refreshAmount = config.pointsRefreshAmount || 200
        userData[targetId].points = refreshAmount
        // 保存用户数据
        await membershipSystem.saveUserData()
        return `已刷新用户 ${targetId} 的点数，当前剩余：${refreshAmount}`
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

      // 如果是取消会员
      if (options.cancel) {
        if (!userData[targetId]) {
          return '该用户不存在会员记录'
        }

        userData[targetId].isMember = false
        userData[targetId].membershipExpiry = 0
        userData[targetId].dailyLimit = config.nonMemberDailyLimit

        if (config.pointsEnabled && config.pointsMode === 'periodic' && !config.pointsRefreshIncludeNonMember) {
          userData[targetId].points = 0
        }

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
            dailyLimit: config.memberDailyLimit || 0,
            points: config.pointsEnabled ? (config.pointsDefault || 200) : 0,
            nai5DailyUsage: 0,
          }
        } else {
          // 如果用户已经是会员且会员未过期，则在原有期限上增加天数
          if (userData[targetId].isMember && userData[targetId].membershipExpiry > Date.now()) {
            userData[targetId].membershipExpiry += options.days * 24 * 60 * 60 * 1000
          } else {
            // 如果用户不是会员或会员已过期，则从当前时间开始计算
            userData[targetId].isMember = true
            userData[targetId].membershipExpiry = Date.now() + options.days * 24 * 60 * 60 * 1000

            // 从非会员变成会员时，刷新点数（周期性模式下）
            if (config.pointsEnabled && config.pointsMode === 'periodic') {
              const refreshAmount = config.pointsRefreshAmount || 200
              userData[targetId].points = refreshAmount
              ctx.logger.info(`[会员系统] 用户 ${targetId} 成为会员，点数已刷新为 ${refreshAmount}`)
            }
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

        let nai5Info = ''
        if (config.memberNai5DailyLimit > 0) {
          const nai5Used = user.nai5DailyUsage || 0
          const nai5Remaining = Math.max(0, config.memberNai5DailyLimit - nai5Used)
          nai5Info = `\nnai5/nai5c 今日免费：${config.memberNai5DailyLimit} 次，已用 ${nai5Used} 次，剩余 ${nai5Remaining} 次`
          if (config.pointsEnabled && nai5Remaining === 0) {
            nai5Info += '（超出后按 Anlas 估算扣点）'
          }
        }

        let pointsInfo = ''
        if (config.pointsEnabled) {
          const points = user.points || 0
          pointsInfo = `\n点数余额：${points}`
          if (config.pointsMode === 'periodic') {
            const remainDaysRefresh = membershipSystem.getDaysUntilNextRefresh()
            if (remainDaysRefresh >= 0) {
              pointsInfo += `\n下次点数刷新时间：${remainDaysRefresh}天后`
            }
          }
        }

        return `${usageInfo}${nai5Info}\n会员到期时间：${expireDate.toLocaleString()}（剩余${remainingDays}天）${pointsInfo}`
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
      .option('addDaysAll', '-a <days:number> 给所有会员增加天数')
      .option('refreshPoints', '-f 立即执行点数刷新')
      .option('addPoints', '--add-points <amount:number> 给所有会员加点数')
      .option('subPoints', '--sub-points <amount:number> 给所有会员减点数')
      .option('setPoints', '--set-points <value:string> 设置指定用户点数，格式: 用户ID:点数')
      .option('importData', '--import 从 JSON 文件导入数据')
      .action(async ({ session, options }) => {
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
          userData[targetId].nai5DailyUsage = 0
          await membershipSystem.saveUserData()
          const user = userData[targetId]
          const dailyLimit = user.isMember ? config.memberDailyLimit : config.nonMemberDailyLimit
          const remaining = dailyLimit - user.dailyUsage
          const nai5Limit = config.memberNai5DailyLimit || 0
          const nai5Line = nai5Limit > 0
            ? `\nnai5/nai5c 每日免费：${nai5Limit} 次\nnai5 已使用：${user.nai5DailyUsage || 0} 次`
            : ''

          return `✅ 已重置用户 ${targetId} 的使用次数\n` +
            `当前状态：${user.isMember ? '会员' : '非会员'}\n` +
            `每日限额：${dailyLimit} 次\n` +
            `已使用：${user.dailyUsage} 次\n` +
            `剩余：${remaining} 次` + nai5Line

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
          await session.send('正在执行点数刷新...')
          const result = await membershipSystem.refreshPoints()
          return result.message
        }

        // 给所有会员加点数
        if (options.addPoints !== undefined) {
          if (!config.pointsEnabled) {
            return '❌ 点数控制未启用'
          }
          const amount = Math.abs(options.addPoints)
          await session.send(`正在为所有会员增加 ${amount} 点数...`)
          const result = await membershipSystem.addPointsToAll(amount, true)
          return result.message
        }

        // 给所有会员减点数
        if (options.subPoints !== undefined) {
          if (!config.pointsEnabled) {
            return '❌ 点数控制未启用'
          }
          const amount = -Math.abs(options.subPoints)
          await session.send(`正在为所有会员扣除 ${Math.abs(amount)} 点数...`)
          const result = await membershipSystem.addPointsToAll(amount, true)
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
        return '请使用以下选项：\n-c 立即执行会员信息清理\n-r 立即执行会员到期提醒\n-s 查看定时任务状态\n-u 重置指定用户的使用次数\n-a <天数> 给所有会员增加天数\n-f 立即刷新点数\n--add-points <点数> 给所有会员加点\n--sub-points <点数> 给所有会员减点\n--set-points <用户ID:点数> 设置指定用户点数\n--import 从 JSON 导入数据'
      })
  }
}