import type { ImageData } from '../types'

export function supports(model: string) {
  return model === 'nai-diffusion-5-full' || model === 'nai-diffusion-5-curated'
}

const modes = new Map([
  ['cs', 'character&style'], ['c', 'character'], ['s', 'style'], ['o', 'costume'],
  ['co', 'character_mainoutfit'], ['cs-any', 'character&style_anyoutfit'], ['outfit', 'costume'],
])
for (const mode of [...modes.values()]) modes.set(mode, mode)

export function settings(raw = '', count = 6) {
  const text = raw.replace(/["'“”]/g, '').replace(/；/g, ';').replace(/，/g, ',').trim()
  const groups = text ? text.split(';') : []
  if (count < 1 || count > 6 || groups.length > count) return
  const result: { mode: string, strength: number }[] = []
  for (let index = 0; index < count; index++) {
    const parts = (groups[index] ?? 'cs').split(',').map(value => value.trim())
    const mode = modes.get(parts[0])
    const strength = parts[1] === undefined ? 1 : Number(parts[1])
    // 兼容旧预设的保真度。V5 请求中的次级强度固定为 0。
    const fidelity = parts[2] === undefined ? 1 : Number(parts[2])
    if (!mode || parts.length > 3 || parts.includes('') ||
      !Number.isFinite(strength) || strength < 0 || strength > 5 ||
      !Number.isFinite(fidelity) || fidelity < 0 || fidelity > 1) return
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
  references: { base64?: string, url?: string }[], raw: string,
  download: (url: string) => Promise<ImageData>,
) {
  const params = settings(raw, references.length)
  if (!params) throw new Error('V5 精准参考参数无效')
  const images: string[] = []
  for (const image of references) {
    if (image.base64) images.push(image.base64)
    else if (image.url) images.push((await prepare(await download(image.url))).base64)
    else throw new Error('缺少 V5 精准参考图')
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
