export interface Perks {
  maxPriorityActions: number
  startPriority: number
  contextTokens: number
  moduleTrainingSteps: number
  unlimitedMaxPriority: boolean
  voiceGeneration: boolean
  imageGeneration: boolean
  unlimitedImageGeneration: boolean
  unlimitedImageGenerationLimits: {
    resolution: number
    maxPrompts: number
  }[]
}

export interface PaymentProcessorData {
  c: string
  n: number
  o: string
  p: number
  r: string
  s: string
  t: number
  u: string
}

export interface TrainingStepsLeft {
  fixedTrainingStepsLeft: number
  purchasedTrainingSteps: number
}

export interface UsageLimit {
  /** 免费生成额度剩余百分比。 */
  percent?: number
  /** 距离下一个 1% 恢复的秒数。 */
  timeUntilNextPercent?: number
  /** 为 true 时表示额度不可用。 */
  isNegative?: boolean
}

export interface Subscription {
  tier: number
  active: boolean
  expiresAt: number
  perks: Perks
  paymentProcessorData: PaymentProcessorData
  trainingStepsLeft: TrainingStepsLeft
  usage?: UsageLimit
}

export interface ImageData {
  buffer: ArrayBuffer
  base64: string
  dataUrl: string
}

export namespace NovelAI {
  /** 0.5, 0.5 means make ai choose */
  export interface V4CharacterPromptCenter {
    x: number
    y: number
  }

  export interface V4CharacterPrompt {
    prompt: string
    uc: string
    center: V4CharacterPromptCenter
  }

  export interface V4CharCaption {
    char_caption: string
    centers: V4CharacterPromptCenter[]
  }

  export interface V4PromptCaption {
    base_caption: string
    char_captions: V4CharCaption[]
  }

  export interface V4Prompt {
    caption: V4PromptCaption
  }

  export interface V4PromptPositive extends V4Prompt {
    use_coords: boolean
    use_order: boolean
  }

  /** 用户输入的角色定义 */
  export interface Character {
    /** 角色的正向提示词 */
    prompt: string
    /** 角色的负向提示词（可选） */
    uc?: string
    /**
     * 位置（可选，默认 "C3"），支持两种格式：
     * - 网格格式："A1" 到 "E5"
     * - 连续坐标格式："x,y" 或 "(x,y)"，值域 [0,1]（NAI 5 自由定位推荐，如 "0.35,0.62"）
     */
    position?: string
  }
}

/** 会员卡：一次授予产生的记录，同一用户可持有多张（多卡叠加制） */
export interface MembershipCard {
  tier: number          // 等级 1-5
  expiry: number        // 卡到期时间戳
  grantedAt: number     // 授予时间
  grantedBy?: string    // 授予人（操作的管理员 ID）
}

/** 等级权益（Lv1 由现有全局配置字段构成，Lv2-Lv5 来自 tierBenefits 配置） */
export interface TierBenefit {
  tier: number
  nai5DailyLimit: number   // nai5/nai5c 每日免费次数
  pointsRefresh: number    // 周期刷新点数
  dailyLimit: number       // 每日总限额，0=无限
  cooldown: number         // CD 秒数，0=无
}

export interface UserData {
  isMember: boolean
  membershipExpiry: number // 时间戳，会员到期时间（= 当前生效卡的到期时间，冗余维护）
  dailyUsage: number // 当日使用次数
  lastUsed: number // 时间戳，上次使用时间
  dailyLimit: number // 每日使用上限
  lastDrawTime?: number // 时间戳，上次绘图时间，用于计算CD
  points?: number // 当前点数
  nai5DailyUsage?: number // 当日 nai5 / nai5c 使用次数（周桶模式下仅作统计）
  nai5Bucket?: number // nai5 周桶余额（张），nai5WeeklyBucketEnabled 开启时使用
  nai5BucketDay?: number // 周桶上次入账日（本地 0 点时间戳，0 = 未初始化/待种子）
  nai5DepositTier?: number // 当日最近一次周桶入账/补差所用档位（0 = 无；升档补差与防刷依据）
  cards?: MembershipCard[] // 会员卡列表（内存缓存；数据库独立存储于 hhs_huatu_membership_cards）
}

// 数据库表结构
export interface HhsHuatuUser {
  id: number
  visitorId: string       // 用户唯一标识 (userId)
  isMember: boolean
  membershipExpiry: number
  dailyUsage: number
  lastUsed: number
  dailyLimit: number
  lastDrawTime: number
  points: number
  nai5DailyUsage: number
  nai5Bucket: number
  nai5BucketDay: number
  nai5DepositTier: number
}

// 会员卡数据库表结构
export interface HhsHuatuMembershipCard {
  id: number
  visitorId: string       // 用户唯一标识 (userId)
  tier: number            // 等级 1-5
  expiry: number          // 卡到期时间戳
  grantedAt: number       // 授予时间
  grantedBy: string       // 授予人
}

// 声明 Koishi 数据库表
declare module 'koishi' {
  interface Tables {
    hhs_huatu_user: HhsHuatuUser
    hhs_huatu_membership_cards: HhsHuatuMembershipCard
  }
}

export namespace StableDiffusionWebUI {
  export interface Request {
    prompt: string
    negative_prompt?: string
    enable_hr?: boolean
    denoising_strength?: number
    firstphase_width?: number
    firstphase_height?: number
    styles?: string[]
    seed?: number
    subseed?: number
    subseed_strength?: number
    seed_resize_from_h?: number
    seed_resize_from_w?: number
    batch_size?: number
    n_iter?: number
    steps?: number
    cfg_scale?: number
    width?: number
    height?: number
    restore_faces?: boolean
    tiling?: boolean
    eta?: number
    s_churn?: number
    s_tmax?: number
    s_tmin?: number
    s_noise?: number
    sampler_index?: string
  }

  export interface Response {
    /** Image list in base64 format */
    images: string[]
    parameters: any
    info: any
  }

  /**
   * @see https://github.com/AUTOMATIC1111/stable-diffusion-webui/blob/828438b4a190759807f9054932cae3a8b880ddf1/modules/api/models.py#L122
   */
  export interface ExtraSingleImageRequest {
    image: string
    /** Sets the resize mode: 0 to upscale by upscaling_resize amount, 1 to upscale up to upscaling_resize_h x upscaling_resize_w. */
    resize_mode?: 0 | 1
    show_extras_results?: boolean
    gfpgan_visibility?: number // float
    codeformer_visibility?: number // float
    codeformer_weight?: number // float
    upscaling_resize?: number // float
    upscaling_resize_w?: number // int
    upscaling_resize_h?: number // int
    upscaling_crop?: boolean
    upscaler_1?: string
    upscaler_2?: string
    extras_upscaler_2_visibility?: number // float
    upscale_first?: boolean
  }

  export interface ExtraSingleImageResponse {
    image: string
  }
}

export interface Config {
  translator?: {
    enable: boolean
    provider?: string
  }
}

// Director Tools 相关类型
export namespace DirectorTools {
  export type ToolType = 'bg-removal' | 'lineart' | 'sketch' | 'colorize' | 'emotion' | 'declutter'

  export interface Request {
    height: number
    width: number
    image: string  // base64
    req_type: ToolType
    defry?: number  // 0-5, 用于 colorize 和 emotion
    prompt?: string  // 用于 colorize 和 emotion
  }

  // 表情类型（中英文映射）
  export type Emotion =
    | 'neutral' | 'happy' | 'sad' | 'angry' | 'scared' | 'surprised'
    | 'tired' | 'excited' | 'nervous' | 'thinking' | 'confused' | 'shy'
    | 'disgusted' | 'smug' | 'bored' | 'laughing' | 'irritated' | 'aroused'
    | 'embarrassed' | 'worried' | 'love' | 'determined' | 'hurt' | 'playful'
}
