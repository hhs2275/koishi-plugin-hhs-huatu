import { SessionError } from 'koishi'
import type { Config } from '../config'
import type { ImageData } from '../types'
import { isNovelAIV5Model } from './opusQuota'

export const MAX_REFERENCES = 6

export function supports(model: string) {
  return model === 'nai-diffusion-5-full' || model === 'nai-diffusion-5-curated'
}

export function usageError(model: string, backend: Config['type'], inpaint?: boolean): string | undefined {
  if (!isNovelAIV5Model(model)) return
  if (!supports(model)) return 'commands.novelai.messages.charref-model-unsupported'
  if (backend !== 'token' && backend !== 'login') return 'commands.novelai.messages.preciseref-v5-backend'
  if (inpaint) return 'commands.novelai.messages.preciseref-v5-inpaint'
}

const modes = new Map([
  ['sco', 'character&style'], ['sc', 'character&style_anyoutfit'], ['co', 'character_mainoutfit'],
  ['s', 'style'], ['c', 'character'], ['o', 'costume'],
])

function normalizeMode(value: string) {
  const letters = new Set(value.toLowerCase())
  if (letters.size !== value.length || !/^[sco]+$/i.test(value)) return
  return [...'sco'].filter(letter => letters.has(letter)).join('')
}

export function settings(raw = '', count = MAX_REFERENCES) {
  const text = raw.replace(/["'“”‘’]/g, '').replace(/；/g, ';').replace(/，/g, ',').trim()
  // 只忽略末尾分隔符，中间的空组仍占一个位置并使用默认值。
  const groups = text ? text.replace(/;$/, '').split(';') : []
  if (count < 1 || count > MAX_REFERENCES || groups.length > count) return
  const result: { mode: string, strength: number }[] = []
  for (let index = 0; index < count; index++) {
    const parts = (groups[index]?.trim() || 'sco').split(',').map(value => value.trim())
    const mode = modes.get(normalizeMode(parts[0] || 'sco'))
    const strength = parts[1] ? Number(parts[1]) : 1
    // 兼容旧的第三列，但 V5 不校验或使用保真度。
    if (!mode || parts.length > 3 || !Number.isFinite(strength) || strength < 0 || strength > 5) return
    result.push({ mode, strength })
  }
  return result
}

// V5 参考图的宽高按 64 像素分档，面积上限为 1024² 像素。
const buckets: [number, number][] = []
for (let height = 4096; height > 1024; height -= 64) {
  buckets.push([64 * Math.floor(1024 ** 2 / height / 64), height])
}
buckets.push([1024, 1024], ...buckets.slice().reverse().map(([w, h]): [number, number] => [h, w]))

export async function prepare(image: ImageData) {
  const { default: sharp } = await import('sharp')
  const pipeline = sharp(Buffer.from(image.buffer)).rotate()
  const metadata = await pipeline.metadata()
  const swapped = metadata.orientation >= 5 && metadata.orientation <= 8
  const ratio = swapped ? metadata.height / metadata.width : metadata.width / metadata.height
  const distance = ([w, h]: [number, number]) => Math.abs(Math.log(ratio) - Math.log(w / h))
  const [width, height] = buckets.reduce((best, next) => distance(next) < distance(best) ? next : best)
  const png = await pipeline.resize(width, height, { fit: 'cover', position: 'centre' }).png().toBuffer()
  return { base64: png.toString('base64'), width, height }
}

export async function requestFields(
  references: { base64?: string, url?: string }[] | undefined, raw: string,
  download: (url: string) => Promise<ImageData>,
) {
  if (!references?.length) throw new SessionError('commands.novelai.messages.charref-no-image')
  const params = settings(raw, references.length)
  if (!params) throw new SessionError('commands.novelai.messages.preciseref-v5-params')
  const images: string[] = []
  for (const image of references) {
    if (image.base64) {
      images.push(image.base64)
      continue
    }
    try {
      if (!image.url) throw new Error('Missing reference image URL')
      images.push((await prepare(await download(image.url))).base64)
    } catch {
      throw new SessionError('commands.novelai.messages.preciseref-v5-redraw-image')
    }
  }
  return {
    director_reference_images: images,
    director_reference_descriptions: params.map(({ mode }) => ({
      caption: { base_caption: mode, char_captions: [] }, legacy_uc: false,
    })),
    director_reference_information_extracted: params.map(() => 1),
    director_reference_strength_values: params.map(({ strength }) => strength),
    director_reference_secondary_strength_values: params.map(() => 0),
  }
}
