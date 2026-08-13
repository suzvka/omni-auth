import { describe, it, expect, vi } from "vitest";

// createQuickAuth 顶层 import next/headers，测试环境 mock 掉
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import { createQuickAuth } from "./index";

// ----------------------------------------------------------
// M4 清理：原先的 two it.skip 测试引用了已删除的
// auth.betterAuth getter，已移除。
// 此处保留最小冒烟测试，验证 createQuickAuth 仍可导入。
// ----------------------------------------------------------

describe("createQuickAuth", () => {
  it("导出为函数", () => {
    expect(typeof createQuickAuth).toBe("function");
  });
});
