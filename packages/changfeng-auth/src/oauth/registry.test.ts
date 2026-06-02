import { describe, it, expect } from "vitest";
import {
  registerOAuthProvider,
  getOAuthProvider,
  clearOAuthProviders,
} from "./registry";
import type { OAuthProviderConfig } from "./types";

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

describe("OAuth Registry", () => {
  it("初始状态应返回 undefined", () => {
    clearOAuthProviders();
    expect(getOAuthProvider("google")).toBeUndefined();
  });

  it("注册后应能获取 provider 配置", () => {
    clearOAuthProviders();
    registerOAuthProvider(googleConfig);
    const config = getOAuthProvider("google");
    expect(config).toBe(googleConfig);
    expect(config?.provider).toBe("google");
  });

  it("注册多个 provider 互不冲突", () => {
    clearOAuthProviders();
    registerOAuthProvider(googleConfig);
    registerOAuthProvider(githubConfig);

    expect(getOAuthProvider("google")?.provider).toBe("google");
    expect(getOAuthProvider("github")?.provider).toBe("github");
  });

  it("同一 provider 重复注册应覆盖", () => {
    clearOAuthProviders();
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
    clearOAuthProviders();
    expect(getOAuthProvider("microsoft")).toBeUndefined();
  });
});
