---
layout: home

hero:
  name: HHS绘图插件
  text: NovelAI 增强版
  tagline: 基于 novelai-bot 二次开发，提供更强大的AI绘图功能
  image:
    src: /logo.png
    alt: HHS绘图
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 功能介绍
      link: /guide/features
    - theme: alt
      text: 加入交流群
      link: https://qm.qq.com/q/4nKKvckKbu

features:
  - icon: 🎨
    title: 角色提示词功能
    details: 支持为图像中的不同角色指定独立的提示词和位置，让你的创作更精确
  - icon: 📋
    title: 智能队列系统
    details: 解决多用户并发时的429错误，支持限制队列数量和单用户队列数量
  - icon: 🔄
    title: 便捷重画功能
    details: 一键重新生成之前的作品，支持灵活的指令格式
  - icon: 👥
    title: 会员系统
    details: 完善的会员管理，支持差异化服务、自动清理和到期提醒
  - icon: 🛡️
    title: 图片审核系统
    details: 自动审核生成的图片，支持腾讯云和 API4AI，保障内容安全
  - icon: ⚙️
    title: 高度可配置
    details: 丰富的配置选项，支持多模型、多参数调整，满足不同需求
---

## 快速上手

### 安装插件

在 Koishi 控制台的插件市场中搜索 `hhs-huatu`，点击安装即可。

### 基本使用

```bash
# 基础绘图
nai masterpiece, 1girl, smile

# 使用 v4.5 模型
nai4-5 beautiful landscape, mountains

# 角色提示词（v4/v4.5 专属）
nai4 scene -K "1girl, red hair@B3;1boy, blue hair@D3"
```

### 获取帮助

```bash
help nai      # 查看基础指令
help 会员     # 查看会员相关功能
```

## 社区支持

- **QQ交流群**: [112879548](https://qm.qq.com/q/4nKKvckKbu)
- **作者QQ**: 2275438102
- **GitHub**: [插件仓库](https://github.com/koishijs/koishi-plugin-novelai)

---

<div style="text-align: center; margin-top: 40px; color: #888;">
  <p>基于 <a href="https://bot.novelai.dev/" target="_blank">novelai-bot</a> 项目开发</p>
  <p>使用 MIT 许可证开源</p>
</div>

