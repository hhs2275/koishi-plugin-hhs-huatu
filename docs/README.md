# HHS绘图插件 - 文档网站

这是 HHS绘图插件的在线文档网站，基于 VitePress 构建。

## 本地预览

### 安装依赖

```bash
cd docs
npm install
# 或
yarn install
```

### 运行开发服务器

```bash
npm run dev
```

访问 http://localhost:5173 查看文档。

### 构建生产版本

```bash
npm run build
```

构建产物会输出到 `docs/.vitepress/dist` 目录。

### 预览生产版本

```bash
npm run preview
```

## 文档结构

```
docs/
├── .vitepress/
│   ├── config.ts           # VitePress 配置
│   └── theme/
│       ├── index.ts        # 主题配置
│       └── custom.css      # 自定义样式
├── guide/
│   ├── getting-started.md  # 快速开始
│   ├── basic-commands.md   # 基础指令
│   ├── features.md         # 功能介绍
│   ├── characters.md       # 角色提示词
│   ├── membership.md       # 会员系统
│   ├── queue.md            # 队列系统
│   ├── audit.md            # 图片审核
│   ├── tencent-audit.md    # 腾讯云配置
│   ├── config.md           # 配置选项
│   ├── faq.md              # 常见问题
│   └── changelog.md        # 更新日志
├── public/
│   └── logo.png            # Logo 图片（需替换）
└── index.md                # 首页
```

## 部署

### GitHub Pages

1. 在 `.vitepress/config.ts` 中设置正确的 `base` 路径
2. 运行 `npm run build`
3. 将 `.vitepress/dist` 目录部署到 GitHub Pages

### Vercel / Netlify

直接连接 GitHub 仓库，Vercel/Netlify 会自动检测 VitePress 并部署。

### 自定义服务器

```bash
npm run build
# 将 .vitepress/dist 目录上传到服务器
```

## 自定义

### 修改主题颜色

编辑 `docs/.vitepress/theme/custom.css`：

```css
:root {
  --vp-c-brand-1: #3451b2;  /* 主色调 */
  --vp-c-brand-2: #3a5ccc;
  --vp-c-brand-3: #4969e6;
}
```

### 添加 Logo

替换 `docs/public/logo.png` 为你的 Logo 图片。

### 修改配置

编辑 `docs/.vitepress/config.ts` 修改导航、侧边栏等配置。

## 贡献

欢迎改进文档！提交 PR 前请确保：

- 内容准确无误
- 格式规范统一
- 链接可用
- 代码示例可运行

## 相关链接

- [VitePress 文档](https://vitepress.dev/)
- [插件项目](https://github.com/koishijs/koishi-plugin-novelai)
- [交流群](https://qm.qq.com/q/4nKKvckKbu)

