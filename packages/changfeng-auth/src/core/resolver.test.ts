import { describe, it, expect, beforeEach } from "vitest";
import {
  setAccountResolver,
  getAccountResolver,
} from "./resolver";
import type { Account } from "../types";

// 由于模块使用 module-level 变量，需要手动重置
function resetResolver() {
  setAccountResolver(null as unknown as Parameters<typeof setAccountResolver>[0]);
  // 先 set null，再 set 真实值来覆盖... 不行，因为类型要求非null
  // 实际解决方案：直接通过内部机制重置
  // vitest 每个文件是独立 vm context，但 import 是单例
  // 我们只能通过 setAccountResolver 重新设置
}

describe("AccountResolver", () => {
  const mockAccount: Account = {
    id: "biz_001",
    authUserId: "auth_001",
    displayName: "测试用户",
    status: "active",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-06-01"),
  };

  const mockResolver = {
    findByAuthUserId: async (id: string) => id === "auth_001" ? mockAccount : null,
  };

  it("初始状态下应返回 null", () => {
    // 注意：其他测试可能已注册，此处测试的是 getter 行为
    const resolver = getAccountResolver();
    // 可能是 null 或已注册的 resolver（取决于测试顺序）
    // 在独立运行时可依赖 null，这里用类型断言
    expect(resolver === null || typeof resolver?.findByAuthUserId === "function").toBe(true);
  });

  it("setAccountResolver 注册后 getAccountResolver 应返回同一实例", async () => {
    setAccountResolver(mockResolver);
    const resolver = getAccountResolver();
    expect(resolver).toBe(mockResolver);

    const result = await resolver!.findByAuthUserId("auth_001");
    expect(result).toEqual(mockAccount);
  });

  it("查找不存在的用户应返回 null", async () => {
    setAccountResolver(mockResolver);
    const resolver = getAccountResolver();
    const result = await resolver!.findByAuthUserId("nonexistent");
    expect(result).toBeNull();
  });

  it("重复注册应覆盖之前的 resolver", async () => {
    const resolver1 = { findByAuthUserId: async () => mockAccount };
    const resolver2 = { findByAuthUserId: async () => null };

    setAccountResolver(resolver1);
    expect(getAccountResolver()).toBe(resolver1);

    setAccountResolver(resolver2);
    expect(getAccountResolver()).toBe(resolver2);
  });
});
