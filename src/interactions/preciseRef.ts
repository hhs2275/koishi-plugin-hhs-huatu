// 精准参考（Precise Reference）多步交互流程：收集参考图 -> 处理图片 -> 等待用户确认
import { Session } from 'koishi'
import { modelMap } from '../config'
import { Runtime } from '../runtime'
import { download, extractImages, modelSupportsCharacterReference, NetworkError, processCharacterReferenceImage } from '../utils'

export async function runPreciseRefInteraction(
  runtime: Runtime,
  session: Session<'authority'>,
  options: any,
): Promise<string | undefined> {
  const ctx = runtime.ctx
  const config = runtime.config
      if (options.preciseRef) {
        try {
          const currentModel = modelMap[options.model] || modelMap[config.model] || 'nai-diffusion-4-5-full'

          if (!modelSupportsCharacterReference(currentModel)) {
            return session.text('commands.novelai.messages.charref-model-unsupported')
          }

          let collectedImages: any[] = []
          let failedCount = 0
          const maxLimit = 6

          await session.send(session.text('commands.novelai.messages.preciseref-wait-image') || '请输入精准参考图片。支持一次发送多张或分段发送，您可以发送"开始"结束收集，最多6张。')

          while (collectedImages.length + failedCount < maxLimit) {
            const imageResponse = await session.prompt(60000)

            if (!imageResponse) {
              return session.text('commands.novelai.messages.charref-timeout') || '接收超时，精准参考已取消。'
            }

            // 使用安全的 img 提取方式，避免用户文本中的裸 `<`（如 `>_<`）被 h.parse 误解析
            const extracted = extractImages(imageResponse)
            const contentText = extracted.input.trim()

            if (contentText === '取消' || contentText.toLowerCase() === 'cancel') {
              return '已取消精准参考任务。'
            }

            if (contentText === '开始' || contentText.toLowerCase() === 'start') {
              if (collectedImages.length === 0) {
                return session.text('commands.novelai.messages.charref-no-image')
              }
              break
            }

            const urls = extracted.urls

            if (urls.length === 0) continue

            for (const u of urls) {
              if (collectedImages.length + failedCount >= maxLimit) break
              try {
                const refImage = await download(ctx, u)
                const processedRef = await processCharacterReferenceImage(refImage)
                collectedImages.push({
                  base64: processedRef.base64,
                  url: u,
                  width: processedRef.width,
                  height: processedRef.height
                })
                await session.send(`成功收集1张图片，已收集${collectedImages.length}张图片`)
              } catch (err) {
                ctx.logger.error(err)
                failedCount++
                await session.send(`1张图片收集失败，已收集${collectedImages.length}张图片`)
              }
            }
          }

          if (collectedImages.length === 0) {
            return session.text('commands.novelai.messages.charref-no-image')
          }

          ; (options as any)._preciseRefImages = collectedImages
            ; (options as any)._preciseRefParams = options.preciseRefParams

          if (config.debugLog) {
            ctx.logger.info(`[PreciseRef] 交互完成，共收集 ${collectedImages.length} 张图片`)
          }
        } catch (err) {
          ctx.logger.error(err)
          if (err instanceof NetworkError) {
            return session.text(err.message, err.params)
          }
          return session.text('commands.novelai.messages.charref-error')
        }
      }
  return undefined
}
