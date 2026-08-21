import { Context, trimSlash } from 'koishi'
import { Config } from '../config'
import { Subscription } from '../types'

// NovelAI currently serves subscription data from the image API host. The
// primary API host returns a 400 instructing third-party clients to update to
// the image URL, so use the configured image endpoint here.
const DEFAULT_IMAGE_ENDPOINT = 'https://image.novelai.net'

/** 获取 NovelAI 当前订阅信息（包含 Opus usage 状态）。 */
export async function fetchSubscription(ctx: Context, config: Config, token: string): Promise<Subscription> {
  const headers = {
    referer: 'https://novelai.net/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36',
    'Content-Type': 'application/json',
    ...(config.headers || {}),
    Authorization: `Bearer ${token}`,
  }
  const imageEndpoint = trimSlash(config.endpoint || DEFAULT_IMAGE_ENDPOINT)
  return ctx.http.get(`${imageEndpoint}/user/subscription`, {
    headers,
    timeout: 30000,
  }) as Promise<Subscription>
}

/** NovelAI V5 的两个免费额度模型。 */
export function isNovelAIV5Model(model: string): boolean {
  return model === 'nai-diffusion-5-curated' || model === 'nai-diffusion-5-full'
}

/** 判断订阅响应中的 Opus 免费额度是否已经不可用。 */
export function isOpusQuotaExhausted(subscription: Subscription): boolean {
  if (subscription.tier !== 3) return false
  const usage = subscription.usage
  return usage?.isNegative === true || (typeof usage?.percent === 'number' && usage.percent <= 0)
}

/** 将官方返回的秒数格式化为适合群聊显示的中文时间。 */
export function formatRefillTime(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '未知'
  if (seconds < 60) return '不到 1 分钟'

  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`

  const hours = Math.floor(minutes / 60)
  const remainMinutes = minutes % 60
  return remainMinutes ? `${hours} 小时 ${remainMinutes} 分钟` : `${hours} 小时`
}

/** 格式化 /配额 要显示的 Opus 信息。 */
export function formatOpusQuota(subscription: Subscription): string {
  if (subscription.tier !== 3) {
    return 'Opus 免费额度：不适用（当前不是 Opus 订阅）\n下次恢复：未知\n状态：不可用'
  }

  const usage = subscription.usage
  if (!usage || typeof usage.percent !== 'number') {
    return 'Opus 免费额度：未返回\n下次恢复：未知\n状态：无法检测'
  }

  const percent = Math.max(0, Math.min(100, usage.percent))
  const exhausted = isOpusQuotaExhausted(subscription)
  const status = exhausted ? '已耗尽' : '可用'
  const refill = formatRefillTime(usage.timeUntilNextPercent)
  const refillText = refill === '未知' ? '未知' : `预计还有 ${refill}（恢复 1%）`

  return `Opus 免费额度：${percent}%\n下次恢复：${refillText}\n状态：${status}`
}
