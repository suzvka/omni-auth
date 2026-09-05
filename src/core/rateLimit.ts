// ============================================================
// 速率限制
//
// 基于内存的简单速率限制器，防止暴力破解。
// 生产环境建议接入 Redis 等外部存储。
// ============================================================

import { RateLimitedError } from "../errors";

/** 速率限制结果 */
export interface RateLimitResult {
  /** 是否允许本次请求 */
  allowed: boolean;
  /** 剩余尝试次数 */
  remaining: number;
  /** 重置时间（ms 时间戳） */
  resetAt: number;
}

/** 速率限制器接口（可替换为 Redis 实现） */
export interface RateLimiter {
  /** 检查并递增计数 */
  check(key: string, maxAttempts: number, windowMs: number): Promise<RateLimitResult>;
  /** 重置某个 key 的计数 */
  reset(key: string): Promise<void>;
}

// ----------------------------------------------------------
// 内存实现（单进程，开发/低流量场景适用）
// ----------------------------------------------------------

interface WindowEntry {
  count: number;
  resetAt: number;
}

export function createMemoryRateLimiter(): RateLimiter {
  const store = new Map<string, WindowEntry>();

  // 定期清理过期条目（每 60 秒）
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) {
        store.delete(key);
      }
    }
  }, 60_000);

  // 允许 Node 进程退出
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return {
    async check(
      key: string,
      maxAttempts: number,
      windowMs: number
    ): Promise<RateLimitResult> {
      const now = Date.now();
      const entry = store.get(key);

      if (!entry || now > entry.resetAt) {
        // 窗口已过期，重置
        const resetAt = now + windowMs;
        store.set(key, { count: 1, resetAt });
        return { allowed: true, remaining: maxAttempts - 1, resetAt };
      }

      entry.count++;

      if (entry.count > maxAttempts) {
        return { allowed: false, remaining: 0, resetAt: entry.resetAt };
      }

      return {
        allowed: true,
        remaining: maxAttempts - entry.count,
        resetAt: entry.resetAt,
      };
    },

    async reset(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

// ----------------------------------------------------------
// 预置限制策略
// ----------------------------------------------------------

export interface RateLimitPresets {
  /** 登录接口限流器 */
  signIn: RateLimiter | null;
  /** 注册接口限流器 */
  signUp: RateLimiter | null;
  /** 密码重置限流器 */
  passwordReset: RateLimiter | null;
}

export interface RateLimitConfig {
  /** 速率限制器实例（不提供则禁用） */
  limiter?: RateLimiter;
  /** 登录：默认 5 次 / 15 分钟 */
  signIn?: { maxAttempts: number; windowMs: number };
  /** 注册：默认 3 次 / 1 小时 */
  signUp?: { maxAttempts: number; windowMs: number };
  /** 密码重置：默认 3 次 / 10 分钟 */
  passwordReset?: { maxAttempts: number; windowMs: number };
}

export function createRateLimitPresets(config?: RateLimitConfig): RateLimitPresets {
  const limiter = config?.limiter ?? null;

  return {
    signIn: limiter,
    signUp: limiter,
    passwordReset: limiter,
  };
}

/**
 * 通用限流检查辅助函数。
 * @throws RateLimitedError 如果超过限制
 */
export async function checkRateLimit(
  limiter: RateLimiter,
  key: string,
  maxAttempts: number,
  windowMs: number
): Promise<RateLimitResult> {
  const result = await limiter.check(key, maxAttempts, windowMs);
  if (!result.allowed) {
    const waitSeconds = Math.ceil((result.resetAt - Date.now()) / 1000);
    throw new RateLimitedError(
      waitSeconds,
      `操作过于频繁，请 ${waitSeconds} 秒后重试`
    );
  }
  return result;
}
