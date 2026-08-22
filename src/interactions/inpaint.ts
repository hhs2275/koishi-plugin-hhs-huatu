// 局部重绘（Inpaint）多步交互流程：确认图片 -> 调暗原图 -> 等待用户涂白 -> 提取遮罩
import { h, Session } from 'koishi'
import { Runtime } from '../runtime'
import { ImageData } from '../types'
import { clampToNAILimit, darkenImage, download, extractImages, extractMaskWithAntiArtifact, NetworkError } from '../utils'
import { calculateTaskPointsCost, getTaskDrawCount } from '../services/points'

/**
 * 等待用户发送一张图片，返回图片 URL。
 * - 返回 URL：收到带图消息
 * - 返回 ''：收到消息但没有图片（与超时区分，便于给出不同提示）
 * - 返回 undefined：超时
 */
async function promptForImage(session: Session<'authority'>, timeout: number): Promise<string | undefined> {
  const result = await session.prompt((s) => {
    // 官方推荐方式：从元素树取图，attrs.src 已反转义
    const [image] = h.select(s.elements ?? [], 'img')
    return image?.attrs.src ?? ''
  }, { timeout })
  return result as string | undefined
}

export interface InpaintInteractionResult {
  input: string
  error?: string
}

export async function runInpaintInteraction(
  runtime: Runtime,
  session: Session<'authority'>,
  options: any,
  input: string,
): Promise<InpaintInteractionResult> {
  const ctx = runtime.ctx
  const config = runtime.config
      if (options.inpaint) {
        try {
          // 1. 提取输入中的图片URL，并从 input 中移除图片元素只保留提示词
          //    优先使用 action 阶段从 session.elements 提取的 URL（官方方式），字符串兜底
          let imgUrl: string
          const extracted = extractImages(input)
          input = extracted.input
          imgUrl = options._imageUrls?.[0] || extracted.urls[0]

          // 2. 如果没有图片，提示用户发送并等待
          if (!imgUrl) {
            await session.send(session.text('commands.novelai.messages.inpaint-wait-image'))
            const imgSrc = await promptForImage(session, 60000)
            if (imgSrc === undefined) {
              return { input, error: session.text('commands.novelai.messages.inpaint-timeout') }
            }
            if (!imgSrc) {
              return { input, error: session.text('commands.novelai.messages.inpaint-no-mask') }
            }
            imgUrl = imgSrc
          }

          // 2. 下载原图（带重试：如果下载失败，提示用户重新发送参考图）
          let image: ImageData
          try {
            image = await download(ctx, imgUrl)
          } catch (err) {
            ctx.logger.warn(`[Inpaint] 参考图下载失败: ${err}`)
            await session.send(session.text('commands.novelai.messages.inpaint-image-download-failed'))
            const retryUrl = await promptForImage(session, 60000)
            if (retryUrl === undefined) {
              return { input, error: session.text('commands.novelai.messages.inpaint-timeout') }
            }
            if (!retryUrl) {
              return { input, error: session.text('commands.novelai.messages.inpaint-no-mask') }
            }
            imgUrl = retryUrl
            image = await download(ctx, imgUrl)
          }

          // 3. 确定最终尺寸：如果用户指定了 -r，使用 -r 的尺寸；否则使用原图尺寸
          let targetWidth: number | undefined
          let targetHeight: number | undefined
          if (options.resolution) {
            targetWidth = options.resolution.width
            targetHeight = options.resolution.height
          }

          // 4. 检查尺寸并预估点数
          const sharp = require('sharp')
          const metadata = await sharp(Buffer.from(image.buffer)).metadata()
          const alignTo64 = (size: number) => Math.ceil(size / 64) * 64
          const alignedWidth = targetWidth ? alignTo64(targetWidth) : alignTo64(metadata.width)
          const alignedHeight = targetHeight ? alignTo64(targetHeight) : alignTo64(metadata.height)

          const maxPixels = session.resolve(config.maxPixels) ?? 3211264
          const clamped = clampToNAILimit(alignedWidth, alignedHeight, maxPixels)
          if (clamped.clamped) {
            return { input, error: session.text('commands.novelai.messages.inpaint-size-exceeded', [alignedWidth, alignedHeight, clamped.recommendedWidth, clamped.recommendedHeight]) }
          }

          let costInfo = ''
          if (config.pointsEnabled) {
            const drawCount = getTaskDrawCount(options)
            const pointsCost = calculateTaskPointsCost(
              runtime, session, options, alignedWidth, alignedHeight, true, 0,
              session.userId, options.model || config.model, drawCount,
            ).total
            costInfo = session.text('commands.novelai.messages.inpaint-cost-info', [pointsCost])
          }

          const darkenResult = await darkenImage(image, 0.5, targetWidth, targetHeight) as any

          // 5. 发送调暗后的图片给用户
          await session.send(h('', [
            h.text(session.text('commands.novelai.messages.inpaint-step1', [alignedWidth, alignedHeight, costInfo])),
            h.image(darkenResult.dataUrl)
          ]))

          // 6. 等待用户发送涂白的图片（在队列外等待，不占用资源）
          // ⚠️ 此时函数暂停执行，darkenResult 被闭包保留
          const maskSrc = await promptForImage(session, 120000)
          if (maskSrc === undefined) {
            return { input, error: session.text('commands.novelai.messages.inpaint-timeout') }
          }

          // 7. 确认蒙版图片
          if (!maskSrc) {
            return { input, error: session.text('commands.novelai.messages.inpaint-no-mask') }
          }
          let maskUrl = maskSrc

          // 8. 下载用户涂白的图片（带重试：如果蒙版图下载失败，提示用户重新发送）
          let maskImageData: ImageData
          try {
            maskImageData = await download(ctx, maskUrl)
          } catch (err) {
            ctx.logger.warn(`[Inpaint] 蒙版图下载失败: ${err}`)
            await session.send(session.text('commands.novelai.messages.inpaint-mask-download-failed'))
            const retryMaskUrl = await promptForImage(session, 120000)
            if (retryMaskUrl === undefined) {
              return { input, error: session.text('commands.novelai.messages.inpaint-timeout') }
            }
            if (!retryMaskUrl) {
              return { input, error: session.text('commands.novelai.messages.inpaint-no-mask') }
            }
            maskUrl = retryMaskUrl
            maskImageData = await download(ctx, maskUrl)
          }

          // 9. 使用防伪影算法提取遮罩
          const maskBase64 = await extractMaskWithAntiArtifact(
            maskImageData,
            darkenResult.alignedWidth,
            darkenResult.alignedHeight
          )

            // 10. 保存 URL 到 options 中（供重画功能使用，避免存储 Base64 占用内存）
            ; (options as any)._originalUrl = imgUrl
            ; (options as any)._maskUrl = maskUrl

            // 11. 保存遮罩和原图到options中（这些会传递给 generateImage）
            ; (options as any)._maskBase64 = maskBase64
            ; (options as any)._originalBase64 = darkenResult.originalBuffer.toString('base64')
            ; (options as any)._alignedWidth = darkenResult.alignedWidth
            ; (options as any)._alignedHeight = darkenResult.alignedHeight

          if (config.debugLog) {
            ctx.logger.info(`[Inpaint] 交互完成，成功提取遮罩，尺寸: ${darkenResult.alignedWidth}x${darkenResult.alignedHeight}，mask大小: ${maskBase64.length} 字节${darkenResult.sizeClamped ? '（已自动缩小）' : ''}`)
          }
        } catch (err) {
          ctx.logger.error(err)
          if (err instanceof NetworkError) {
            return { input, error: session.text(err.message, err.params) }
          }
          return { input, error: session.text('commands.novelai.messages.inpaint-error') }
        }
      }
  return { input }
}
