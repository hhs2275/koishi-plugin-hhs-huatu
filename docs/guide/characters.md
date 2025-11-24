# 角色提示词功能

角色提示词（Characters）是 NovelAI v4/v4.5 模型的专属功能，允许你为图像中的不同角色指定独立的提示词和画面位置。

## 支持的模型

::: tip 仅限 v4/v4.5 模型
此功能仅在以下模型中可用：
:::

- ✅ `nai-diffusion-4-curated-preview` (快捷指令：`nai4c`)
- ✅ `nai-diffusion-4-full` (快捷指令：`nai4`)
- ✅ `nai-diffusion-4-5-curated` (快捷指令：`nai4-5c`)
- ✅ `nai-diffusion-4-5-full` (快捷指令：`nai4-5`)

## 基本用法

### 语法格式

```
nai4 [场景描述] -K "角色1@位置1;角色2@位置2"
```

**分隔符：**
- 使用 `;`（英文分号）或 `；`（中文分号）分隔不同角色
- 两种分号都支持，选择你输入更方便的即可

### 快速示例

```bash
# 两个角色，指定位置
nai4 masterpiece -K "1girl, red hair@B3;1boy, blue hair@D3"

# 使用中文分号
nai4 scene -K "princess, crown@C2；knight, armor@C4"

# 不指定位置（AI自动安排）
nai4 fantasy -K "elf warrior;dwarf miner"
```

## 位置坐标系统

### 坐标表（5×5 网格）

```
     A    B    C    D    E
1   A1   B1   C1   D1   E1  (顶部)
2   A2   B2   C2   D2   E2
3   A3   B3   C3   D3   E3  (中心)
4   A4   B4   C4   D4   E4
5   A5   B5   C5   D5   E5  (底部)
   (左)            (右)
```

### 位置说明

- **横向**：`A`(左) → `B` → `C`(中) → `D` → `E`(右)
- **纵向**：`1`(上) → `2` → `3`(中) → `4` → `5`(下)
- **默认位置**：`C3`（画面中心）

### 常用位置

| 位置 | 说明 | 适用场景 |
|------|------|----------|
| `A1` | 左上角 | 远景角色、背景元素 |
| `E1` | 右上角 | 远景角色、背景元素 |
| `B3` / `D3` | 左中 / 右中 | 双人对话、对峙场景 |
| `C3` | 正中心 | 主角特写、单人肖像 |
| `A5` | 左下角 | 前景角色 |
| `E5` | 右下角 | 前景角色 |

## 高级用法

### 添加负向提示词

使用 `--uc:` 为每个角色指定负向提示词：

```bash
nai4 battle scene -K "hero, sword@B4 --uc:weak, defensive;monster, claws@D2 --uc:cute, friendly"
```

::: tip 负向提示词
负向提示词用于排除不想要的特征，让生成结果更符合预期。
:::

### 多角色场景

```bash
# 三人合照
nai4 group photo -K "tall person, suit@A3;woman, dress@C3;short person, casual@E3"

# 复杂场景
nai4 throne room -K "king, crown@C2 --uc:peasant;queen, elegant@B2;knight, armor@D3 --uc:weak"
```

### 不指定位置

省略 `@位置` 部分，让 AI 自动安排：

```bash
nai4 fantasy adventure -K "elf mage;dwarf warrior;human rogue"
```

::: warning 注意
不指定位置时，所有角色都使用默认的 `C3` 位置，AI 会自动调整它们的相对位置。
:::

## 实用场景示例

### 双人对话

```bash
nai4 park scene -K "1girl, sitting, smiling@B3;1boy, standing, talking@D3"
```

### 对战场景

```bash
nai4 epic battle -K "warrior, attack pose@B4 --uc:static;dragon, breathing fire@D2 --uc:sleeping"
```

### 团队合照

```bash
nai4 studio photo -K "leader@C2;member1@A3;member2@E3;member3@B4;member4@D4"
```

### 主角与背景

```bash
nai4 scene -K "protagonist, detailed@C3 --uc:blurry;background character@E1"
```

## 使用技巧

### 1. 位置选择建议

- **对话场景**：使用 `B3` 和 `D3`（左右站位）
- **对战场景**：使用 `B4` 和 `D2`（对角线站位）
- **合照场景**：均匀分布在不同位置
- **主角特写**：使用 `C3`（中心位置）

### 2. 提示词建议

- **角色提示词**：尽量简洁明确
- **基础提示词**：可以包含场景、光照、画质等全局信息
- **负向提示词**：针对性排除不想要的特征

### 3. 常见问题

**Q: 角色重叠怎么办？**
- 选择相距较远的位置（如 `A1` 和 `E5`）
- 明确指定每个角色的位置

**Q: 为什么角色没有出现在指定位置？**
- 确保使用的是 v4 或 v4.5 模型
- 检查语法是否正确（分号分隔、位置格式）
- 提示词是否太复杂

**Q: 可以有几个角色？**
- 理论上不限，但建议 2-3 个效果最好
- 过多角色可能导致构图混乱

## 完整示例

### 示例 1：双人肖像

```bash
nai4-5 beautiful portrait, studio lighting -K "1girl, long red hair, smile@B3 --uc:frown, messy;1boy, short blue hair, serious@D3 --uc:smile, cheerful"
```

### 示例 2：冒险场景

```bash
nai4 fantasy adventure, forest -K "elf archer, bow@A2;human knight, sword@C3;dwarf warrior, axe@E2"
```

### 示例 3：战斗场景

```bash
nai4 epic battle, dynamic -K "hero, attack@B4 --uc:defensive, static;dragon@D1 --uc:small, cute"
```

## 调试技巧

如果角色功能不生效：

1. **启用调试日志**：在插件配置的「高级设置」中启用「调试日志」
2. **查看日志输出**：检查是否有 `[Characters Debug]` 相关的日志
3. **检查语法**：确保分号、位置格式正确
4. **简化测试**：先用最简单的格式测试

```bash
# 最简单的测试
nai4 test -K "1girl@B3;1boy@D3"
```

## 更多资源

- [基础指令](/guide/basic-commands)
- [常见问题](/guide/faq)
- [配置选项](/guide/config)

