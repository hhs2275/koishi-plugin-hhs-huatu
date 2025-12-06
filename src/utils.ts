import { arrayBufferToBase64, Context, Dict, pick, Quester } from 'koishi'
import {
  crypto_generichash, crypto_pwhash,
  crypto_pwhash_ALG_ARGON2ID13, crypto_pwhash_SALTBYTES, ready,
} from 'libsodium-wrappers-sumo'
import imageSize from 'image-size'
import { ImageData, Subscription } from './types'

declare module 'koishi' {
  interface Context {
    runtime?: {
      currentTokenIndex: number
      tokenUsage?: Record<number, boolean>
      tokenPool?: string[]
      poolIndex?: number
      lastPoolRefreshTime?: number
      _forcedTokenIndex?: number
      _redraw?: boolean
      _timeStamp?: number
      _taskIndex?: number
      _taskId?: number
    }
  }
}

export function project(object: {}, mapping: {}) {
  const result = {}
  for (const key in mapping) {
    result[key] = object[mapping[key]]
  }
  return result
}

export interface Size {
  width: number
  height: number
}

export function getImageSize(buffer: ArrayBuffer): Size {
  if (typeof Buffer !== 'undefined') {
    return imageSize(new Uint8Array(buffer))
  }
  const blob = new Blob([buffer])
  const image = new Image()
  image.src = URL.createObjectURL(blob)
  return pick(image, ['width', 'height'])
}

const MAX_OUTPUT_SIZE = 1048576
const MAX_CONTENT_SIZE = 10485760
const ALLOWED_TYPES = ['image/jpeg', 'image/png']

export async function download(ctx: Context, url: string, headers = {}): Promise<ImageData> {
  if (url.startsWith('data:') || url.startsWith('file:')) {
    const { mime, data } = await ctx.http.file(url)
    if (!ALLOWED_TYPES.includes(mime)) {
      throw new NetworkError('.unsupported-file-type')
    }
    const base64 = arrayBufferToBase64(data)
    return { buffer: data, base64, dataUrl: `data:${mime};base64,${base64}` }
  } else {
    const image = await ctx.http(url, { responseType: 'arraybuffer', headers })
    if (+image.headers.get('content-length') > MAX_CONTENT_SIZE) {
      throw new NetworkError('.file-too-large')
    }
    const mimetype = image.headers.get('content-type')
    if (!ALLOWED_TYPES.includes(mimetype)) {
      throw new NetworkError('.unsupported-file-type')
    }
    const buffer = image.data
    const base64 = arrayBufferToBase64(buffer)
    return { buffer, base64, dataUrl: `data:${mimetype};base64,${base64}` }
  }
}

export async function calcAccessKey(email: string, password: string) {
  await ready
  return crypto_pwhash(
    64,
    new Uint8Array(Buffer.from(password)),
    crypto_generichash(
      crypto_pwhash_SALTBYTES,
      password.slice(0, 6) + email + 'novelai_data_access_key',
    ),
    2,
    2e6,
    crypto_pwhash_ALG_ARGON2ID13,
    'base64').slice(0, 64)
}

export async function calcEncryptionKey(email: string, password: string) {
  await ready
  return crypto_pwhash(
    128,
    new Uint8Array(Buffer.from(password)),
    crypto_generichash(
      crypto_pwhash_SALTBYTES,
      password.slice(0, 6) + email + 'novelai_data_encryption_key'),
    2,
    2e6,
    crypto_pwhash_ALG_ARGON2ID13,
    'base64')
}

export class NetworkError extends Error {
  constructor(message: string, public params = {}) {
    super(message)
  }

  static catch = (mapping: Dict<string>) => (e: any) => {
    if (Quester.Error.is(e)) {
      const code = e.response?.status
      for (const key in mapping) {
        if (code === +key) {
          throw new NetworkError(mapping[key])
        }
      }
    }
    throw e
  }
}

export async function initTokenPool(ctx: Context): Promise<string[]> {
  if (ctx.config.type !== 'token' || !Array.isArray(ctx.config.token) || ctx.config.token.length === 0) {
    return []
  }

  // 确保runtime对象存在并且所有字段都被正确初始化为有效值
  ctx.runtime = ctx.runtime || { currentTokenIndex: 0 }

  // 确保所有必要的字段都被初始化为有效值
  ctx.runtime.currentTokenIndex = isNaN(ctx.runtime.currentTokenIndex) ? 0 : ctx.runtime.currentTokenIndex
  ctx.runtime.tokenPool = Array.isArray(ctx.runtime.tokenPool) ? ctx.runtime.tokenPool : []
  ctx.runtime.poolIndex = isNaN(ctx.runtime.poolIndex) ? 0 : ctx.runtime.poolIndex
  ctx.runtime.lastPoolRefreshTime = ctx.runtime.lastPoolRefreshTime || 0

  const validTokens: string[] = []

  // 过滤掉无效的token（非字符串或空字符串）
  const filteredTokens = ctx.config.token.filter((token, index) => {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      ctx.logger.warn(`Token ${index} 无效（空或非字符串），已跳过`)
      return false
    }
    return true
  })

  if (filteredTokens.length === 0) {
    ctx.logger.error('所有token都无效，token池初始化失败')
    throw new NetworkError('.all-tokens-invalid')
  }

  // 直接使用所有有效token，不进行验证
  validTokens.push(...filteredTokens)
  ctx.logger.info(`Token池初始化完成，共${validTokens.length}个token（未验证）`)

  if (validTokens.length === 0) {
    ctx.logger.error('没有有效的token，token池初始化失败')
    throw new NetworkError('.all-tokens-invalid')
  }

  ctx.runtime.tokenPool = validTokens
  ctx.runtime.poolIndex = 0
  ctx.runtime.lastPoolRefreshTime = Date.now()

  ctx.logger.success(`Token池初始化成功，共有${validTokens.length}个有效token`)
  return validTokens
}

export async function login(ctx: Context, email: string, password: string): Promise<string> {
  // 添加错误检查，确保ctx和ctx.config有效
  if (!ctx) {
    const error = new Error('Context对象为空')
    console.error(error)
    throw error
  }

  if (!ctx.config) {
    const error = new Error('Context配置为空')
    console.error(error)
    throw error
  }

  if (!ctx.config.type) {
    const error = new Error('Context配置中缺少type属性')
    console.error(error)
    throw error
  }

  // 检查http对象是否存在
  if (!ctx.http) {
    const error = new Error('Context.http对象为空，无法进行网络请求')
    console.error(error)
    throw error
  }

  // 确保logger存在，如果不存在则使用console
  const logger = ctx.logger || {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  }

  if (ctx.config.debugLog) logger.info('login函数被调用，ctx.type=' + ctx.config.type)

  if (ctx.config.type === 'token') {
    // 多 token：只尊重队列/调用方分配的强制索引
    if (Array.isArray(ctx.config.token) && ctx.config.token.length > 0) {
      ctx.runtime = ctx.runtime || { currentTokenIndex: 0 }
      const forcedTokenIndex = ctx.runtime._forcedTokenIndex
      if (typeof forcedTokenIndex === 'number' && forcedTokenIndex >= 0 && forcedTokenIndex < ctx.config.token.length) {
        const token = ctx.config.token[forcedTokenIndex]
        if (!token || typeof token !== 'string' || token.trim() === '') {
          logger.warn(`强制指定的 token ${forcedTokenIndex} 无效`)
          throw new NetworkError('.all-tokens-invalid')
        }
        if (ctx.config.debugLog) logger.info(`login: 使用强制指定的 token 索引 ${forcedTokenIndex}`)
        return token
      }
      // 未提供强制索引时，默认使用第一个 token，并记录警告
      const fallback = ctx.config.token[0]
      logger.warn('login: 未提供 _forcedTokenIndex，默认使用第一个 token')
      return fallback
    } else if (typeof ctx.config.token === 'string') {
      if (!ctx.config.token.trim()) {
        throw new NetworkError('.no-token-provided')
      }
      if (ctx.config.debugLog) logger.info('login: 使用单个 token')
      return ctx.config.token
    } else {
      throw new NetworkError('.no-token-provided')
    }
  } else if (ctx.config.type === 'login' && process.env.KOISHI_ENV !== 'browser') {
    return ctx.http.post(ctx.config.apiEndpoint + '/user/login', {
      timeout: 30000,
      key: await calcAccessKey(ctx.config.email, ctx.config.password),
    }).then(res => res.accessToken)
  } else {
    return ctx.config.token
  }
}

export function closestMultiple(num: number, mult = 64) {
  const floor = Math.floor(num / mult) * mult
  const ceil = Math.ceil(num / mult) * mult
  const closest = num - floor < ceil - num ? floor : ceil
  if (Number.isNaN(closest)) return 0
  return closest <= 0 ? mult : closest
}

export interface Size {
  width: number
  height: number
  /** Indicate whether this resolution is pre-defined or customized */
  custom?: boolean
}

export function resizeInput(size: Size): Size {
  // if width and height produce a valid size, use it
  const { width, height } = size
  if (width % 64 === 0 && height % 64 === 0 && width * height <= MAX_OUTPUT_SIZE) {
    return { width, height }
  }

  // otherwise, set lower size as 512 and use aspect ratio to the other dimension
  const aspectRatio = width / height
  if (aspectRatio > 1) {
    const height = 512
    const width = closestMultiple(height * aspectRatio)
    // check that image is not too large
    if (width * height <= MAX_OUTPUT_SIZE) {
      return { width, height }
    }
  } else {
    const width = 512
    const height = closestMultiple(width / aspectRatio)
    // check that image is not too large
    if (width * height <= MAX_OUTPUT_SIZE) {
      return { width, height }
    }
  }

  // if that fails set the higher size as 1024 and use aspect ratio to the other dimension
  if (aspectRatio > 1) {
    const width = 1024
    const height = closestMultiple(width / aspectRatio)
    return { width, height }
  } else {
    const height = 1024
    const width = closestMultiple(height * aspectRatio)
    return { width, height }
  }
}

export function forceDataPrefix(url: string, mime = 'image/png') {
  // workaround for different gradio versions
  // https://github.com/koishijs/novelai-bot/issues/90
  if (url.startsWith('data:')) return url
  return `data:${mime};base64,` + url
}

/**
 * 将位置字符串（如 "A1" 到 "E5"）转换为坐标
 * 横向: A(-0.4) → B(-0.2) → C(0) → D(+0.2) → E(+0.4)
 * 纵向: 1(-0.4) → 2(-0.2) → 3(0) → 4(+0.2) → 5(+0.4)
 * @param position 位置字符串，默认为 "C3" (中心点)
 * @returns 坐标对象 { x, y }，值域为 [0.1, 0.9]
 */
export function convertPosition(position: string = 'C3'): { x: number; y: number } {
  // 验证格式
  if (!/^[A-E][1-5]$/.test(position)) {
    throw new Error(`Invalid position: ${position}. Must be A1-E5`)
  }

  // 转换坐标
  const x = Math.round((0.5 + 0.2 * (position.charCodeAt(0) - 'C'.charCodeAt(0))) * 10) / 10
  const y = Math.round((0.5 + 0.2 * (position.charCodeAt(1) - '3'.charCodeAt(0))) * 10) / 10

  return { x, y }
}

/**
 * 检查模型是否支持 Characters 功能
 * @param model 模型名称
 * @returns 是否支持 Characters
 */
export function modelSupportsCharacters(model: string): boolean {
  const supportedModels = [
    'nai-diffusion-4-curated-preview',
    'nai-diffusion-4-full',
    'nai-diffusion-4-curated-inpainting',
    'nai-diffusion-4-full-inpainting',
    'nai-diffusion-4-5-curated',
    'nai-diffusion-4-5-full',
  ]
  return supportedModels.includes(model)
}

/**
 * 解析用户友好的 characters 文本格式
 * 格式：prompt@position --uc:negative;prompt2@position2
 * 
 * 示例：
 * - "1girl, red hair@B3;1boy, blue eyes@D3"
 * - "1girl@B3 --uc:frown;1boy@D3"
 * - "princess, dress@C2 --uc:messy;knight@C4"
 * - 支持中文分号："1girl@B3；1boy@D3"
 * 
 * @param input 用户输入的字符串
 * @returns Character 数组
 */
export function parseCharacters(input: string): Array<{ prompt: string; uc?: string; position?: string }> {
  if (!input || !input.trim()) {
    return []
  }

  // 首先尝试解析为 JSON（兼容旧格式）
  if (input.trim().startsWith('[')) {
    try {
      return JSON.parse(input)
    } catch {
      // 如果 JSON 解析失败，继续用文本格式解析
    }
  }

  const characters: Array<{ prompt: string; uc?: string; position?: string }> = []

  // 将中文分号统一替换为英文分号
  const normalizedInput = input.replace(/；/g, ';')

  // 按 ; 分隔不同角色
  const characterStrings = normalizedInput.split(';').map(s => s.trim()).filter(Boolean)

  for (const charStr of characterStrings) {
    // 提取负向提示 --uc:xxx
    let prompt = charStr
    let uc = ''

    const ucMatch = charStr.match(/--uc:([^@]*?)(?:@|$)/)
    if (ucMatch) {
      uc = ucMatch[1].trim()
      // 移除 --uc:xxx 部分
      prompt = charStr.replace(/--uc:[^@]*/, '').trim()
    }

    // 提取位置 @XXX
    let position = ''
    const posMatch = prompt.match(/@([A-E][1-5])\s*$/)
    if (posMatch) {
      position = posMatch[1]
      // 移除 @XXX 部分
      prompt = prompt.replace(/@[A-E][1-5]\s*$/, '').trim()
    }

    // 清理多余的空格和逗号
    prompt = prompt.replace(/\s+/g, ' ').trim()

    if (prompt) {
      const character: { prompt: string; uc?: string; position?: string } = { prompt }
      if (uc) character.uc = uc
      if (position) character.position = position
      characters.push(character)
    }
  }

  return characters
}

// 创建一个辅助函数，用于处理session中的runtime
export function createContextWithRuntime(ctx: Context, runtime: any): Context {
  // 检查传入的ctx是否有效
  if (!ctx) {
    console.error('createContextWithRuntime: ctx为空');
    return null;
  }

  // 创建一个新的context对象，保留ctx的所有属性，但替换runtime
  const newRuntime = { ...runtime }

  // 合并ctx现有的runtime中的属性（如果存在）
  if (ctx.runtime) {
    // 只复制tokenUsage等必要属性，避免复制currentTokenIndex
    const { currentTokenIndex, ...restRuntime } = ctx.runtime
    Object.assign(newRuntime, restRuntime)
  }

  // 创建新的上下文对象，确保所有必要属性被正确复制
  const newCtx = {
    // 首先复制原始ctx的关键属性
    config: ctx.config,
    http: ctx.http,
    // 替换runtime
    runtime: newRuntime,
    // 确保logger存在
    logger: ctx.logger || {
      debug: console.debug,
      info: console.info,
      success: console.log,
      warn: console.warn,
      error: console.error,
    },
  }

  // 复制其他可能存在的属性
  for (const key in ctx) {
    if (key !== 'runtime' && key !== 'config' && key !== 'http' && key !== 'logger') {
      newCtx[key] = ctx[key]
    }
  }

  return newCtx as Context
}

/**
 * 将尺寸对齐到64的倍数（NovelAI API要求）
 */
export function alignTo64(size: number): number {
  return Math.ceil(size / 64) * 64
}

/**
 * 将图片调暗并对齐尺寸(用于局部重绘的交互式流程)
 * @param imageData 原始图片数据
 * @param factor 调暗系数(0-1,默认0.5)
 * @returns 调暗后的图片Data URL和对齐后的尺寸
 */
export async function darkenImage(imageData: ImageData, factor = 0.5): Promise<{
  dataUrl: string
  alignedWidth: number
  alignedHeight: number
  originalBuffer: Buffer
}> {
  const sharp = await import('sharp')
  const buffer = Buffer.from(imageData.buffer)

  // 获取原始尺寸
  const metadata = await sharp.default(buffer).metadata()
  const alignedWidth = alignTo64(metadata.width)
  const alignedHeight = alignTo64(metadata.height)

  // 先resize到64倍数，再调暗
  const darkenedBuffer = await sharp.default(buffer)
    .resize(alignedWidth, alignedHeight, { fit: 'fill' })
    .modulate({ brightness: factor })
    .png()
    .toBuffer()

  // 同时生成对齐后的原图（不调暗，用于后续API调用）
  const alignedOriginal = await sharp.default(buffer)
    .resize(alignedWidth, alignedHeight, { fit: 'fill' })
    .png()
    .toBuffer()

  const base64 = darkenedBuffer.toString('base64')
  return {
    dataUrl: `data:image/png;base64,${base64}`,
    alignedWidth,
    alignedHeight,
    originalBuffer: alignedOriginal
  }
}

/**
 * 针对 NovelAI V4 优化的 Mask 处理算法
 * 逻辑复刻自 Auto-NovelAI-Refactor 的 process_white_regions
 * 1. 二值化
 * 2. 8x8 网格对齐 (Latent Alignment)
 * 3. 区域膨胀 (Block Dilation) 确保覆盖边缘
 * 
 * @param imageData 用户涂白的图片数据
 * @param targetWidth 目标宽度（对齐到64的倍数）
 * @param targetHeight 目标高度（对齐到64的倍数）
 * @returns 处理后的遮罩base64(不含data:前缀)
 */
export async function extractMaskWithAntiArtifact(
  imageData: ImageData,
  targetWidth: number,
  targetHeight: number
): Promise<string> {
  const sharp = await import('sharp')
  const buffer = Buffer.from(imageData.buffer)

  // 1. 预处理：调整大小 -> 灰度 -> 强二值化
  // V4 需要纯黑白的 Mask，不能有灰度过渡
  const { data, info } = await sharp.default(buffer)
    .resize(targetWidth, targetHeight, { fit: 'fill' })
    .grayscale()
    .threshold(128) // 阈值化，涂抹部分变白(255)，未涂抹变黑(0)
    .raw()
    .toBuffer({ resolveWithObject: true })

  const width = info.width
  const height = info.height

  // 2. 网格化处理 (Latent Alignment)
  // NovelAI V4 的 Latent 大小通常是 8x8 像素
  const blockSize = 8
  const gridW = Math.ceil(width / blockSize)
  const gridH = Math.ceil(height / blockSize)

  // 记录哪些网格包含白色像素
  const gridMap = new Uint8Array(gridW * gridH) // 0: black, 1: white

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * width + x
      // data[offset] 是 0 或 255 (因为做过 threshold)
      if (data[offset] > 128) {
        const gx = Math.floor(x / blockSize)
        const gy = Math.floor(y / blockSize)
        gridMap[gy * gridW + gx] = 1
      }
    }
  }

  // 3. 网格膨胀 (Block Dilation)
  // 只要一个网格被标记，将其周围的网格也标记为白，防止边缘伪影
  // Python 源码中使用了复杂的 BFS+BoundingBox 扩充，这里使用简单的网格膨胀即可达到同等效果
  const dilatedGridMap = new Uint8Array(gridW * gridH)

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (gridMap[gy * gridW + gx] === 1) {
        // 标记自己
        dilatedGridMap[gy * gridW + gx] = 1

        // 标记上下左右 (扩展范围，相当于源码中的 expansion)
        // 如果发现边缘融合不好，可以增加循环扩大这个范围
        const neighbors = [
          { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
          { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
          { dx: 1, dy: 1 }, { dx: -1, dy: -1 }, // 对角线也处理，更稳妥
          { dx: 1, dy: -1 }, { dx: -1, dy: 1 }
        ]

        for (const n of neighbors) {
          const nx = gx + n.dx
          const ny = gy + n.dy
          if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) {
            dilatedGridMap[ny * gridW + nx] = 1
          }
        }
      }
    }
  }

  // 4. 重建 Mask 图片
  // 如果网格被标记，则该网格对应的 8x8 像素全白
  const newData = Buffer.alloc(data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = Math.floor(x / blockSize)
      const gy = Math.floor(y / blockSize)

      if (dilatedGridMap[gy * gridW + gx] === 1) {
        newData[y * width + x] = 255
      } else {
        newData[y * width + x] = 0
      }
    }
  }

  // 5. 输出
  const maskBuffer = await sharp.default(newData, {
    raw: { width, height, channels: 1 }
  })
    .png()
    .toBuffer()

  return maskBuffer.toString('base64')
}



// ========== 以下是旧版函数，保留兼容性 ==========

/**
 * 从用户涂白的图片中提取遮罩并进行膨胀处理（旧版，保留兼容）
 * @deprecated 推荐使用 extractMaskWithAntiArtifact
 */
export async function extractAndDilateMask(
  imageData: ImageData,
  threshold = 200,
  minPenSize = 4
): Promise<string> {
  const sharp = await import('sharp')
  const buffer = Buffer.from(imageData.buffer)

  // 获取图片信息
  const image = sharp.default(buffer)
  const metadata = await image.metadata()
  const { width, height, channels } = metadata

  // 提取原始像素数据
  const { data } = await image.raw().toBuffer({ resolveWithObject: true })

  // 创建遮罩: 白色(>threshold)的区域保留为白色,其他为黑色
  const maskData = Buffer.alloc(width * height)
  const pixelSize = channels || 3

  for (let i = 0; i < width * height; i++) {
    const r = data[i * pixelSize]
    const g = data[i * pixelSize + 1]
    const b = data[i * pixelSize + 2]

    // 检查是否为白色
    const isWhite = r > threshold && g > threshold && b > threshold
    maskData[i] = isWhite ? 255 : 0
  }

  // 对遮罩进行膨胀处理
  const dilatedMask = dilateMaskBuffer(maskData, width, height, minPenSize)

  // 转换为PNG格式
  const maskBuffer = await sharp.default(dilatedMask, {
    raw: {
      width,
      height,
      channels: 1
    }
  })
    .png()
    .toBuffer()

  return maskBuffer.toString('base64')
}

/**
 * 对遮罩Buffer进行膨胀处理（旧版）
 */
function dilateMaskBuffer(data: Buffer, width: number, height: number, minPenSize: number): Buffer {
  const iterations = Math.floor(minPenSize / 2)
  let currentData = Buffer.from(data)
  let tempData = Buffer.alloc(data.length)

  for (let iter = 0; iter < iterations; iter++) {
    tempData = Buffer.from(currentData)

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x

        // 检查当前像素是否为白色
        if (tempData[idx] > 128) {
          // 膨胀到周围8个像素
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nidx = (y + dy) * width + (x + dx)
              currentData[nidx] = 255
            }
          }
        }
      }
    }
  }

  return currentData
}