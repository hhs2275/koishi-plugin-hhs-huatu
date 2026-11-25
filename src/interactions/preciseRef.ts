// 精准参考交互：在入队前收集并处理参考图。
import { h, Session } from 'koishi'
import { modelMap } from '../config'
import * as v5Reference from '../services/preciseReferenceV5'
import { Runtime } from '../runtime'
import { download, modelSupportsCharacterReference, NetworkError, processCharacterReferenceImage } from '../utils'

export async function runPreciseRefInteraction(
  runtime: Runtime,
  session: Session<'authority'>,
  options: any,
): Promise<string | undefined> {
  if (!options.preciseRef) return
  const { ctx, config } = runtime
  const message = (key: string) => session.text(`commands.novelai.messages.${key}`)

  try {
    const currentModel = modelMap[options.model] || modelMap[config.model] || 'nai-diffusion-4-5-full'
    const usageError = v5Reference.usageError(currentModel, config.type, options.inpaint)
    if (usageError) return session.text(usageError)

    const isV5 = v5Reference.supports(currentModel)
    if (!isV5 && !modelSupportsCharacterReference(currentModel)) return message('charref-model-unsupported')
    if (isV5 && !v5Reference.settings(options.preciseRefParams)) return message('preciseref-v5-params')

    const collectedImages: { base64: string, url: string, width: number, height: number }[] = []
    let failedCount = 0
    const maxLimit = v5Reference.MAX_REFERENCES

    await session.send(message('preciseref-wait-image'))

    while (collectedImages.length + failedCount < maxLimit) {
      const reply = await session.prompt((s) => {
        const elements = s.elements ?? []
        const text = elements
          .filter(el => el.type === 'text')
          .map(el => el.attrs.content)
          .join('')
          .trim()
        const urls = h.select(elements, 'img').map(el => el.attrs.src)
        return { text, urls }
      }, { timeout: 60000 })

      if (!reply) return message('charref-timeout')
      const command = reply.text.toLowerCase()
      if (command === '取消' || command === 'cancel') return '已取消精准参考任务。'
      if (command === '开始' || command === 'start') break

      for (const url of reply.urls) {
        if (collectedImages.length + failedCount >= maxLimit) break
        try {
          const refImage = await download(ctx, url)
          const prepared = isV5 ? await v5Reference.prepare(refImage) : await processCharacterReferenceImage(refImage)
          collectedImages.push({ ...prepared, url })
        } catch (err) {
          ctx.logger.error(err)
          // 保留 V4.5 的处理方式；V5 收图失败可以补发，不消耗名额。
          if (!isV5) failedCount++
          await session.send(`1张图片收集失败，已收集${collectedImages.length}张图片`)
          continue
        }
        await session.send(`成功收集1张图片，已收集${collectedImages.length}张图片`)
      }
    }

    if (!collectedImages.length) return message('charref-no-image')
    if (isV5 && !v5Reference.settings(options.preciseRefParams, collectedImages.length)) {
      return message('preciseref-v5-extra-params')
    }
    options._preciseRefImages = collectedImages
    options._preciseRefParams = options.preciseRefParams

    if (config.debugLog) ctx.logger.info(`[PreciseRef] 交互完成，共收集 ${collectedImages.length} 张图片`)
  } catch (err) {
    ctx.logger.error(err)
    if (err instanceof NetworkError) return session.text(err.message, err.params)
    return message('charref-error')
  }
}
