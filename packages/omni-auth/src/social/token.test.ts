import { describe, it, expect } from "vitest";
import {
  registerTokenRefresher,
  getTokenRefresher,
  clearTokenRefreshers,
} from "./token";
import type { TokenRefresher, TokenRefreshResult } from "./token";

const mockRefresher: TokenRefresher = async (account) => ({
  accessToken: "new_token_" + account.provider,
  refreshToken: "new_refresh",
  expiresAt: new Date("2026-12-31"),
});

const mockRefresher2: TokenRefresher = async () => ({
  accessToken: "another_token",
});

describe("Token Refresher Registry", () => {
  it("初始状态应返回 undefined", () => {
    clearTokenRefreshers();
    expect(getTokenRefresher("wechat")).toBeUndefined();
  });

  it("注册后应能获取刷新函数", () => {
    clearTokenRefreshers();
    registerTokenRefresher("wechat", mockRefresher);
    const refresher = getTokenRefresher("wechat");
    expect(refresher).toBe(mockRefresher);
    expect(typeof refresher).toBe("function");
  });

  it("刷新函数应能正常调用", async () => {
    clearTokenRefreshers();
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
    clearTokenRefreshers();
    registerTokenRefresher("wechat", mockRefresher);
    registerTokenRefresher("google", mockRefresher2);

    expect(getTokenRefresher("wechat")).toBe(mockRefresher);
    expect(getTokenRefresher("google")).toBe(mockRefresher2);
  });

  it("同一 provider 重复注册应覆盖", () => {
    clearTokenRefreshers();
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
    clearTokenRefreshers();
    expect(getTokenRefresher("github")).toBeUndefined();
  });
});
