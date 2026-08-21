// NAI 账户信息查询命令
import { Context } from 'koishi'
import { Config } from '../config'
import { NetworkError } from '../utils'
import { Runtime } from '../runtime'
import { fetchSubscription as fetchNovelAISubscription, formatOpusQuota } from '../services/opusQuota'

export function registerAccount(ctx: Context, config: Config, runtime: Runtime) {
  const { getToken } = runtime
  // ========== 获取 NAI 账户信息命令 ==========
  ctx.command('novelai.account', '获取NAI账户信息', { authority: 4 })
    .alias('nai账户', 'nai账号', '获取nai账户信息')
    .usage('获取所有配置的 NovelAI Token 的账户信息，包括会员等级、订阅状态、到期时间、Anlas 点数和 Opus 免费额度。')
    .action(async ({ session }) => {
      // 检查登录类型
      if (!['token', 'login'].includes(config.type)) {
        return '❌ 此功能仅支持 Token 或账号密码登录方式'
      }

      // 辅助函数：获取订阅信息
      const fetchSubscriptionText = async (token: string, label: string): Promise<string> => {
        try {
          const response = await fetchNovelAISubscription(ctx, config, token)

          // 解析响应
          const tier = response.tier ?? 'N/A'
          const active = response.active ?? false
          const expiresAt = response.expiresAt
          const fixedAnlas = response.trainingStepsLeft?.fixedTrainingStepsLeft ?? 0
          const purchasedAnlas = response.trainingStepsLeft?.purchasedTrainingSteps ?? 0
          const totalAnlas = fixedAnlas + purchasedAnlas

          // 格式化到期时间
          let expiresStr = 'N/A'
          if (expiresAt && expiresAt > 0) {
            const expiresDate = new Date(expiresAt * 1000)
            expiresStr = expiresDate.toLocaleString('zh-CN', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })
          }

          // 会员等级映射
          const tierNames: Record<number, string> = {
            0: '免费用户',
            1: 'Tablet (基础会员)',
            2: 'Scroll (标准会员)',
            3: 'Opus (高级会员)',
          }
          const tierName = tierNames[tier] ?? `等级 ${tier}`

          return (
            `📋 **${label}**:\n` +
            `  • 会员等级: ${tierName}\n` +
            `  • 订阅状态: ${active ? '✅ 激活' : '❌ 未激活'}\n` +
            `  • 到期时间: ${expiresStr}\n` +
            `  • Anlas 点数: ${totalAnlas} (月赠: ${fixedAnlas} | 购买: ${purchasedAnlas})\n` +
            `  • ${formatOpusQuota(response).replace(/\n/g, '\n  • ')}`
          )
        } catch (err) {
          let errorMsg = '未知错误'
          if (err?.response?.status === 401) {
            errorMsg = 'Token 无效或已过期'
          } else if (err?.code === 'ETIMEDOUT') {
            errorMsg = '请求超时'
          } else if (err?.message) {
            errorMsg = err.message
          }
          return `📋 **${label}**: ❌ 获取失败 - ${errorMsg}`
        }
      }

      const results: string[] = []

      if (config.type === 'token') {
        // Token 登录方式：可能有多个 token
        const tokens = Array.isArray(config.token) ? config.token : [config.token]

        if (!tokens || tokens.length === 0 || !tokens[0]) {
          return '❌ 未配置任何 Token'
        }

        await session.send(`🔍 正在获取 ${tokens.length} 个账户的信息...`)

        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i]
          if (!token || typeof token !== 'string' || !token.trim()) {
            results.push(`📋 **Token[${i}]**: ❌ Token 无效或为空`)
            continue
          }
          const result = await fetchSubscriptionText(token, `Token[${i}]`)
          results.push(result)
        }
      } else if (config.type === 'login') {
        // 账号密码登录方式：只有一个账户
        await session.send('🔍 正在获取账户信息...')

        try {
          // 使用现有的 getToken 函数获取 token
          const token = await getToken(session)
          const result = await fetchSubscriptionText(token, '账户')
          results.push(result)
        } catch (err) {
          let errorMsg = '未知错误'
          if (err instanceof NetworkError) {
            errorMsg = session.text(err.message, err.params)
          } else if (err?.message) {
            errorMsg = err.message
          }
          results.push(`📋 **账户**: ❌ 获取失败 - ${errorMsg}`)
        }
      }

      return `🎨 NovelAI 账户信息\n\n${results.join('\n\n')}`
    })

  // ========== Opus 免费额度查询命令 ==========
  // 额度查询只返回百分比和恢复时间，不暴露 Token / Anlas 账户详情，允许群聊普通用户查询。
  ctx.command('配额', '查询 NovelAI Opus 免费生成额度', { authority: 0 })
    .alias('opus配额')
    .usage('查询 NovelAI Opus 免费 V5 生图额度、下次恢复时间和当前状态。')
    .action(async ({ session }) => {
      if (!['token', 'login'].includes(config.type)) {
        return '❌ 此功能仅支持 Token 或账号密码登录方式'
      }

      const fetchQuota = async (token: string, label: string): Promise<string> => {
        try {
          const response = await fetchNovelAISubscription(ctx, config, token)
          const lines = formatOpusQuota(response).split('\n').map(line => `  • ${line}`)
          return `📋 **${label}**:\n${lines.join('\n')}`
        } catch (err) {
          let errorMsg = '未知错误'
          if (err?.response?.status === 401) {
            errorMsg = 'Token 无效或已过期'
          } else if (err?.code === 'ETIMEDOUT') {
            errorMsg = '请求超时'
          } else if (err?.message) {
            errorMsg = err.message
          }
          return `📋 **${label}**: ❌ 获取失败 - ${errorMsg}`
        }
      }

      const results: string[] = []
      if (config.type === 'token') {
        const tokens = Array.isArray(config.token) ? config.token : [config.token]
        if (!tokens || tokens.length === 0 || !tokens[0]) return '❌ 未配置任何 Token'

        await session.send(`🔍 正在获取 ${tokens.length} 个账户的 Opus 额度...`)
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i]
          if (!token || typeof token !== 'string' || !token.trim()) {
            results.push(`📋 **Token[${i}]**: ❌ Token 无效或为空`)
            continue
          }
          results.push(await fetchQuota(token, `Token[${i}]`))
        }
      } else {
        await session.send('🔍 正在获取账户的 Opus 额度...')
        try {
          const token = await getToken(session)
          results.push(await fetchQuota(token, '账户'))
        } catch (err) {
          let errorMsg = '未知错误'
          if (err instanceof NetworkError) {
            errorMsg = session.text(err.message, err.params)
          } else if (err?.message) {
            errorMsg = err.message
          }
          results.push(`📋 **账户**: ❌ 获取失败 - ${errorMsg}`)
        }
      }

      return `🎨 NovelAI Opus 额度\n\n${results.join('\n\n')}`
    })
}
