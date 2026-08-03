import { Context } from 'koishi'
import { Config } from './config'
import { } from '@koishijs/translator'
import { } from '@koishijs/plugin-help'
import { createRuntime, Runtime } from './runtime'
import { generateImage } from './services/generateImage'
import { registerNovelai } from './commands/novelai'
import { registerRedraw } from './commands/redraw'
import { registerQueue } from './commands/queue'
import { registerMember } from './commands/member'
import { registerDirector } from './commands/director'
import { registerAccount } from './commands/account'

export const usage = `
# 🎨 hhs-huatu 插件

> **基于 [novelai-bot](https://bot.novelai.dev/) 的增强版 AI 绘图插件，提供更智能、便捷的 NovelAI 体验。**

[![](https://img.shields.io/badge/QQ群-112879548-blue)](https://qm.qq.com/q/4nKKvckKbu) [![](https://img.shields.io/badge/GitHub-仓库地址-black)](https://github.com/hhs2275/koishi-plugin-hhs-huatu)

### ✨ 核心亮点
新版本改用数据库。你的会员数据在 你的 Koishi 根目录/data/hhs-huatu-user-data.json。把它放在hhs-huatu-import文件夹下面，然后发“会员调试--import”指令，就可以把数据导入数据库。

本插件针对 **NovelAI V4 & V4.5** 模型进行了深度适配，预设快捷指令，助你快速切换模型：

| 指令 | 对应模型 (Model) | 说明 |
| :--- | :--- | :--- |
| \`nai4\` | \`nai-diffusion-4-full\` | V4 全量模型 |
| \`nai4c\` | \`nai-diffusion-4-curated\` | V4 精选模型 |
| \`nai4-5\` | \`nai-diffusion-4-5-full\` | V4.5 全量模型 |
| \`nai4-5c\` | \`nai-diffusion-4-5-curated\` | V4.5 精选模型 |

### 🛠️ 功能列表

**🎨 绘图核心**
* **全面支持**：文生图、图生图基础功能完整。
* **局部重绘 (Inpaint)**：支持对图片特定区域进行重绘。
* **导演工具**：novelai官网的导演工具功能。
* **V4 角色提示词**：novelai官网的多角色提示词系统。

**⚙️ 系统与管理**
* **高并发优化**：内置队列系统与 Token 池轮询，多账号负载均衡。
* **会员管理**：支持用户分级管理。
* **智能审核**：集成腾讯 AI 或 API4AI，自动过滤违规内容。

### 🗓️ 开发计划
- [√] **点数控制系统**：精细化控制用户点数消耗进行本地计算，可能存在误差，请以实际扣费为准。
- [x] ~~**氛围传输功能**：实现novelai官网的氛围传输功能。v4版本的风味传输api不允许直接发图，需要先去官网生成对应文件，我做不到。~~
- [√] **角色参考功能**：实现novelai官网的角色参考功能。（已被精确参考替代）
---

### 📖 更多资源
* 详细教程请移步 [GitHub 仓库](https://github.com/hhs2275/koishi-plugin-hhs-huatu)
* 遇到问题？欢迎加入交流群：[112879548](https://qm.qq.com/q/4nKKvckKbu) (联系群主反馈问题/提交建议/愉快玩耍)
`
export * from './config'

export const reactive = true
export const name = 'hhs-huatu'

export const inject = {
  required: ['http', 'database'],
  optional: ['translator'],
}

export function apply(ctx: Context, config: Config) {
  // 创建共享运行时状态（会员系统、队列、token、辅助函数等）
  const runtime: Runtime = createRuntime(ctx, config)

  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))
  ctx.i18n.define('zh-TW', require('./locales/zh-TW'))
  ctx.i18n.define('en-US', require('./locales/en-US'))
  ctx.i18n.define('fr-FR', require('./locales/fr-FR'))
  ctx.i18n.define('ja-JP', require('./locales/ja-JP'))

  // 创建队列系统（generateImage 已在 services/generateImage 中定义）
  runtime.initQueueSystem((session, options, input) => generateImage(runtime, session, options, input))

  registerNovelai(ctx, config, runtime)
  registerRedraw(ctx, config, runtime)
  registerQueue(ctx, config, runtime)
  registerMember(ctx, config, runtime)
  registerDirector(ctx, config, runtime)
  registerAccount(ctx, config, runtime)
}