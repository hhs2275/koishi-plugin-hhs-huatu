# 局部重绘(Inpainting)功能实现文档

## 功能概述

本插件实现了NovelAI的局部重绘功能,采用**防伪影处理算法**,有效避免重绘边缘出现接缝和伪影问题。

## 使用方法

### 基本流程

```bash
# 1. 发送命令和原图
nai -M [提示词] [原图]

# 2. 机器人返回调暗的图片
# 3. 用户使用白色画笔涂抹需要重绘的区域
# 4. 用户发送涂鸦后的图片
# 5. 机器人自动生成重绘结果
```

### 完整示例

```bash
# 基本使用
nai -M 1girl, beautiful [原图]

# 配合参数
nai -M -N 0.8 -n 0.1 fantasy景 [原图]

# 使用不同模型
nai4 -M修复脸部 [原图]
nai4-5 -M改变发色 [原图]
```

## 核心技术实现

###  1. 图片预处理 (`preprocessInpaintImage`)

**目的**: 对齐尺寸并生成暗图

```typescript
{
  cleanBuffer: Buffer  // 对齐后的原图(用于API)
  darkBuffer: Buffer   // 调暗的图片(用于用户涂鸦)
  width: number        // 对齐后的宽度
  height: number       // 对齐后的高度
}
```

**处理步骤**:
1. 读取原图尺寸
2. **尺寸对齐**: 使用 `Math.ceil(size / 64) * 64` 对齐到64的倍数
3. **Resize原图**: 使用 `lanczos3` 插值算法调整到对齐后的尺寸
4. **生成暗图**: 将亮度降低到 `0.4` (原亮度的40%)

**为什么要对齐到64?**
- NovelAI API严格要求宽高必须是64的倍数
- 保证原图和蒙版尺寸完全一致
- 避免尺寸不匹配导致的API错误

### 2. 防伪影蒙版提取 (`extractInpaintMask`)

**这是核心算法**, 使用sharp的操作链防止边缘伪影:

```typescript
sharp(buffer)
  .resize(targetWidth, targetHeight)  // 1. 确保尺寸一致
  .grayscale()                        // 2. 转灰度
  .threshold(150)                     // 3. 初步二值化
  .blur(3.0)                          // 4. ⭐ 高斯模糊(关键)
  .threshold(50)                      // 5. 二次二值化
  .toFormat('png')                    // 6. 输出PNG
```

**各步骤作用**:

| 步骤 | 函数 | 作用 | 参数说明 |
|-----|------|------|---------|
| 1 | `.resize()` | 确保与原图尺寸一致 | 使用对齐后的宽高 |
| 2 | `.grayscale()` | 去除颜色干扰 | 只保留亮度信息 |
| 3 | `.threshold(150)` | 提取白色涂鸦区域 | >150的像素变白,其他变黑 |
| 4 | `.blur(3.0)` | **模拟形态学膨胀** | 向外扩展3-5像素,覆盖接缝 |
| 5 | `.threshold(50)` | 硬化边缘 | 将模糊后的灰色重新二值化 |
| 6 | `.toFormat('png')` | 输出标准格式 | 确保兼容性 |

**为什么用blur而不是传统的dilation?**
- 高斯模糊产生的渐变边缘更自然
- 第二次threshold后,既保留了膨胀效果,又保证了纯黑纯白
- 性能更好,代码更简洁

### 3. Payload 生成

**关键点**: 
- 使用对齐后的 `cleanBuffer`,而非原始图片
- 使用对齐后的精确宽高
- 确保 `image`、`mask`、`width`、`height` 完全匹配

```typescript
{
  model: "nai-diffusion-3-inpainting",
  action: "infill",
  parameters: {
    image: cleanBuffer.toString('base64'),
    mask: maskBase64,
    width: 对齐后的宽度,
    height: 对齐后的高度,
    strength: 0.7,
    noise: 0.2,
    extra_noise_seed: seed,
    color_correct: false,
    add_original_image: false
  }
}
```

## 支持的模型

| 基础模型 | Inpainting模型 |
|---------|---------------|
| nai-diffusion-3 | nai-diffusion-3-inpainting |
| nai-diffusion-furry-3 | nai-diffusion-furry-3-inpainting |
| nai-diffusion-4-full | nai-diffusion-4-full-inpainting |
| nai-diffusion-4-curated-preview | nai-diffusion-4-curated-preview-inpainting |
| nai-diffusion-4-5-full | nai-diffusion-4-5-full-inpainting |
| nai-diffusion-4-5-curated | nai-diffusion-4-5-curated-inpainting |

**自动转换**: 插件会自动在模型名后添加 `-inpainting` 后缀

## 参数说明

### 命令行参数

```bash
-M                # 启用局部重绘模式
-N <strength>     # 重画强度 (0-1, 默认0.7)
-n <noise>        # 噪声强度 (0-1, 默认0.2)  
-x <seed>         # 随机种子
-t <steps>        # 迭代步数 (默认28)
-c <scale>        # CFG Scale (默认5)
```

### 配置参数

| 参数 | 默认值 | 说明 |
|-----|-------|------|
| 亮度系数 | 0.4 | 暗图的亮度(40%) |
| 初次阈值 | 150 | 提取白色涂鸦的阈值 |
| 模糊半径 | 3.0 | 高斯模糊半径(像素) |
| 二次阈值 | 50 | 硬化边缘的阈值 |
| 超时时间 | 60秒 | 等待用户发送的超时 |

## 交互流程详解

### 用户视角

1. **发送命令**: `nai -M 修复手部 [图片]`
2. **收到暗图**: 机器人发送调暗的图片
3. **涂鸦**: 使用画图工具,用**白色画笔**涂抹需要重绘的手部区域
4. **发送涂鸦图**: 将涂好的图片发给机器人
5. **获得结果**: 机器人返回重绘后的图片

### 技术流程

```
用户发送 → 下载原图 → 预处理(对齐+调暗) → 发送暗图
   ↓
等待用户涂鸦(60秒)
   ↓
接收涂鸦图 → 防伪影蒙版提取 → 构建Payload → 调用API
   ↓
返回结果
```

## 错误处理

| 错误场景 | 提示信息 |
|---------|---------|
| 未提供图片 | "请输入图片" |
| 等待超时 | "等待超时(60秒),局部重绘已取消" |
| 未检测到涂鸦图 | "未检测到图片,请重新发送" |
| 处理失败 | "局部重绘处理失败,请重试" |

## 调试日志

启用 `debugLog` 后的输出:

```
[Inpaint] 已发送暗图,对齐后尺寸: 1024x1024
[Inpaint] 成功提取蒙版,大小: 12345 字节
[Inpaint] 使用局部重绘模式: action=infill, model=nai-diffusion-3-inpainting
[Inpaint] 添加遮罩参数,mask大小: 12345 字节
```

## 文件结构

```
src/
├── utils.ts           # 图片处理函数
│   ├── alignTo64()                 # 尺寸对齐
│   ├── preprocessInpaintImage()    # 预处理原图
│   ├── extractInpaintMask()        # 蒙版提取
│   └── bufferToDataURL()           # Buffer转换
│
├── index.ts           # 主逻辑
│   ├── inpaintSessions Map        # 会话隔离
│   ├── 交互流程                    # prompt等待
│   └── payload生成                 # API请求
│
└── locales/
    └── zh-CN.yml      # 中文提示
```

## 性能优化

1. **尺寸对齐**: 避免API调用时的尺寸错误,减少重试
2. **使用sharp**: 高性能图片处理库,比canvas快10倍以上
3. **操作链优化**: 一次性完成所有图片处理,减少内存拷贝
4. **会话隔离**: Map存储,避免多用户冲突

## 最佳实践

### 涂鸦技巧

1. **画笔颜色**: 必须使用纯白色 (#FFFFFF)
2. **涂抹范围**: 略大于需要修改的区域(因为会自动膨胀)
3. **边缘处理**: 不需要太精确,模糊算法会自动优化边缘
4. **复杂区域**: 可以涂满整个需要修改的区域

### 参数调节

| 场景 | 推荐参数 |
|-----|---------|
| 微调细节 | `-N 0.5 -n 0.1` |
| 大幅修改 | `-N 0.9 -n 0.3` |
| 修复脸部 | `-N 0.7 -n 0.1` |
| 改变背景 | `-N 0.8 -n 0.2` |

## 常见问题

**Q: 为什么重绘后有接缝?**
A: 可能是蒙版膨胀不够,可以涂粗一点,或检查blur参数

**Q: 尺寸不匹配错误?**
A: 插件会自动对齐到64倍数,理论上不会出现此问题

**Q: 涂鸦后什么都没变?**
A: 检查是否使用了纯白色画笔,可以尝试增加strength参数

**Q: 可以用其他颜色涂吗?**
A: 不行,必须用白色,因为threshold(150)只识别高亮度像素

## 与旧版本的区别

| 特性 | 旧版 | 新版(防伪影) |
|-----|------|------------|
| 暗图亮度 | 0.5 | 0.4 |
| 蒙版提取 | 简单threshold | 多步骤防伪影算法 |
| 尺寸处理 | 未对齐 | 强制对齐到64倍数 |
| 膨胀方法 | 手动循环 | 高斯模糊+二值化 |
| 边缘质量 | 可能有伪影 | 几乎无伪影 |

## 技术依赖

- **sharp ^0.33.0**: 图片处理核心库
- **Koishi ^4.18.7**: 框架依赖
- **TypeScript**: 类型安全

## 未来优化方向

1. 支持多种蒙版生成方式(如Segment Anything)
2. 提供蒙版预览功能
3. 支持批量局部重绘
4. 添加自动边缘检测
5. 支持调节膨胀程度

---

**核心优势总结**:
- ✅ 防伪影算法,边缘过渡自然
- ✅ 自动尺寸对齐,避免API错误
- ✅ 高性能sharp处理,速度快
- ✅ 多用户隔离,对话式交互
- ✅ 完整的错误处理和日志
