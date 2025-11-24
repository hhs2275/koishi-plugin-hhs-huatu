# 基础指令

本页面介绍 HHS绘图插件的基础指令用法。

## 绘图指令

### 基本格式

```bash
nai <提示词> [参数]
```

### 快捷指令

| 指令 | 模型 | 说明 |
|------|------|------|
| `nai` | 默认模型 | 使用配置中的默认模型 |
| `nai4` | v4 Full | NovelAI v4 Full 模型 |
| `nai4c` | v4 Curated | NovelAI v4 Curated 模型 |
| `nai4-5` | v4.5 Full | NovelAI v4.5 Full 模型 |
| `nai4-5c` | v4.5 Curated | NovelAI v4.5 Curated 模型 |

## 常用参数

### 模型和分辨率

```bash
# 指定模型
nai scene -m nai-v4-5-full

# 指定分辨率（预设）
nai portrait -r portrait    # 竖图 832x1216
nai landscape -r landscape  # 横图 1216x832
nai scene -r square         # 方图 1024x1024

# 自定义分辨率
nai scene -r 960x1280
```

### 采样器和步数

```bash
# 采样器
nai scene -s k_euler_a
nai scene -s k_dpmpp_2m

# 迭代步数
nai scene -t 28    # 28步（默认）
nai scene -t 40    # 40步（更高质量，更慢）
```

### 种子和生成数量

```bash
# 随机种子（用于复现图片）
nai scene -x 123456

# 批量生成
nai scene -i 3     # 生成3张
nai scene -b 2     # 批次为2
```

### CFG 参数

```bash
# CFG Scale（控制对提示词的服从度）
nai scene -c 5     # 默认5
nai scene -c 7     # 更严格遵循提示词
nai scene -c 3     # 更自由发挥

# CFG Rescale（v4/v4.5 推荐使用）
nai4-5 scene -R 0.3   # 范围 0-1
```

### 提示词

```bash
# 正向提示词（直接输入）
nai beautiful landscape, mountains, sunset, detailed

# 负向提示词（排除不想要的元素）
nai cute cat -u ugly, bad quality, blurry

# 负向提示词也可以很详细
nai portrait -u lowres, bad anatomy, bad hands, text, error, missing fingers
```

## 完整示例

### 基础示例

```bash
# 简单肖像
nai 1girl, portrait, smile

# 风景画
nai beautiful landscape, mountains, lake, sunset, detailed

# 二次元角色
nai 1girl, anime style, long hair, school uniform, outdoor
```

### 进阶示例

```bash
# 高质量肖像
nai4-5 masterpiece, 1girl, detailed face, blue eyes -r portrait -t 35 -c 6 -R 0.3

# 精确控制的场景
nai4 fantasy castle, detailed architecture -r landscape -s k_euler_a -t 28 -c 5 -x 12345

# 排除特定元素
nai cute cat, fluffy, detailed -u ugly, deformed, bad anatomy, blurry -t 28 -c 5
```

### 角色提示词示例

```bash
# 双人场景（v4/v4.5 专属）
nai4 park scene -K "1girl, sitting@B3;1boy, standing@D3"

# 带负向提示的角色
nai4-5 scene -K "princess@C2 --uc:peasant;knight@D3 --uc:weak"
```

## 参数速查表

| 参数 | 说明 | 默认值 | 示例 |
|------|------|--------|------|
| `-m` | 模型 | 配置默认 | `-m nai-v4-5-full` |
| `-r` | 分辨率 | portrait | `-r landscape` |
| `-s` | 采样器 | k_euler_a | `-s k_dpmpp_2m` |
| `-t` | 步数 | 28 | `-t 35` |
| `-x` | 种子 | 随机 | `-x 123456` |
| `-c` | CFG Scale | 5 | `-c 7` |
| `-R` | CFG Rescale | 0 | `-R 0.3` |
| `-u` | 负向提示词 | 配置默认 | `-u bad quality` |
| `-i` | 生成数量 | 1 | `-i 3` |
| `-b` | 批次 | 1 | `-b 2` |
| `-K` | 角色提示词 | 无 | `-K "1girl@B3;1boy@D3"` |

## 会员指令

### 查询状态

```bash
# 查询自己的状态
会员

# 查询指定用户（需管理员权限）
会员 -u <QQ号>
```

### 会员管理（需管理员权限）

```bash
# 授予会员
会员 -u <QQ号> -d <天数>

# 取消会员
会员 -u <QQ号> -c

# 查看会员列表
会员 -l
会员 -l -p 2      # 第二页
会员 -l -s 20     # 每页20条
```

### 会员调试（需配置启用）

```bash
# 查看系统状态
会员调试 -s

# 执行清理任务
会员调试 -c

# 执行提醒任务
会员调试 -r
```

## 管理员指令

### 队列管理

```bash
# 查看队列状态
novelai.queue

# 重置用户队列
novelai.reset-queue <用户ID>
```

## 重画功能

重画上一次生成的图片：

```bash
重画          # 重画1张
重画一下      # 重画1张
重画两张      # 重画2张
重画 3        # 重画3张
重画2张       # 重画2张
```

::: tip 提示
重画功能会自动使用上次的所有参数，包括提示词、模型、分辨率等。
:::

## 帮助指令

```bash
# 查看基础帮助
help nai

# 查看会员帮助
help 会员
```

## 使用技巧

### 1. 提示词书写

- **清晰明确**：使用具体的描述词
- **逗号分隔**：用逗号分隔不同的元素
- **权重控制**：重要的词放在前面
- **避免冲突**：不要使用矛盾的描述

### 2. 参数调整

- **质量优先**：增加步数 (`-t 35`)、调整 CFG (`-c 6-7`)
- **速度优先**：减少步数 (`-t 20`)、使用快速采样器
- **实验性**：保存种子 (`-x`) 方便复现和调整

### 3. 负向提示词

常用的负向提示词：
```
bad quality, lowres, blurry, jpeg artifacts, ugly, bad anatomy
```

### 4. 批量生成

```bash
# 生成3张不同的图
nai scene -i 3

# 生成6张（3次迭代，每次2张）
nai scene -i 3 -b 2
```

## 下一步

- [学习角色提示词](/guide/characters)
- [查看所有功能](/guide/features)
- [配置插件选项](/guide/config)
- [常见问题解答](/guide/faq)

