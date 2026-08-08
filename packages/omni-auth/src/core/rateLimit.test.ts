import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createMemoryRateLimiter,
  checkRateLimit,
  createRateLimitPresets,
} from "./rateLimit";
import type { RateLimiter } from "./rateLimit";

describe("createMemoryRateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = createMemoryRateLimiter();
  });

  it("首次请求应允许", async () => {
    const result = await limiter.check("test_key", 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("窗口内超过限制后应拒绝", async () => {
    for (let i = 0; i < 5; i++) {
      const result = await limiter.check("key_1", 5, 60000);
      if (i < 4) {
        expect(result.allowed).toBe(true);
      }
    }

    // 第 6 次应被拒绝
    const result = await limiter.check("key_1", 5, 60000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("不同 key 应独立计数", async () => {
    // 耗尽 key_a
    for (let i = 0; i < 5; i++) {
      await limiter.check("key_a", 5, 60000);
    }
    const resultA = await limiter.check("key_a", 5, 60000);
    expect(resultA.allowed).toBe(false);

    // key_b 仍应允许
    const resultB = await limiter.check("key_b", 5, 60000);
    expect(resultB.allowed).toBe(true);
  });

  it("窗口过期后应重置计数", async () => {
    // 使用很短的窗口
    for (let i = 0; i < 3; i++) {
      await limiter.check("key_expire", 3, 10);
    }
    const rejected = await limiter.check("key_expire", 3, 10);
    expect(rejected.allowed).toBe(false);

    // 等待窗口过期
    await new Promise((r) => setTimeout(r, 20));

    const reset = await limiter.check("key_expire", 3, 10);
    expect(reset.allowed).toBe(true);
    expect(reset.remaining).toBe(2);
  });

  it("reset 应清除指定 key 的计数", async () => {
    for (let i = 0; i < 4; i++) {
      await limiter.check("key_rst", 5, 60000);
    }

    await limiter.reset("key_rst");

    const result = await limiter.check("key_rst", 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("resetAt 应指向窗口结束时间", async () => {
    const before = Date.now();
    const result = await limiter.check("key_time", 5, 30000);
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 30000 - 100);
  });
});

describe("checkRateLimit", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = createMemoryRateLimiter();
  });

  it("未超限时应返回剩余次数", async () => {
    const result = await checkRateLimit(limiter, "key_cl", 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("超限时应抛出错误", async () => {
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(limiter, "key_overflow", 5, 60000);
    }

    await expect(
      checkRateLimit(limiter, "key_overflow", 5, 60000)
    ).rejects.toThrow("操作过于频繁");
  });
});

describe("createRateLimitPresets", () => {
  it("未提供 limiter 时所有预设为 null", () => {
    const presets = createRateLimitPresets();
    expect(presets.signIn).toBeNull();
    expect(presets.signUp).toBeNull();
    expect(presets.passwordReset).toBeNull();
  });

  it("提供 limiter 时所有预设共享同一实例", () => {
    const limiter = createMemoryRateLimiter();
    const presets = createRateLimitPresets({ limiter });
    expect(presets.signIn).toBe(limiter);
    expect(presets.signUp).toBe(limiter);
    expect(presets.passwordReset).toBe(limiter);
  });
});
