import { Session } from 'koishi'
import { Runtime } from '../runtime'

/**
 * 根据生成目标尺寸、步数、采样优化选项等计算本次任务的点数消耗。
 * 与调用方原有的启用开关（pointsEnabled / membershipEnabled）无关，
 * 由调用方自行判断是否需要计算。
 */
export function calculatePointsCost(
  runtime: Runtime,
  session: Session,
  options: any,
  width: number,
  height: number,
  isImg2Img: boolean,
  preciseRefCount: number = 0,
  chargeOpusFreeRange: boolean = false,
): number {
  const steps = options.steps ?? session.resolve(isImg2Img ? runtime.config.imageSteps : runtime.config.textSteps) ?? 23
  const { batch = 1, iterations = 1 } = options
  const total = batch * iterations
  const resolvedSmeaDyn = options.smeaDyn ?? runtime.config.smeaDyn ?? false
  const resolvedSmea = (options.smea ?? runtime.config.smea) || resolvedSmeaDyn

  return runtime.membershipSystem.calculatePointsCost({
    width,
    height,
    steps,
    smea: resolvedSmea,
    smeaDyn: resolvedSmeaDyn,
    strength: options.strength,
    isImg2Img,
    preciseRefCount,
    chargeOpusFreeRange,
  }) * total
}

/**
 * nai5 日限内按 Opus 免费档计费；超出部分跳过免费档，按 Anlas 估算扣点。
 * 非 nai5 或未启用日限时，全部按免费档规则计算。
 */
function getUnitPointsCost(
  runtime: Runtime,
  session: Session,
  options: any,
  width: number,
  height: number,
  isImg2Img: boolean,
  preciseRefCount: number,
  chargeOpusFreeRange: boolean = false,
): number {
  const steps = options.steps ?? session.resolve(isImg2Img ? runtime.config.imageSteps : runtime.config.textSteps) ?? 23
  const resolvedSmeaDyn = options.smeaDyn ?? runtime.config.smeaDyn ?? false
  const resolvedSmea = (options.smea ?? runtime.config.smea) || resolvedSmeaDyn

  return runtime.membershipSystem.calculatePointsCost({
    width,
    height,
    steps,
    smea: resolvedSmea,
    smeaDyn: resolvedSmeaDyn,
    strength: options.strength,
    isImg2Img,
    preciseRefCount,
    chargeOpusFreeRange,
  })
}

export function calculateTaskPointsCost(
  runtime: Runtime,
  session: Session,
  options: any,
  width: number,
  height: number,
  isImg2Img: boolean,
  preciseRefCount: number = 0,
  userId?: string,
  model?: string,
  drawCount: number = 1,
): { total: number; perImage: number[] } {
  const uid = userId || session.userId
  const resolvedModel = model ?? options.model
  const count = Math.max(1, drawCount)
  const unitFree = getUnitPointsCost(runtime, session, options, width, height, isImg2Img, preciseRefCount)
  const perImage: number[] = []

  if (!runtime.membershipSystem.isNai5Model(resolvedModel)) {
    for (let i = 0; i < count; i++) perImage.push(unitFree)
    return { total: unitFree * count, perImage }
  }

  const overageCount = runtime.membershipSystem.getNai5OverageCount(uid, count)
  const freeCount = count - overageCount
  const unitOverage = overageCount > 0
    ? getUnitPointsCost(runtime, session, options, width, height, isImg2Img, preciseRefCount, true)
    : unitFree

  for (let i = 0; i < freeCount; i++) perImage.push(unitFree)
  for (let i = 0; i < overageCount; i++) perImage.push(unitOverage)

  return {
    total: unitFree * freeCount + unitOverage * overageCount,
    perImage,
  }
}

export function getTaskDrawCount(options: any, extraCount: number = 1): number {
  const { batch = 1, iterations = 1 } = options || {}
  return Math.max(1, extraCount) * batch * iterations
}
