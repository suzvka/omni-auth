import { describe, it, expect, beforeEach, vi } from "vitest";
import { createOAuthHandler, setOAuthHandler, handleOAuthCallback } from "./handler";
import { registerOAuthProvider, clearOAuthProviders } from "./registry";
import type { DatabaseAdapter } from "../adapters/database";
import type { OAuthProviderConfig } from "./types";

// ============================================================
// In-memory mock DatabaseAdapter
// ============================================================
function createInMemoryDb(): DatabaseAdapter {
  const store = new Map<string, Map<string, Record<string, unknown>>>();

  function ensureModel(model: string) {
    if (!store.has(model)) store.set(model, new Map());
    return store.get(model)!;
  }

  return {
    async create({ model, data }) {
      const table = ensureModel(model);
      const id = (data.id as string) ?? String(Math.random());
      const record = { ...data, id, createdAt: new Date(), updatedAt: new Date() };
      table.set(id, record);
      return record;
    },
    async findOne({ model, where }) {
      const table = ensureModel(model);
      for (const [, r] of table) {
        if (where.every((w) => r[w.field] === w.value)) return r;
      }
      return null;
    },
    async findMany({ model, where, limit, offset }) {
      const table = ensureModel(model);
      const results: Record<string, unknown>[] = [];
      for (const [, r] of table) {
        if (!where || where.every((w) => {
          if (w.operator === "neq") return r[w.field] !== w.value;
          return r[w.field] === w.value;
        })) results.push(r);
      }
      let sliced = results;
      if (offset) sliced = sliced.slice(offset);
      if (limit) sliced = sliced.slice(0, limit);
      return sliced;
    },
    async updateOne({ model, where, update }) { throw new Error("Not used"); },
    async updateMany({ model, where, update }) { return 0; },
    async deleteOne({ model, where }) { throw new Error("Not used"); },
    async deleteMany({ model, where }) { return 0; },
  };
}

// ============================================================
// Tests
// ============================================================

describe("createOAuthHandler", () => {
  let db: DatabaseAdapter;
  let handler: ReturnType<typeof createOAuthHandler>;

  const mockSocialService = {
    findByProvider: vi.fn(),
    bindToUser: vi.fn(),
  };

  const mockBetterAuth = {
    api: {
      signUpEmail: vi.fn(),
    },
  } as any;

  beforeEach(() => {
    clearOAuthProviders();
    db = createInMemoryDb();
    mockSocialService.findByProvider.mockReset();
    mockSocialService.bindToUser.mockReset();
    mockBetterAuth.api.signUpEmail.mockReset();

    handler = createOAuthHandler({
      db,
      auth: mockBetterAuth,
      socialService: mockSocialService,
    });
  });

  it("未注册的 provider 应抛出错误", async () => {
    await expect(
      handler("unknown_provider", "some_code", "http://localhost/callback")
    ).rejects.toThrow("未注册的 OAuth 平台");
  });

  it("已有绑定应直接创建 session 并返回 isNewUser=false", async () => {
    registerOAuthProvider({
      provider: "wechat",
      exchangeCode: async () => ({
        openid: "oid_existing",
        accessToken: "at_wx",
        profileData: { nickname: "老用户" },
      }),
    } as OAuthProviderConfig);

    mockSocialService.findByProvider.mockResolvedValue({ userId: "existing_user" });

    const result = await handler("wechat", "code123", "http://localhost/callback");

    expect(result.userId).toBe("existing_user");
    expect(result.isNewUser).toBe(false);
    expect(result.token).toBeDefined();
    expect(result.token.length).toBeGreaterThan(10);

    // 应创建 session 记录
    const sessions = await db.findMany({ model: "session", where: [{ field: "userId", value: "existing_user" }] });
    expect(sessions).toHaveLength(1);
  });

  it("新用户应注册并绑定社交账户，返回 isNewUser=true", async () => {
    registerOAuthProvider({
      provider: "google",
      exchangeCode: async () => ({
        openid: "g_new_user",
        accessToken: "at_google",
        email: "newuser@gmail.com",
        name: "New User",
        profileData: { avatar: "url" },
      }),
    } as OAuthProviderConfig);

    mockSocialService.findByProvider.mockResolvedValue(null);
    mockBetterAuth.api.signUpEmail.mockResolvedValue({
      token: "session_token_new",
      user: { id: "new_user_id", email: "newuser@gmail.com", name: "New User" },
    });
    mockSocialService.bindToUser.mockResolvedValue({ id: "sa_new" });

    const result = await handler("google", "code_google", "http://localhost/callback");

    expect(result.isNewUser).toBe(true);
    expect(result.userId).toBe("new_user_id");
    expect(result.token).toBe("session_token_new");

    // 应调用了 signUpEmail
    expect(mockBetterAuth.api.signUpEmail).toHaveBeenCalledTimes(1);

    // 应调用了 bindToUser
    expect(mockSocialService.bindToUser).toHaveBeenCalledWith(
      "new_user_id",
      expect.objectContaining({
        provider: "google",
        providerOpenid: "g_new_user",
      })
    );
  });

  it("平台不返回邮箱时使用占位邮箱", async () => {
    registerOAuthProvider({
      provider: "wechat",
      exchangeCode: async () => ({
        openid: "wx_no_email",
        accessToken: "at_wx_no_email",
        name: "微信用户",
      }),
    } as OAuthProviderConfig);

    mockSocialService.findByProvider.mockResolvedValue(null);
    mockBetterAuth.api.signUpEmail.mockResolvedValue({
      token: "tok_placeholder",
      user: { id: "u_placeholder", email: "wechat_wx_no_email@oauth.usercenter", name: "微信用户" },
    });
    mockSocialService.bindToUser.mockResolvedValue({});

    const result = await handler("wechat", "code", "http://localhost/callback");

    const signUpCall = mockBetterAuth.api.signUpEmail.mock.calls[0][0];
    expect(signUpCall.body.email).toBe("wechat_wx_no_email@oauth.usercenter");
  });

  it("平台不返回 name 时使用默认名称", async () => {
    registerOAuthProvider({
      provider: "github",
      exchangeCode: async () => ({
        openid: "gh_no_name",
        accessToken: "at_gh",
      }),
    } as OAuthProviderConfig);

    mockSocialService.findByProvider.mockResolvedValue(null);
    mockBetterAuth.api.signUpEmail.mockResolvedValue({
      token: "tok_gh",
      user: { id: "u_gh", email: "github_gh_no_name@oauth.usercenter", name: "github_用户" },
    });
    mockSocialService.bindToUser.mockResolvedValue({});

    await handler("github", "code", "http://localhost/callback");

    const signUpCall = mockBetterAuth.api.signUpEmail.mock.calls[0][0];
    expect(signUpCall.body.name).toBe("github_用户");
  });

  it("注册失败应抛出错误", async () => {
    registerOAuthProvider({
      provider: "wechat",
      exchangeCode: async () => ({
        openid: "wx_fail",
        accessToken: "at_fail",
      }),
    } as OAuthProviderConfig);

    mockSocialService.findByProvider.mockResolvedValue(null);
    mockBetterAuth.api.signUpEmail.mockRejectedValue(new Error("邮箱已注册"));

    await expect(
      handler("wechat", "code", "http://localhost/callback")
    ).rejects.toThrow("OAuth 注册失败 (wechat)");
  });
});

// ---- 全局 handler 测试 ----

describe("全局 handleOAuthCallback", () => {
  it("未初始化时应抛异常", async () => {
    await expect(
      handleOAuthCallback("wechat", "code", "http://localhost/callback")
    ).rejects.toThrow("OAuth handler 未初始化");
  });
});
