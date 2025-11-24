# 配置选项

本页面详细介绍插件的所有配置选项。

## 登录设置

### 授权令牌模式

```yaml
type: token
token: "your_access_token_here"
```

**多 Token 配置：**

```yaml
type: token
token:
  - "token_1"
  - "token_2"
  - "token_3"
tokenStrategy: round-robin  # 轮询策略
```

**Token 策略说明：**

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| `round-robin` | 轮询使用 | 均衡负载 |
| `random` | 随机选择 | 分散请求 |
| `fallback` | 主用+备用 | 高可用 |
| `parallel` | 并行使用 | 高并发 |

### 账号密码模式

```yaml
type: login
email: "your_email@example.com"
password: "your_password"
```

## 权限设置

```yaml
authLv: 0           # 使用全部功能所需权限等级
authLvDefault: 0    # 使用默认参数所需权限等级
```

## 参数设置

### 模型和采样器

```yaml
model: nai-v3               # 默认模型
sampler: k_euler_a          # 默认采样器
scheduler: karras           # 调度器（v3/v4）
```

### 图片参数

```yaml
scale: 5                    # CFG Scale
rescale: 0                  # CFG Rescale (0-1)
textSteps: 23               # 文本生图步数
imageSteps: 28              # 以图生图步数
maxSteps: 64                # 最大步数限制
strength: 0.7               # 重绘强度 (0-1)
noise: 0.2                  # 噪声强度 (0-1)
resolution: portrait        # 默认分辨率
maxResolution: 1920         # 最大分辨率限制
```

### v3 特有参数

```yaml
smea: false                 # 启用 SMEA
smeaDyn: false              # 启用 SMEA DYN
```

### v4 特有参数

```yaml
decrisper: false            # 启用 Decrisper
```

## 提示词设置

### 基础提示词

```yaml
basePrompt: "best quality, amazing quality, very aesthetic, absurdres"
negativePrompt: "nsfw, lowres, bad quality, watermark..."
placement: after            # 附加位置：before / after
```

### 高级选项

```yaml
forbidden: ""               # 违禁词列表（逗号分隔）
defaultPromptSw: false      # 启用默认提示词
defaultPrompt: ""           # 默认提示词
translator: false           # 启用自动翻译
latinOnly: false            # 只接受英文输入
lowerCase: true             # 转换为小写
maxWords: 0                 # 最大单词数（0=不限制）
```

## 功能设置

```yaml
features:
  text: true                # 启用文本生图
  image: true               # 启用图片生图
  anlas: true               # 允许使用点数（NAI）
  upscale: true             # 启用图片放大（SD-WebUI）
```

## 高级设置

### 输出和重试

```yaml
output: default             # 输出模式：minimal / default / verbose
maxIterations: 1            # 最大绘制次数
maxRetryCount: 3            # 连接失败重试次数
requestTimeout: 60000       # 请求超时（毫秒）
recallTimeout: 0            # 图片自动撤回时间（0=禁用）
maxConcurrency: 0           # 单频道最大并发（0=不限制）
debugLog: false             # 调试日志开关
```

### 队列系统

```yaml
maxQueueSize: 50            # 最大队列数量
maxUserQueueSize: 3         # 单用户最大队列数
penaltyCooldown: 300000     # 超出限制的惩罚CD（毫秒）
maxRedrawCount: 2           # 单次最大重画数量
resetQueueAuth: 3           # 重置队列所需权限
maxConcurrentRequests: 1    # 最大并发请求数
showQueueInfo: true         # 显示队列提示信息
```

## 会员系统设置

### 基础配置

```yaml
membershipEnabled: false          # 启用会员系统
nonMemberDailyLimit: 5            # 非会员每日限额
memberDailyLimit: 0               # 会员每日限额（0=无限）
membershipAuthLv: 3               # 管理会员所需权限
nonMemberCooldown: 60             # 非会员冷却时间（秒）
memberCooldown: 0                 # 会员冷却时间（秒）
```

### 自动清理

```yaml
memberCleanupEnabled: true        # 启用自动清理
memberCleanupTime: "00:00"        # 清理时间（HH:MM）
cleanupNonMembers: true           # 清理非会员数据
nonMemberInactiveDays: 7          # 非会员不活跃天数阈值
```

### 到期提醒

```yaml
memberExpiryReminderEnabled: false  # 启用到期提醒
memberReminderTime: "12:00"         # 提醒时间（HH:MM）
memberReminderHours: 24             # 提前提醒小时数
memberReminderGroups: []            # 接收提醒的群组ID列表
```

### 调试功能

```yaml
memberDebugCommandEnabled: false    # 启用调试指令
memberDebugCommandAuthLv: 4         # 调试指令所需权限
```

## 图片审核设置

### 基础配置

```yaml
imageReviewEnabled: false           # 启用图片审核
imageReviewFailAction: ignore       # 失败处理：block / ignore
muteOnReviewFailed: false          # 审核未通过时禁言
muteTime: 60000                    # 禁言时长（毫秒）
enabledGroups: []                  # 启用审核的群组（空=全部）
```

### 审核引擎

#### 腾讯云配置

```yaml
imageAudit:
  engine: tencent
  secretId: "your_secret_id"
  secretKey: "your_secret_key"
  region: "ap-chengdu"
  bucket: "your_bucket_name"
  bizType: "your_biz_type"
```

#### API4AI 配置

```yaml
imageAudit:
  engine: api4ai
  api4ai:
    nsfwThreshold: 0.7      # NSFW阈值（0-1）
```

## 配置示例

### 小型个人Bot

```yaml
type: token
token: "your_token"
model: nai-v4-5-full
sampler: k_euler_a
resolution: portrait
scale: 5
maxIterations: 1
membershipEnabled: false
imageReviewEnabled: false
```

### 中型社区Bot

```yaml
type: token
token:
  - "token_1"
  - "token_2"
tokenStrategy: round-robin
model: nai-v4-5-full

# 队列限制
maxQueueSize: 50
maxUserQueueSize: 3
maxConcurrentRequests: 2

# 会员系统
membershipEnabled: true
nonMemberDailyLimit: 5
memberDailyLimit: 0
nonMemberCooldown: 60
memberCooldown: 0

# 自动清理
memberCleanupEnabled: true
memberCleanupTime: "02:00"
```

### 大型公共Bot

```yaml
type: token
token:
  - "token_1"
  - "token_2"
  - "token_3"
  - "token_4"
tokenStrategy: parallel

# 严格限制
maxQueueSize: 100
maxUserQueueSize: 2
penaltyCooldown: 600000
maxConcurrentRequests: 4

# 会员系统
membershipEnabled: true
nonMemberDailyLimit: 3
memberDailyLimit: 30
nonMemberCooldown: 120
memberCooldown: 10

# 图片审核
imageReviewEnabled: true
imageReviewFailAction: block
muteOnReviewFailed: true
muteTime: 300000

# 自动清理和提醒
memberCleanupEnabled: true
cleanupNonMembers: true
nonMemberInactiveDays: 3
memberExpiryReminderEnabled: true
memberReminderHours: 48
```

## 性能调优

### 提高并发能力

1. 配置多个 Token
2. 使用 `parallel` 或 `round-robin` 策略
3. 增加 `maxConcurrentRequests`

### 降低服务器负载

1. 限制队列大小
2. 增加冷却时间
3. 启用会员系统，限制非会员使用

### 优化用户体验

1. 合理设置超时时间
2. 显示队列提示信息
3. 提供清晰的错误提示

## 下一步

- [了解会员系统](/guide/membership)
- [配置图片审核](/guide/audit)
- [查看常见问题](/guide/faq)

