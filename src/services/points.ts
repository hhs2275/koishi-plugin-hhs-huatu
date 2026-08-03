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
  }) * total
}
