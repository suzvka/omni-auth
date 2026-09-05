import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================
// Mock 外部依赖
// ============================================================

vi.mock("@better-auth/core/oauth2", () => ({
    createAuthorizationURL: vi.fn(),
    validateAuthorizationCode: vi.fn(),
}));

// ---- 在 mock 之后导入 ----

import { createOAuthHandler } from "./handler";
import {
    createAuthorizationURL,
    validateAuthorizationCode,
} from "@better-auth/core/oauth2";
import type { DatabaseAdapter } from "../adapters/database";
import type { OAuthProviderConfig } from "../oauth/types";
import { OAuthStateMismatchError } from "../errors";

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
        async count({ model, where }) {
            const table = ensureModel(model);
            let n = 0;
            for (const [, r] of table) {
                if (!where || where.every((w) => r[w.field] === w.value)) n++;
            }
            return n;
        },
        async updateOne() { throw new Error("Not used"); },
        async updateMany() { return 0; },
        async deleteOne() { throw new Error("Not used"); },
        async deleteMany() { return 0; },
    };
}

// ============================================================
// 3.0.0：handler 依赖注入构建器（实例级 provider 注册表 + 审计）
// ============================================================

function buildHandler(db: DatabaseAdapter) {
    const providers = new Map<string, OAuthProviderConfig>();
    const mockSocialService = {
        findByProvider: vi.fn(),
        bindToUser: vi.fn(),
    };
    const publishAudit = vi.fn().mockResolvedValue(undefined);

    const handler = createOAuthHandler({
        db,
        getProvider: (provider) => providers.get(provider),
        socialService: () => mockSocialService,
        publishAudit,
    });

    return { handler, providers, mockSocialService, publishAudit };
}

/** 对象形式回调参数：state 匹配（通过库内校验） */
const okState = (state = "state_abc123") => ({ state, expectedState: state });

// ============================================================
// 测试
// ============================================================

describe("createOAuthHandler — 基础", () => {
    let db: DatabaseAdapter;
    let ctx: ReturnType<typeof buildHandler>;

    beforeEach(() => {
        db = createInMemoryDb();
        ctx = buildHandler(db);
    });

    it("未注册的 provider 应抛出错误", async () => {
        await expect(
            ctx.handler("unknown_provider", "some_code", "http://localhost/callback")
        ).rejects.toThrow("未注册的 OAuth 平台");
    });
});

// ============================================================
// state 强制校验（对象形式参数）
// ============================================================

describe("createOAuthHandler — state 强制校验", () => {
    let db: DatabaseAdapter;
    let ctx: ReturnType<typeof buildHandler>;

    beforeEach(() => {
        db = createInMemoryDb();
        ctx = buildHandler(db);
        ctx.providers.set("wechat", {
            provider: "wechat",
            exchangeCode: async () => ({ openid: "oid_x", accessToken: "at" }),
        });
    });

    it("state 与 expectedState 不匹配时抛 OAuthStateMismatchError", async () => {
        await expect(
            ctx.handler("wechat", "code", "http://localhost/callback", {
                state: "attacker_state",
                expectedState: "server_state",
            })
        ).rejects.toThrow(OAuthStateMismatchError);

        // 不应继续换取 token
        expect(ctx.publishAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ rejected: "state_mismatch" }),
            }),
        );
    });

    it("缺少 expectedState 时抛 OAuthStateMismatchError", async () => {
        await expect(
            ctx.handler("wechat", "code", "http://localhost/callback", {
                state: "only_incoming",
            })
        ).rejects.toThrow("OAuth state 缺失");
    });

    it("缺少 state 时抛 OAuthStateMismatchError", async () => {
        await expect(
            ctx.handler("wechat", "code", "http://localhost/callback", {
                expectedState: "server_state",
            })
        ).rejects.toThrow("OAuth state 缺失");
    });

    it("空对象参数同样拒绝", async () => {
        await expect(
            ctx.handler("wechat", "code", "http://localhost/callback", {})
        ).rejects.toThrow(OAuthStateMismatchError);
    });

    it("state 匹配时正常继续", async () => {
        ctx.mockSocialService.findByProvider.mockResolvedValue({
            userId: "u_ok",
            id: "sa_ok",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        const result = await ctx.handler(
            "wechat",
            "code",
            "http://localhost/callback",
            okState(),
        );

        expect(result.userId).toBe("u_ok");
    });
});

// ============================================================
// 已有绑定用户（existing user）
// ============================================================

describe("createOAuthHandler — 已有绑定用户", () => {
    let db: DatabaseAdapter;
    let ctx: ReturnType<typeof buildHandler>;

    beforeEach(() => {
        db = createInMemoryDb();
        ctx = buildHandler(db);
        vi.mocked(validateAuthorizationCode).mockReset();
    });

    it("已有绑定应发布审计事件，返回 isNewUser=false（不创建会话令牌）", async () => {
        ctx.providers.set("wechat", {
            provider: "wechat",
            exchangeCode: async () => ({
                openid: "oid_existing",
                accessToken: "at_wx",
                profileData: { nickname: "老用户" },
            }),
        });

        ctx.mockSocialService.findByProvider.mockResolvedValue({
            userId: "existing_user",
            id: "sa_1",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        const result = await ctx.handler(
            "wechat",
            "code123",
            "http://localhost/callback",
            okState(),
        );

        // 返回值
        expect(result.userId).toBe("existing_user");
        expect(result.isNewUser).toBe(false);
        expect(result.channel).toEqual({
            id: "sa_1",
            provider: "wechat",
            providerOpenid: "oid_existing",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        // 审计事件发布
        expect(ctx.publishAudit).toHaveBeenCalledWith({
            action: "oauthLogin",
            userId: "existing_user",
            metadata: {
                provider: "wechat",
                isNewUser: false,
                state: "state_abc123",
            },
        });

        // 不应创建 user / account 记录（OAuth 登录仅审计）
        expect(ctx.mockSocialService.bindToUser).not.toHaveBeenCalled();
    });
});

// ============================================================
// 新用户注册
// ============================================================

describe("createOAuthHandler — 新用户注册", () => {
    let db: DatabaseAdapter;
    let ctx: ReturnType<typeof buildHandler>;

    beforeEach(() => {
        db = createInMemoryDb();
        ctx = buildHandler(db);
        vi.mocked(validateAuthorizationCode).mockReset();
    });

    it("新用户应自行创建 user+绑定+审计，返回 isNewUser=true（不创建会话令牌）", async () => {
        ctx.providers.set("google", {
            provider: "google",
            exchangeCode: async () => ({
                openid: "g_new_user",
                accessToken: "at_google",
                email: "newuser@gmail.com",
                name: "New User",
                profileData: { avatar: "url" },
            }),
        });

        ctx.mockSocialService.findByProvider.mockResolvedValue(null);
        ctx.mockSocialService.bindToUser.mockResolvedValue({
            id: "sa_new",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        const result = await ctx.handler(
            "google",
            "code_google",
            "http://localhost/callback",
            okState(),
        );

        // 返回值
        expect(result.isNewUser).toBe(true);
        expect(result.userId).toBeDefined();
        expect(result.userId.length).toBeGreaterThan(5);
        expect(result.channel).toEqual({
            id: "sa_new",
            provider: "google",
            providerOpenid: "g_new_user",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        // 5.0.0 渠道化：OAuth 新用户无密码（password=null，不生成随机密码）
        const users = await db.findMany({
            model: "user",
            where: [],
        }) as Record<string, unknown>[];
        expect(users).toHaveLength(1);
        expect(users[0].password).toBeNull();

        // 绑定社交账户（事务内）
        expect(ctx.mockSocialService.bindToUser).toHaveBeenCalledWith(
            result.userId,
            expect.objectContaining({
                provider: "google",
                providerOpenid: "g_new_user",
                accessToken: "at_google",
                valid: 1,
                allowPasswordUpdate: 0,
            }),
        );

        // 审计事件发布
        expect(ctx.publishAudit).toHaveBeenCalledWith({
            action: "oauthLogin",
            userId: result.userId,
            metadata: {
                provider: "google",
                isNewUser: true,
                state: "state_abc123",
            },
        });
    });

    it("平台不返回邮箱时新用户无 email 字段（渠道身份 = provider+openid）", async () => {
        ctx.providers.set("wechat", {
            provider: "wechat",
            exchangeCode: async () => ({
                openid: "wx_test_user_1",
                accessToken: "at_wx_no_email",
                name: "微信用户",
            }),
        });

        ctx.mockSocialService.findByProvider.mockResolvedValue(null);
        ctx.mockSocialService.bindToUser.mockResolvedValue({
            id: "sa_ph",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        await ctx.handler("wechat", "code", "http://localhost/callback", okState());

        // 5.0.0 渠道化：user 不再有 email 列，身份全部在 socialAccount
        const users = await db.findMany({
            model: "user",
            where: [],
        }) as Record<string, unknown>[];
        expect(users).toHaveLength(1);
        expect(users[0]).not.toHaveProperty("email");
        expect(users[0].password).toBeNull();
    });

    it("平台返回邮箱时仅存入渠道资料，不充当用户标识（避免跨渠道邮箱碰撞）", async () => {
        ctx.providers.set("github", {
            provider: "github",
            exchangeCode: async () => ({
                openid: "gh_with_email",
                accessToken: "at_gh_email",
                email: "real@example.com",
                name: "GitHub User",
            }),
        });

        ctx.mockSocialService.findByProvider.mockResolvedValue(null);
        ctx.mockSocialService.bindToUser.mockResolvedValue({
            id: "sa_email",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        await ctx.handler("github", "code", "http://localhost/callback", okState());

        const users = await db.findMany({
            model: "user",
            where: [],
        }) as Record<string, unknown>[];
        expect(users).toHaveLength(1);
        expect(users[0]).not.toHaveProperty("email");

        // provider 邮箱仅作渠道资料，入 profileData
        expect(ctx.mockSocialService.bindToUser).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                provider: "github",
                providerOpenid: "gh_with_email",
                profileData: expect.objectContaining({ email: "real@example.com" }),
            })
        );
    });

    it("平台不返回 name 时使用默认名称", async () => {
        ctx.providers.set("github", {
            provider: "github",
            exchangeCode: async () => ({
                openid: "gh_no_name",
                accessToken: "at_gh",
                email: "gh@test.com",
            }),
        });

        ctx.mockSocialService.findByProvider.mockResolvedValue(null);
        ctx.mockSocialService.bindToUser.mockResolvedValue({
            id: "sa_nn",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        await ctx.handler("github", "code", "http://localhost/callback", okState());

        const users = await db.findMany({
            model: "user",
            where: [],
        }) as Record<string, unknown>[];
        expect(users[0].name).toBe("github_用户");
    });

    it("exchangeCode 抛出错误时应传播", async () => {
        ctx.providers.set("wechat", {
            provider: "wechat",
            exchangeCode: async () => {
                throw new Error("微信 token 换取失败");
            },
        });

        await expect(
            ctx.handler("wechat", "code", "http://localhost/callback", okState())
        ).rejects.toThrow("微信 token 换取失败");
    });
});

// ============================================================
// PKCE / state 支持
// ============================================================

describe("createOAuthHandler — PKCE / state", () => {
    let db: DatabaseAdapter;
    let ctx: ReturnType<typeof buildHandler>;

    beforeEach(() => {
        db = createInMemoryDb();
        ctx = buildHandler(db);
        vi.mocked(validateAuthorizationCode).mockReset();
    });

    it("标准 provider 有 getOAuthConfig + getUserInfo 时走 validateAuthorizationCode", async () => {
        ctx.providers.set("google", {
            provider: "google",
            getOAuthConfig: () => ({
                clientId: "google_client_id",
                clientSecret: "google_client_secret",
                authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
                tokenEndpoint: "https://oauth2.googleapis.com/token",
                scopes: ["openid", "email", "profile"],
            }),
            getUserInfo: async () => ({
                openid: "google_pkce_user",
                email: "pkce@gmail.com",
                name: "PKCE User",
                profileData: {},
            }),
        });

        vi.mocked(validateAuthorizationCode).mockResolvedValue({
            accessToken: "at_pkce",
            refreshToken: "rt_pkce",
            accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
        });

        ctx.mockSocialService.findByProvider.mockResolvedValue({
            userId: "pkce_user",
            id: "sa_pkce",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        const result = await ctx.handler(
            "google",
            "code_pkce",
            "http://localhost/callback",
            { state: "state_abc", expectedState: "state_abc", codeVerifier: "verifier_xyz" },
        );

        // validateAuthorizationCode 被调用，且传入了 codeVerifier
        expect(validateAuthorizationCode).toHaveBeenCalledWith(
            expect.objectContaining({
                code: "code_pkce",
                codeVerifier: "verifier_xyz",
                redirectURI: "http://localhost/callback",
                tokenEndpoint: "https://oauth2.googleapis.com/token",
            }),
        );

        // 返回值
        expect(result.userId).toBe("pkce_user");
    });

    it("未传 codeVerifier 时 validateAuthorizationCode 不含 codeVerifier", async () => {
        ctx.providers.set("google", {
            provider: "google",
            getOAuthConfig: () => ({
                clientId: "cid",
                clientSecret: "csec",
                authorizationEndpoint: "https://auth.example.com",
                tokenEndpoint: "https://token.example.com",
                scopes: ["email"],
            }),
            getUserInfo: async () => ({
                openid: "oid_no_pkce",
                email: "no@pkce.com",
                name: "No PKCE",
            }),
        });

        vi.mocked(validateAuthorizationCode).mockResolvedValue({
            accessToken: "at_no_pkce",
        });

        ctx.mockSocialService.findByProvider.mockResolvedValue({
            userId: "u_no_pkce",
            id: "sa_np",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        await ctx.handler("google", "code", "http://localhost/callback", okState());

        const callArgs = vi.mocked(validateAuthorizationCode).mock.calls[0][0];
        expect(callArgs.codeVerifier).toBeUndefined();
    });

    it("兼容 provider (exchangeCode) 应传入 codeVerifier", async () => {
        const exchangeCodeMock = vi.fn().mockResolvedValue({
            openid: "wx_pkce",
            accessToken: "at_wx",
        });

        ctx.providers.set("wechat", {
            provider: "wechat",
            exchangeCode: exchangeCodeMock,
        });

        ctx.mockSocialService.findByProvider.mockResolvedValue({
            userId: "u_wx",
            id: "sa_wx",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        await ctx.handler(
            "wechat",
            "code",
            "http://localhost/callback",
            { state: "state_wx", expectedState: "state_wx", codeVerifier: "verifier_wx" },
        );

        expect(exchangeCodeMock).toHaveBeenCalledWith(
            "code",
            "http://localhost/callback",
            "verifier_wx",
        );
    });
});

// ============================================================
// initiateOAuth
// ============================================================

describe("createOAuthHandler — initiateOAuth", () => {
    let db: DatabaseAdapter;
    let ctx: ReturnType<typeof buildHandler>;

    beforeEach(() => {
        db = createInMemoryDb();
        ctx = buildHandler(db);
        vi.mocked(createAuthorizationURL).mockReset();
    });

    it("未注册的 provider 应抛出错误", async () => {
        await expect(
            ctx.handler.initiateOAuth("unknown", "http://localhost/callback")
        ).rejects.toThrow("未注册的 OAuth 平台");
    });

    it("标准 provider 使用 createAuthorizationURL 构建授权 URL", async () => {
        ctx.providers.set("google", {
            provider: "google",
            getOAuthConfig: () => ({
                clientId: "cid",
                clientSecret: "csec",
                authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
                tokenEndpoint: "https://oauth2.googleapis.com/token",
                scopes: ["openid", "email"],
            }),
        });

        vi.mocked(createAuthorizationURL).mockResolvedValue(
            new URL("https://accounts.google.com/o/oauth2/v2/auth?state=test&code_challenge=xxx"),
        );

        const result = await ctx.handler.initiateOAuth(
            "google",
            "http://localhost/callback",
        );

        // createAuthorizationURL 被调用
        expect(createAuthorizationURL).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "google",
                authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
                redirectURI: "http://localhost/callback",
                scopes: ["openid", "email"],
            }),
        );

        // 传入了 state + codeVerifier
        const callArgs = vi.mocked(createAuthorizationURL).mock.calls[0][0];
        expect(callArgs.state).toBeDefined();
        expect(callArgs.state.length).toBeGreaterThan(10);
        expect(callArgs.codeVerifier).toBeDefined();
        expect(callArgs.codeVerifier!.length).toBeGreaterThan(10);

        // 返回值
        expect(result.authorizationUrl).toContain("accounts.google.com");
        expect(result.state).toBe(callArgs.state);
        expect(result.codeVerifier).toBe(callArgs.codeVerifier);
    });

    it("非标准 provider 使用 buildAuthorizationUrl 构建授权 URL", async () => {
        const buildUrlMock = vi.fn().mockReturnValue(
            "https://open.weixin.qq.com/connect/qrconnect?appid=wx123&state=test",
        );

        ctx.providers.set("wechat", {
            provider: "wechat",
            buildAuthorizationUrl: buildUrlMock,
            exchangeCode: async () => ({
                openid: "x",
                accessToken: "y",
            }),
        });

        const result = await ctx.handler.initiateOAuth(
            "wechat",
            "http://localhost/callback",
        );

        // buildAuthorizationUrl 被调用
        expect(buildUrlMock).toHaveBeenCalledWith(
            expect.objectContaining({
                redirectUri: "http://localhost/callback",
            }),
        );

        // 返回值
        expect(result.authorizationUrl).toContain("open.weixin.qq.com");
        expect(result.state).toBeDefined();
        expect(result.state.length).toBeGreaterThan(10);
        expect(result.codeVerifier).toBeDefined();
    });

    it("既无 getOAuthConfig 也无 buildAuthorizationUrl 时应抛出错误", async () => {
        ctx.providers.set("custom", {
            provider: "custom",
            exchangeCode: async () => ({
                openid: "x",
                accessToken: "y",
            }),
        });

        await expect(
            ctx.handler.initiateOAuth("custom", "http://localhost/callback")
        ).rejects.toThrow("不支持 initiateOAuth");
    });
});
