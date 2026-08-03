// 导演工具：调用 NovelAI augment-image API，处理 ZIP/PNG 响应
import { Context, trimSlash } from 'koishi'
import AdmZip from 'adm-zip'
import { Config } from '../config'
import { ImageData, DirectorTools } from '../types'
import { forceDataPrefix, getImageSize } from '../utils'

// Director Tools 表情映射表
export const EMOTION_MAP: Record<string, DirectorTools.Emotion> = {
  '平静': 'neutral',
  '开心': 'happy',
  '伤心': 'sad',
  '生气': 'angry',
  '害怕': 'scared',
  '吃惊': 'surprised',
  '疲惫': 'tired',
  '兴奋': 'excited',
  '紧张': 'nervous',
  '思考': 'thinking',
  '困惑': 'confused',
  '害羞': 'shy',
  '厌恶': 'disgusted',
  '得意': 'smug',
  '无聊': 'bored',
  '大笑': 'laughing',
  '恼怒': 'irritated',
  '激情': 'aroused',
  '尴尬': 'embarrassed',
  '担心': 'worried',
  '爱意': 'love',
  '坚定': 'determined',
  '受伤': 'hurt',
  '调皮': 'playful',
}

// 反向映射（英文到中文）
export const EMOTION_REVERSE_MAP: Record<DirectorTools.Emotion, string> = Object.fromEntries(
  Object.entries(EMOTION_MAP).map(([cn, en]) => [en, cn])
) as Record<DirectorTools.Emotion, string>
export async function callDirectorToolsAPI(
  config: Config,
  ctx: Context,
  toolType: DirectorTools.ToolType,
  imageData: ImageData,
  token: string,
  options: {
    defry?: number
    prompt?: string
  } = {},
): Promise<string> {

      if (config.debugLog) {
        ctx.logger.info(`[Director Tools API] 开始处理，工具类型: ${toolType}`)
        ctx.logger.info(`[Director Tools API] 图像尺寸: ${imageData.buffer.byteLength} bytes`)
      }

      // 获取图像尺寸
      const size = getImageSize(imageData.buffer)

      if (config.debugLog) {
        ctx.logger.info(`[Director Tools API] 图像分辨率: ${size.width}x${size.height}`)
      }

      // 构建请求
      const request: DirectorTools.Request = {
        height: size.height,
        width: size.width,
        image: imageData.base64,
        req_type: toolType,
      }

      // 添加可选参数
      if (options.defry !== undefined) {
        request.defry = options.defry
      }

      if (options.prompt) {
        request.prompt = options.prompt
      }

      if (config.debugLog) {
        ctx.logger.info(`[Director Tools API] 请求参数: ${JSON.stringify({
          ...request,
          image: `[base64 data, length: ${request.image.length}]`
        })}`)
      }

      // 发送请求到 NovelAI API
      const res = await ctx.http(trimSlash(config.endpoint) + '/ai/augment-image', {
        method: 'POST',
        timeout: config.requestTimeout,
        responseType: 'arraybuffer',
        headers: {
          ...config.headers,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: request,
      })

      if (config.debugLog) {
        ctx.logger.info(`[Director Tools API] 请求成功，响应大小: ${res.data.byteLength} bytes`)
      }

      // NovelAI Director Tools 返回的是 ZIP 压缩文件，需要解压
      const buffer = Buffer.from(res.data)

      // 检查是否为 ZIP 文件（魔数 50 4B 03 04 = "PK\x03\x04"）
      const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04

      if (config.debugLog) {
        const magic = buffer.slice(0, 4).toString('hex')
        ctx.logger.info(`[Director Tools API] 文件魔数: ${magic}, 是否为ZIP: ${isZip}`)
      }

      let resultBase64: string

      if (isZip) {
        // 解压 ZIP 文件提取 PNG
        if (config.debugLog) {
          ctx.logger.info('[Director Tools API] 检测到 ZIP 文件，开始解压')
        }

        try {
          const zip = new AdmZip(buffer)
          const zipEntries = zip.getEntries()

          if (config.debugLog) {
            ctx.logger.info(`[Director Tools API] ZIP 包含 ${zipEntries.length} 个文件`)
            zipEntries.forEach((entry, idx) => {
              ctx.logger.info(`[Director Tools API] 文件 ${idx}: ${entry.entryName}, ${entry.header.size} bytes`)
            })
          }

          // 提取第一个图片文件
          const firstImageBuffer = zip.readFile(zipEntries[0])
          resultBase64 = firstImageBuffer.toString('base64')

          if (config.debugLog) {
            ctx.logger.info(`[Director Tools API] 成功提取 PNG 文件: ${zipEntries[0].entryName}`)
            ctx.logger.info(`[Director Tools API] PNG 大小: ${Math.round(firstImageBuffer.length / 1024)}KB`)
          }
        } catch (zipErr) {
          ctx.logger.error(`[Director Tools API] ZIP 解压失败: ${zipErr.message}`, zipErr)
          throw new Error('解压图片失败')
        }
      } else {
        // 不是 ZIP，直接使用
        if (config.debugLog) {
          ctx.logger.info('[Director Tools API] 不是 ZIP 文件，直接使用')
        }
        resultBase64 = buffer.toString('base64')
      }

      const dataUrl = forceDataPrefix(resultBase64, 'image/png')

      if (config.debugLog) {
        ctx.logger.info('[Director Tools API] 图像转换完成')
        ctx.logger.info(`[Director Tools API] Base64 长度: ${resultBase64.length}, DataURL 长度: ${dataUrl.length}`)
      }

      return dataUrl
    }
