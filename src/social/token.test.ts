import { describe, it, expect, beforeEach } from "vitest";
import {
  registerTokenRefresher,
  getTokenRefresher,
  clearTokenRefreshers,
} from "./token";
import type { TokenRefresher } from "./token";
import { createRegistry } from "../registry";

const mockRefresher: TokenRefresher = async (account) => ({
  accessToken: "new_token_" + account.provider,
  refreshToken: "new_refresh",
  expiresAt: new Date("2026-12-31"),
});

const mockRefresher2: TokenRefresher = async () => ({
  accessToken: "another_token",
});

// 3.0.0：全局注册函数已弃用，转发到最近创建的实例注册表。
// 测试通过 createRegistry() 建立活跃注册表后验证兼容转发行为。
describe("Token Refresher Registry（弃用全局函数 → 实例注册表转发）", () => {
  beforeEach(() => {
    createRegistry(); // 每个用例使用全新的活跃注册表
  });

  it("初始状态应返回 undefined", () => {
    expect(getTokenRefresher("wechat")).toBeUndefined();
  });

  it("注册后应能获取刷新函数", () => {
    registerTokenRefresher("wechat", mockRefresher);
    const refresher = getTokenRefresher("wechat");
    expect(refresher).toBe(mockRefresher);
    expect(typeof refresher).toBe("function");
  });

  it("刷新函数应能正常调用", async () => {
    registerTokenRefresher("wechat", mockRefresher);
    const refresher = getTokenRefresher("wechat")!;

    const result = await refresher({
      id: "sa_1",
      provider: "wechat",
      providerOpenid: "oid_abc",
      accessToken: "old_token",
      refreshToken: "old_refresh",
      tokenExpiresAt: new Date(),
      profileData: {},
    });

    expect(result.accessToken).toBe("new_token_wechat");
    expect(result.refreshToken).toBe("new_refresh");
    expect(result.expiresAt).toEqual(new Date("2026-12-31"));
  });

  it("注册多个 provider 互不冲突", () => {
    registerTokenRefresher("wechat", mockRefresher);
    registerTokenRefresher("google", mockRefresher2);

    expect(getTokenRefresher("wechat")).toBe(mockRefresher);
    expect(getTokenRefresher("google")).toBe(mockRefresher2);
  });

  it("同一 provider 重复注册应覆盖", () => {
    registerTokenRefresher("wechat", mockRefresher);
    registerTokenRefresher("wechat", mockRefresher2);

    expect(getTokenRefresher("wechat")).toBe(mockRefresher2);
  });

  it("clearTokenRefreshers 应清空所有注册", () => {
    registerTokenRefresher("wechat", mockRefresher);
    registerTokenRefresher("google", mockRefresher2);
    clearTokenRefreshers();

    expect(getTokenRefresher("wechat")).toBeUndefined();
    expect(getTokenRefresher("google")).toBeUndefined();
  });

  it("未注册的 provider 返回 undefined", () => {
    expect(getTokenRefresher("github")).toBeUndefined();
  });

  it("不同实例注册表互不干扰", () => {
    const r1 = createRegistry();
    registerTokenRefresher("wechat", mockRefresher); // 写入 r1（当前活跃）

    const r2 = createRegistry(); // 新建后成为活跃注册表
    expect(getTokenRefresher("wechat")).toBeUndefined();

    // r1 中的注册仍然存在（实例隔离）
    expect(r1.tokenRefreshers.get("wechat")).toBe(mockRefresher);
    expect(r2.tokenRefreshers.size).toBe(0);
  });
});
