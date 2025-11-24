# 快速开始

欢迎使用 HHS绘图插件！本页面将帮助你快速上手。

## 安装

### 通过插件市场安装（推荐）

1. 打开 Koishi 控制台
2. 进入「插件市场」
3. 搜索 `hhs-huatu`
4. 点击「安装」按钮
5. 等待安装完成后，启用插件

### 手动安装

```bash
# 使用 npm
npm install koishi-plugin-hhs-huatu

# 使用 yarn
yarn add koishi-plugin-hhs-huatu

# 使用 pnpm
pnpm add koishi-plugin-hhs-huatu
```

## 配置

### 基础配置

安装完成后，你需要配置 NovelAI 的访问权限：

1. 进入插件配置页面
2. 选择登录方式：
   - **授权令牌**：使用 NovelAI 的 Access Token
   - **账号密码**：使用 NovelAI 账号直接登录

#### 获取 Access Token

1. 登录 [NovelAI 官网](https://novelai.net/)
2. 按 `F12` 打开开发者工具
3. 切换到 `Application` / `应用程序` 标签
4. 在左侧找到 `Local Storage` > `https://novelai.net`
5. 找到 `auth_token` 项，复制其值
6. 粘贴到插件配置的「授权令牌」字段

### 快速测试

配置完成后，发送以下指令测试：

```bash
nai masterpiece, best quality, 1girl, smile
```

如果一切正常，机器人会生成一张图片发送给你。

## 基本使用

### 简单绘图

```bash
# 使用默认模型
nai beautiful landscape, mountains, sunset

# 指定分辨率
nai 1girl, portrait -r portrait

# 添加负向提示词
nai cute cat -u ugly, bad quality
```

### 使用不同模型

插件提供了多个快捷指令：

```bash
nai4    # NovelAI v4 Full
nai4c   # NovelAI v4 Curated
nai4-5  # NovelAI v4.5 Full
nai4-5c # NovelAI v4.5 Curated
```

### 常用参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `-m` | 指定模型 | `-m nai-v4-5-full` |
| `-r` | 分辨率 | `-r portrait` 或 `-r 832x1216` |
| `-s` | 采样器 | `-s k_euler_a` |
| `-t` | 迭代步数 | `-t 28` |
| `-x` | 随机种子 | `-x 123456` |
| `-c` | CFG Scale | `-c 7` |
| `-R` | CFG Rescale | `-R 0.5` |
| `-u` | 负向提示词 | `-u bad quality` |

## 下一步

- [查看所有功能](/guide/features)
- [学习角色提示词](/guide/characters)
- [了解会员系统](/guide/membership)
- [查看常见问题](/guide/faq)

## 获取帮助

遇到问题？

- 发送 `help nai` 查看指令帮助
- 加入QQ群：[112879548](https://qm.qq.com/q/4nKKvckKbu)
- 联系作者QQ：2275438102

