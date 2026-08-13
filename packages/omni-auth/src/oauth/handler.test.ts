import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================
// Mock 外部依赖
// ============================================================

vi.mock("@better-auth/core/oauth2", () => ({
    createAuthorizationURL: vi.fn(),
    validateAuthorizationCode: vi.fn(),
}));

vi.mock("../core/token", () => ({
    createAuthToken: vi.fn(),
}));

vi.mock("../core/audit", () => ({
    publishAuditEvent: vi.fn(),
}));

vi.mock("@better-auth/utils/password", () => ({
    hashPassword: vi.fn(),
}));

// ---- 在 mock 之后导入 ----

import {
    createOAuthHandler,
    handleOAuthCallback,
    initiateOAuth,
} from "./handler";
import { registerOAuthProvider, clearOAuthProviders } from "./registry";
import { createAuthToken } from "../core/token";
import { publishAuditEvent } from "../core/audit";
import { hashPassword } from "@better-auth/utils/password";
import {
    createAuthorizationURL,
    validateAuthorizationCode,
} from "@better-auth/core/oauth2";
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
        async count({ model, where }) {
            const table = ensureModel(model);
            let n = 0;
            for (const [, r] of table) {
                if (!where || where.every((w) => r[w.field] === w.value)) n++;
            }
            return n;
        },
        async updateOne({ model, where, update }) { throw new Error("Not used"); },
        async updateMany({ model, where, update }) { return 0; },
        async deleteOne({ model, where }) { throw new Error("Not used"); },
        async deleteMany({ model, where }) { return 0; },
    };
}

// ============================================================
// 测试
// ============================================================

describe("createOAuthHandler — 基础", () => {
    let db: DatabaseAdapter;
    let handler: ReturnType<typeof createOAuthHandler>;

    const mockSocialService = {
        findByProvider: vi.fn(),
        bindToUser: vi.fn(),
    };

    beforeEach(() => {
        clearOAuthProviders();
        db = createInMemoryDb();
        mockSocialService.findByProvider.mockReset();
        mockSocialService.bindToUser.mockReset();
        vi.mocked(createAuthToken).mockReset();
        vi.mocked(publishAuditEvent).mockReset();
        vi.mocked(hashPassword).mockReset();
        vi.mocked(createAuthorizationURL).mockReset();
        vi.mocked(validateAuthorizationCode).mockReset();

        // 默认 mock 返回值
        vi.mocked(createAuthToken).mockResolvedValue("auth_token_mock");
        vi.mocked(publishAuditEvent).mockResolvedValue(undefined);
        vi.mocked(hashPassword).mockResolvedValue("hashed_password_mock");

        handler = createOAuthHandler({
            db,
            socialService: mockSocialService,
            expiresIn: 3600,
        });
    });

    it("未注册的 provider 应抛出错误", async () => {
        await expect(
            handler("unknown_provider", "some_code", "http://localhost/callback")
        ).rejects.toThrow("未注册的 OAuth 平台");
    });
});

// ============================================================
// 已有绑定用户（existing user）
// ============================================================

describe("createOAuthHandler — 已有绑定用户", () => {
    let db: DatabaseAdapter;
    let handler: ReturnType<typeof createOAuthHandler>;

    const mockSocialService = {
        findByProvider: vi.fn(),
        bindToUser: vi.fn(),
    };

    beforeEach(() => {
        clearOAuthProviders();
        db = createInMemoryDb();
        mockSocialService.findByProvider.mockReset();
        mockSocialService.bindToUser.mockReset();
        vi.mocked(createAuthToken).mockReset();
        vi.mocked(publishAuditEvent).mockReset();
        vi.mocked(hashPassword).mockReset();
        vi.mocked(validateAuthorizationCode).mockReset();

        vi.mocked(createAuthToken).mockResolvedValue("auth_token_existing");
        vi.mocked(publishAuditEvent).mockResolvedValue(undefined);
        vi.mocked(hashPassword).mockResolvedValue("hashed_mock");

        handler = createOAuthHandler({
            db,
            socialService: mockSocialService,
            expiresIn: 3600,
        });
    });

    it("已有绑定应创建 AuthToken + 发布审计事件，返回 isNewUser=false", async () => {
        // 使用 exchangeCode 兼容路径
        registerOAuthProvider({
            provider: "wechat",
            exchangeCode: async () => ({
                openid: "oid_existing",
                accessToken: "at_wx",
                profileData: { nickname: "老用户" },
            }),
        } as OAuthProviderConfig);

        mockSocialService.findByProvider.mockResolvedValue({
            userId: "existing_user",
            id: "sa_1",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        const result = await handler(
            "wechat",
            "code123",
            "http://localhost/callback",
        );

        // 返回值
        expect(result.userId).toBe("existing_user");
        expect(result.isNewUser).toBe(false);
        expect(result.token).toBe("auth_token_existing");
        expect(result.channel).toEqual({
            id: "sa_1",
            provider: "wechat",
            providerOpenid: "oid_existing",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        // createAuthToken 被调用
        expect(createAuthToken).toHaveBeenCalledWith(
            db,
            "existing_user",
            3600,
            { provider: "wechat", isNewUser: false },
        );

        // 审计事件发布
        expect(publishAuditEvent).toHaveBeenCalledWith({
            action: "oauthLogin",
            userId: "existing_user",
            metadata: {
                provider: "wechat",
                isNewUser: false,
                state: null,
            },
        });

        // 不应创建 user / account 记录
        expect(hashPassword).not.toHaveBeenCalled();
        expect(mockSocialService.bindToUser).not.toHaveBeenCalled();
    });

    it("传入 state 时审计事件 metadata 应包含 state", async () => {
        registerOAuthProvider({
            provider: "wechat",
            exchangeCode: async () => ({
                openid: "oid_state",
                accessToken: "at",
            }),
        } as OAuthProviderConfig);

        mockSocialService.findByProvider.mockResolvedValue({
            userId: "u_state",
            id: "sa_state",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        await handler(
            "wechat",
            "code",
            "http://localhost/callback",
            "state_abc123",
            "verifier_xyz",
        );

        expect(publishAuditEvent).toHaveBeenCalledWith({
            action: "oauthLogin",
            userId: "u_state",
            metadata: {
                provider: "wechat",
                isNewUser: false,
                state: "state_abc123",
            },
        });
    });
});

// ============================================================
// 新用户注册
// ============================================================

describe("createOAuthHandler — 新用户注册", () => {
    let db: DatabaseAdapter;
    let handler: ReturnType<typeof createOAuthHandler>;

    const mockSocialService = {
        findByProvider: vi.fn(),
        bindToUser: vi.fn(),
    };

    beforeEach(() => {
        clearOAuthProviders();
        db = createInMemoryDb();
        mockSocialService.findByProvider.mockReset();
        mockSocialService.bindToUser.mockReset();
        vi.mocked(createAuthToken).mockReset();
        vi.mocked(publishAuditEvent).mockReset();
        vi.mocked(hashPassword).mockReset();
        vi.mocked(validateAuthorizationCode).mockReset();

        vi.mocked(createAuthToken).mockResolvedValue("auth_token_new");
        vi.mocked(publishAuditEvent).mockResolvedValue(undefined);
        vi.mocked(hashPassword).mockResolvedValue("hashed_password_new");

        handler = createOAuthHandler({
            db,
            socialService: mockSocialService,
            expiresIn: 7200,
        });
    });

    it("新用户应自行创建 user+account+AuthToken+绑定+审计，返回 isNewUser=true", async () => {
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
        mockSocialService.bindToUser.mockResolvedValue({
            id: "sa_new",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        const result = await handler(
            "google",
            "code_google",
            "http://localhost/callback",
        );

        // 返回值
        expect(result.isNewUser).toBe(true);
        expect(result.token).toBe("auth_token_new");
        expect(result.userId).toBeDefined();
        expect(result.userId.length).toBeGreaterThan(5);
        expect(result.channel).toEqual({
            id: "sa_new",
            provider: "google",
            providerOpenid: "g_new_user",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        // hashPassword 被调用（随机密码哈希）
        expect(hashPassword).toHaveBeenCalledTimes(1);

        // 绑定社交账户
        expect(mockSocialService.bindToUser).toHaveBeenCalledWith(
            result.userId,
            expect.objectContaining({
                provider: "google",
                providerOpenid: "g_new_user",
                accessToken: "at_google",
                valid: 1,
                allowPasswordUpdate: 0,
            }),
        );

        // createAuthToken 被调用
        expect(createAuthToken).toHaveBeenCalledWith(
            db,
            result.userId,
            7200,
            { provider: "google", isNewUser: true },
        );

        // 审计事件发布
        expect(publishAuditEvent).toHaveBeenCalledWith({
            action: "oauthLogin",
            userId: result.userId,
            metadata: {
                provider: "google",
                isNewUser: true,
                state: null,
            },
        });
    });

    it("平台不返回邮箱时使用占位邮箱", async () => {
        registerOAuthProvider({
            provider: "wechat",
            exchangeCode: async () => ({
                openid: "wx_test_user_1",
                accessToken: "at_wx_no_email",
                name: "微信用户",
            }),
        } as OAuthProviderConfig);

        mockSocialService.findByProvider.mockResolvedValue(null);
        mockSocialService.bindToUser.mockResolvedValue({});

        await handler("wechat", "code", "http://localhost/callback");

        // 验证 user 创建时使用了占位邮箱
        const users = await db.findMany({
            model: "user",
            where: [],
        }) as Record<string, unknown>[];
        expect(users).toHaveLength(1);
        expect(users[0].email).toBe("wechat_wx_test_user@oauth.usercenter");
    });

    it("平台不返回 name 时使用默认名称", async () => {
        registerOAuthProvider({
            provider: "github",
            exchangeCode: async () => ({
                openid: "gh_no_name",
                accessToken: "at_gh",
                email: "gh@test.com",
            }),
        } as OAuthProviderConfig);

        mockSocialService.findByProvider.mockResolvedValue(null);
        mockSocialService.bindToUser.mockResolvedValue({});

        await handler("github", "code", "http://localhost/callback");

        const users = await db.findMany({
            model: "user",
            where: [],
        }) as Record<string, unknown>[];
        expect(users[0].name).toBe("github_用户");
    });

    it("exchangeCode 抛出错误时应传播", async () => {
        registerOAuthProvider({
            provider: "wechat",
            exchangeCode: async () => {
                throw new Error("微信 token 换取失败");
            },
        } as OAuthProviderConfig);

        await expect(
            handler("wechat", "code", "http://localhost/callback")
        ).rejects.toThrow("微信 token 换取失败");
    });
});

// ============================================================
// PKCE / state 支持
// ============================================================

describe("createOAuthHandler — PKCE / state", () => {
    let db: DatabaseAdapter;
    let handler: ReturnType<typeof createOAuthHandler>;

    const mockSocialService = {
        findByProvider: vi.fn(),
        bindToUser: vi.fn(),
    };

    beforeEach(() => {
        clearOAuthProviders();
        db = createInMemoryDb();
        mockSocialService.findByProvider.mockReset();
        mockSocialService.bindToUser.mockReset();
        vi.mocked(createAuthToken).mockReset();
        vi.mocked(publishAuditEvent).mockReset();
        vi.mocked(hashPassword).mockReset();
        vi.mocked(validateAuthorizationCode).mockReset();

        vi.mocked(createAuthToken).mockResolvedValue("auth_token_pkce");
        vi.mocked(publishAuditEvent).mockResolvedValue(undefined);
        vi.mocked(hashPassword).mockResolvedValue("hashed_pkce");

        handler = createOAuthHandler({
            db,
            socialService: mockSocialService,
            expiresIn: 3600,
        });
    });

    it("标准 provider 有 getOAuthConfig + getUserInfo 时走 validateAuthorizationCode", async () => {
        registerOAuthProvider({
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
        } as OAuthProviderConfig);

        vi.mocked(validateAuthorizationCode).mockResolvedValue({
            accessToken: "at_pkce",
            refreshToken: "rt_pkce",
            accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
        });

        mockSocialService.findByProvider.mockResolvedValue({
            userId: "pkce_user",
            id: "sa_pkce",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        const result = await handler(
            "google",
            "code_pkce",
            "http://localhost/callback",
            "state_abc",
            "verifier_xyz",
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
        expect(result.token).toBe("auth_token_pkce");
    });

    it("标准 provider 未传 codeVerifier 时 validateAuthorizationCode 不含 codeVerifier", async () => {
        registerOAuthProvider({
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
        } as OAuthProviderConfig);

        vi.mocked(validateAuthorizationCode).mockResolvedValue({
            accessToken: "at_no_pkce",
        });

        mockSocialService.findByProvider.mockResolvedValue({
            userId: "u_no_pkce",
            id: "sa_np",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        await handler("google", "code", "http://localhost/callback");

        const callArgs = vi.mocked(validateAuthorizationCode).mock.calls[0][0];
        expect(callArgs.codeVerifier).toBeUndefined();
    });

    it("兼容 provider (exchangeCode) 应传入 codeVerifier", async () => {
        const exchangeCodeMock = vi.fn().mockResolvedValue({
            openid: "wx_pkce",
            accessToken: "at_wx",
        });

        registerOAuthProvider({
            provider: "wechat",
            exchangeCode: exchangeCodeMock,
        } as OAuthProviderConfig);

        mockSocialService.findByProvider.mockResolvedValue({
            userId: "u_wx",
            id: "sa_wx",
            valid: 1,
            allowPasswordUpdate: 0,
        });

        await handler(
            "wechat",
            "code",
            "http://localhost/callback",
            "state_wx",
            "verifier_wx",
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
    let handler: ReturnType<typeof createOAuthHandler>;

    const mockSocialService = {
        findByProvider: vi.fn(),
        bindToUser: vi.fn(),
    };

    beforeEach(() => {
        clearOAuthProviders();
        db = createInMemoryDb();
        vi.mocked(createAuthorizationURL).mockReset();

        handler = createOAuthHandler({
            db,
            socialService: mockSocialService,
            expiresIn: 3600,
        });
    });

    it("未注册的 provider 应抛出错误", async () => {
        await expect(
            handler.initiateOAuth("unknown", "http://localhost/callback")
        ).rejects.toThrow("未注册的 OAuth 平台");
    });

    it("标准 provider 使用 createAuthorizationURL 构建授权 URL", async () => {
        registerOAuthProvider({
            provider: "google",
            getOAuthConfig: () => ({
                clientId: "cid",
                clientSecret: "csec",
                authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
                tokenEndpoint: "https://oauth2.googleapis.com/token",
                scopes: ["openid", "email"],
            }),
        } as OAuthProviderConfig);

        vi.mocked(createAuthorizationURL).mockResolvedValue(
            new URL("https://accounts.google.com/o/oauth2/v2/auth?state=test&code_challenge=xxx"),
        );

        const result = await handler.initiateOAuth(
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

        registerOAuthProvider({
            provider: "wechat",
            buildAuthorizationUrl: buildUrlMock,
            exchangeCode: async () => ({
                openid: "x",
                accessToken: "y",
            }),
        } as OAuthProviderConfig);

        const result = await handler.initiateOAuth(
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
        registerOAuthProvider({
            provider: "custom",
            exchangeCode: async () => ({
                openid: "x",
                accessToken: "y",
            }),
        } as OAuthProviderConfig);

        await expect(
            handler.initiateOAuth("custom", "http://localhost/callback")
        ).rejects.toThrow("不支持 initiateOAuth");
    });
});

// ============================================================
// 全局 handler 测试
// ============================================================

describe("全局 handleOAuthCallback / initiateOAuth", () => {
    it("未初始化时 handleOAuthCallback 应抛异常", async () => {
        await expect(
            handleOAuthCallback("wechat", "code", "http://localhost/callback")
        ).rejects.toThrow("OAuth handler 未初始化");
    });

    it("未初始化时 initiateOAuth 应抛异常", async () => {
        await expect(
            initiateOAuth("wechat", "http://localhost/callback")
        ).rejects.toThrow("OAuth handler 未初始化");
    });
});
