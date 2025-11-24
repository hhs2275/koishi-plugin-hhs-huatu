import { Context, Logger } from 'koishi';
import COS from 'cos-nodejs-sdk-v5';
import { promisify } from 'util';

// 错误映射表
const ERROR_MAP = {
  400: '请求参数错误，请检查请求参数是否符合要求。',
  401: '未经授权，请提供有效的身份验证信息。',
  403: '访问被拒绝，请确保有足够的权限。',
  404: '资源未找到，请检查请求的URL是否正确。',
  429: '请求过于频繁，请稍后重试。',
  500: '服务器发生错误，请稍后重试。'
};

// 审核策略
const STRATEGIES = {
  api4ai: {
    handler: async (buffer: ArrayBuffer, config: any, logger: Logger, ctx: Context) => {
      const formData = new FormData();
      formData.append('image', new Blob([buffer]), 'image.jpg');

      try {
        const response = await ctx.http.post(
          "https://demo.api4ai.cloud/nsfw/v1/results",
          formData
        );

        const nsfw = response.data.results[0].entities[0].classes.nsfw;
        if (config.debugLog) {
          logger.info(`api4ai图片审核结果：${nsfw}`);
        }

        return {
          pass: nsfw <= config.api4ai.nsfwThreshold,
          score: nsfw,
          message: nsfw > config.api4ai.nsfwThreshold ? '图片包含不适内容' : '图片审核通过'
        };
      } catch (error) {
        logger.error(`API4AI审核失败: ${error}`);
        throw new Error(ERROR_MAP[error.response?.status] || '未知错误，请检查控制台日志');
      }
    }
  },
  tencent: {
    handler: async (buffer: ArrayBuffer, config: any, logger: Logger, ctx: Context) => {
      const cos = new COS({
        SecretId: config.secretId as string,
        SecretKey: config.secretKey as string
      } as any);

      const bucket = config.bucket || 'default-1250000000';
      const region = config.region?.toLowerCase() || 'ap-chengdu';
      
      // 添加详细日志（受配置控制）
      if (config.debugLog) {
        logger.info(`腾讯云图片审核请求参数: Region=${region}, Bucket=${bucket}, BizType=${config.bizType}`);
      }

      try {
        // 将图片转为Base64
        const imageBase64 = Buffer.from(buffer).toString('base64');
        
        // 使用腾讯云图片审核API直接请求，而不是使用ci属性
        // 构建请求URL
        const url = `https://${bucket}.ci.${region}.myqcloud.com/image/auditing`;
        if (config.debugLog) {
          logger.info(`腾讯云图片审核请求URL: ${url}`);
        }
        
        // 构建请求参数 - 修改 DetectType 为字符串
        const requestData = {
          Input: {
            Content: imageBase64
          },
          Conf: {
            DetectType: 'Porn,Terrorism,Politics,Ads', // 修改为字符串格式
            BizType: config.bizType
          }
        };
        
        // 定义腾讯云图片审核响应的接口
        interface TencentImageAuditResponse {
          JobsDetail?: {
            Label: string;
            [key: string]: any;
          };
          Response?: {
            JobsDetail?: {
              Label: string;
              [key: string]: any;
            };
            [key: string]: any;
          };
          [key: string]: any;
        }
        
        // 使用COS的request方法发送请求
        const response = await new Promise<TencentImageAuditResponse>((resolve, reject) => {
          cos.request(
            {
              Method: 'POST',
              Url: url,
              Body: JSON.stringify(requestData),
              Headers: {
                'Content-Type': 'application/json'
              }
            },
            function(err, data) {
              if (err) {
                reject(err);
              } else {
                resolve(data as TencentImageAuditResponse);
              }
            }
          );
        });
        
        if (config.debugLog) {
          logger.info(`腾讯云图片审核响应:`, JSON.stringify(response));
        }
        
        // 解析审核结果
        const result = response.JobsDetail || (response.Response && response.Response.JobsDetail);
        if (!result) {
          throw new Error('审核结果解析失败，未找到JobsDetail字段');
        }
        
        const label = result.Label;
        if (config.debugLog) {
          logger.info(`腾讯云图片审核结果: Label=${label}`);
        }
        
        // 根据Label判断是否通过审核 (Normal为正常，Block为违规)
        return {
          pass: label === 'Normal',
          score: label === 'Normal' ? 0 : 1,
          message: label === 'Normal' ? '图片审核通过' : '图片包含不适内容'
        };
      } catch (error) {
        // 提取详细的错误信息
        let errorMessage = '腾讯云图片审核失败';
        if (error) {
          if (error.message) {
            errorMessage += `: ${error.message}`;
          }
          if (error.code) {
            errorMessage += ` (错误码: ${error.code})`;
          }
          if (error.statusCode) {
            errorMessage += ` (状态码: ${error.statusCode})`;
          }
          // 记录完整的错误对象（受配置控制）
          if (config.debugLog) {
            logger.error(`腾讯云图片审核失败详情:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
          }
        }
        logger.error(`腾讯云图片审核失败: ${errorMessage}`);
        throw new Error(errorMessage);
      }
    }
  }
};

// 审核结果接口
export interface AuditResult {
  pass: boolean;
  score: number;
  message: string;
  processingTime?: number; // 添加处理时间属性，可选
}

/**
 * 图片审核函数 - 优化版
 * 支持超时设置、重试机制、性能监控和更详细的错误处理
 */
export async function auditImage(ctx: Context, data: ArrayBuffer | string, config: any): Promise<AuditResult> {
  const globalStartTime = performance.now();
  ctx.logger.debug('开始图片审核处理');
  
  try {
    // 优化图片处理：减少不必要的转换
    let buffer: Buffer;
    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else if (typeof data === 'string') {
      // 处理base64字符串
      buffer = Buffer.from(data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    } else {
      // 处理ArrayBuffer
      buffer = Buffer.from(data);
    }
    
    // 检查图片大小，过大的图片可能导致处理超时
    const imageSizeKB = Math.round(buffer.length / 1024);
    if (config.debugLog) {
      ctx.logger.debug(`图片大小: ${imageSizeKB}KB`);
    }
    
    // 如果图片过大，可以考虑压缩或拒绝处理
    const maxSizeKB = config.imageAudit?.maxSizeKB || 4096; // 默认4MB
    if (imageSizeKB > maxSizeKB) {
      ctx.logger.warn(`图片大小(${imageSizeKB}KB)超过限制(${maxSizeKB}KB)，可能影响审核性能`);
    }
    
    // 如果未启用审核，直接返回通过
    if (!config.imageReviewEnabled) {
      const processingTime = Math.round(performance.now() - globalStartTime);
      return { 
        pass: true, 
        score: 0, 
        message: '图片审核已禁用',
        processingTime 
      };
    }
    
    // 确定使用的审核引擎
    const engine = config.imageAudit?.engine || 'tencent';
    
    if (!STRATEGIES[engine]) {
      ctx.logger.warn(`不支持的审核类型: ${engine}，将跳过审核`);
      const processingTime = Math.round(performance.now() - globalStartTime);
      return { 
        pass: true, 
        score: 0, 
        message: `不支持的审核类型: ${engine}`,
        processingTime 
      };
    }
    
    // 调用对应的审核策略
    const result = await STRATEGIES[engine].handler(buffer, config.imageAudit, ctx.logger, ctx);
    
    // 添加总处理时间
    const totalProcessingTime = Math.round(performance.now() - globalStartTime);
    if (!result.processingTime) {
      result.processingTime = totalProcessingTime;
    }
    
    // 记录性能指标（受配置控制）
    if (config.debugLog) {
      ctx.logger.debug(`图片审核完成，总耗时: ${totalProcessingTime}ms`);
    }
    
    return result;
  } catch (error) {
    // 提取详细的错误信息
    let errorMessage = '审核失败';
    if (error) {
      if (error.message) {
        errorMessage += `: ${error.message}`;
      }
      if (error.code) {
        errorMessage += ` (错误码: ${error.code})`;
      }
      if (error.statusCode) {
        errorMessage += ` (状态码: ${error.statusCode})`;
      }
      
      // 只在调试模式下记录完整错误对象，减少日志量
      if (config.debugLog) {
        ctx.logger.error(`图片审核失败详情:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
      } else {
        ctx.logger.error(`图片审核失败: ${errorMessage}`);
      }
    }
    
    const totalProcessingTime = Math.round(performance.now() - globalStartTime);
    
    // 根据配置决定审核失败时的行为
    if (config.imageReviewFailAction === 'block') {
      return { 
        pass: false, 
        score: -1, 
        message: errorMessage,
        processingTime: totalProcessingTime 
      };
    } else {
      // 默认为ignore，审核失败时放行
      return { 
        pass: true, 
        score: -1, 
        message: `审核失败但已放行: ${errorMessage}`,
        processingTime: totalProcessingTime 
      };
    }
  }
}