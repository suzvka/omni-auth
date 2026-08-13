import { describe, it, expect, beforeEach } from "vitest";
import {
  registerOAuthProvider,
  getOAuthProvider,
  clearOAuthProviders,
} from "./registry";
import type { OAuthProviderConfig } from "./types";
import { createRegistry } from "../registry";

const googleConfig: OAuthProviderConfig = {
  provider: "google",
  exchangeCode: async () => ({
    openid: "g_123",
    accessToken: "at_g",
  }),
};

const githubConfig: OAuthProviderConfig = {
  provider: "github",
  exchangeCode: async () => ({
    openid: "gh_456",
    accessToken: "at_gh",
  }),
};

// 3.0.0：全局注册函数已弃用，转发到最近创建的实例注册表。
describe("OAuth Registry（弃用全局函数 → 实例注册表转发）", () => {
  beforeEach(() => {
    createRegistry(); // 每个用例使用全新的活跃注册表
  });

  it("初始状态应返回 undefined", () => {
    expect(getOAuthProvider("google")).toBeUndefined();
  });

  it("注册后应能获取 provider 配置", () => {
    registerOAuthProvider(googleConfig);
    const config = getOAuthProvider("google");
    expect(config).toBe(googleConfig);
    expect(config?.provider).toBe("google");
  });

  it("注册多个 provider 互不冲突", () => {
    registerOAuthProvider(googleConfig);
    registerOAuthProvider(githubConfig);

    expect(getOAuthProvider("google")?.provider).toBe("google");
    expect(getOAuthProvider("github")?.provider).toBe("github");
  });

  it("同一 provider 重复注册应覆盖", () => {
    registerOAuthProvider(googleConfig);

    const updatedConfig: OAuthProviderConfig = {
      ...googleConfig,
      exchangeCode: async () => ({
        openid: "g_new",
        accessToken: "at_new",
      }),
    };
    registerOAuthProvider(updatedConfig);

    expect(getOAuthProvider("google")).toBe(updatedConfig);
  });

  it("clearOAuthProviders 应清空所有注册", () => {
    registerOAuthProvider(googleConfig);
    registerOAuthProvider(githubConfig);
    clearOAuthProviders();

    expect(getOAuthProvider("google")).toBeUndefined();
    expect(getOAuthProvider("github")).toBeUndefined();
  });

  it("未注册的 provider 返回 undefined", () => {
    expect(getOAuthProvider("microsoft")).toBeUndefined();
  });

  it("不同实例注册表互不干扰", () => {
    const r1 = createRegistry();
    registerOAuthProvider(googleConfig); // 写入 r1（当前活跃）

    const r2 = createRegistry();
    expect(getOAuthProvider("google")).toBeUndefined();

    expect(r1.oauthProviders.get("google")).toBe(googleConfig);
    expect(r2.oauthProviders.size).toBe(0);
  });
});
