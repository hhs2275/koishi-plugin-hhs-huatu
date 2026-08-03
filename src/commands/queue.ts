// 队列相关命令：重置用户队列状态、查询队列
import { Context } from 'koishi'
import { Config } from '../config'
import { Runtime } from '../runtime'

export function registerQueue(ctx: Context, config: Config, runtime: Runtime) {
  const { queueSystem } = runtime
  ctx.command('novelai.reset-queue <user>', '重置用户队列状态', { authority: 3 })
    .action(({ session }, user) => {
      const targetUserId = user?.replace(/^@|&#\d+;?/g, '')
      if (!targetUserId) return '请输入要重置的用户ID'

      queueSystem.resetUserQueue(targetUserId)
      return `已重置用户 ${targetUserId} 的队列状态`
    })

  // 添加查询nai队列指令
  ctx.command('novelai.queue', '查询nai队列状态')
    .alias('查队列', '查询队列', '查nai队列')
    .action(async ({ session }) => {
      const userId = session.userId
      const { totalWaiting, userQueue } = queueSystem.getQueueStatus(userId)

      return session.text('commands.novelai.messages.queue-position', [
        totalWaiting,
        userQueue
      ])
    })
}