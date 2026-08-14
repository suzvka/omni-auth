// ============================================================
// OAuth 回调处理逻辑 — state/PKCE + @better-auth/core/oauth2
//
// 发起授权: 生成 state + code_verifier → 签名 cookie → 授权 URL
// 回调: 读 cookie → 验签 → 比对 state → PKCE 换 token → 用户查找/创建 + 渠道绑定
//
// 3.0.0 起：
// - 对象形式回调参数（OAuthCallbackOptions）强制库内比对 state；
// - provider 注册表 / 审计处理器经依赖注入（无模块级全局单例）；
// - 新建用户多表写入包入事务（适配器支持时）。
// ============================================================

import { randomBytes, randomUUID } from "crypto";
import {
    createAuthorizationURL,
    validateAuthorizationCode,
} from "@better-auth/core/oauth2";
import type { DatabaseAdapter } from "../adapters/database";
import { withTransaction } from "../adapters/database";
import type { OAuthCallbackResult, OAuthProviderConfig } from "./types";
import type { AuditEvent } from "../core/audit";
import { hashPassword } from "@better-auth/utils/password";
import {
    OAuthStateMismatchError,
    UniqueViolationError,
    SocialAccountConflictError,
} from "../errors";
import {
    buildPlaceholderEmail,
    generateRandomPassword,
} from "../core/channel-mapping";
import { createDbFacade } from "../models";

// ---- 类型 ----

/** SocialService 在 OAuth handler 中的最小依赖接口 */
export interface SocialServiceForOAuth {
    findByProvider(
        provider: string,
        providerOpenid: string,
    ): Promise<{
        userId: string;
        id: string;
        valid: number;
        allowPasswordUpdate: number;
    } | null>;
    bindToUser(
        userId: string,
        input: Record<string, unknown>,
    ): Promise<{
        id: string;
        valid: number;
        allowPasswordUpdate: number;
    }>;
}

/** initiateOAuth 返回值 */
export interface OAuthInitiateResult {
    /** 授权 URL（重定向用户到此处） */
    authorizationUrl: string;
    /** CSRF state（调用方写入签名 cookie） */
    state: string;
    /** PKCE code_verifier（调用方写入签名 cookie） */
    codeVerifier: string;
}

/**
 * 回调参数（对象形式，推荐）。
 *
 * 使用对象形式时库内强制校验 state：state / expectedState 任一缺失
 * 或二者不一致都会抛 OAuthStateMismatchError。
 * expectedState 应来自服务端保存的值（如签名 cookie），而非回调请求本身。
 */
export interface OAuthCallbackOptions {
    /** 回调携带的 state */
    state?: string;
    /** 发起授权时服务端保存的 state（如签名 cookie 中的值） */
    expectedState?: string;
    /** PKCE code_verifier */
    codeVerifier?: string;
}

/** OAuth handler 实例类型 */
export interface OAuthHandler {
    (
        provider: string,
        code: string,
        redirectUri: string,
        stateOrOptions?: string | OAuthCallbackOptions,
        /** @deprecated 仅旧位置参数签名使用 */
        codeVerifier?: string,
    ): Promise<OAuthCallbackResult>;
    initiateOAuth(provider: string, redirectUri: string): Promise<OAuthInitiateResult>;
}

/** 旧位置参数签名的弃用警告（仅一次） */
let legacySignatureWarned = false;

// ============================================================
// OAuth 回调处理器工厂
// ============================================================

/**
 * OAuth 回调处理器工厂。
 *
 * 自行创建 user / account 记录（不依赖第三方 auth 内核）；
 * 通过 @better-auth/core/oauth2 完成授权 URL 生成与 code 交换（含 state/PKCE）；
 * 登录成功后发布 oauthLogin 审计事件。不创建任何会话令牌。
 *
 * 依赖注入（无模块级全局状态）：
 * - getProvider：provider 注册表查询（通常为实例注册表的闭包）
 * - socialService：按 DatabaseAdapter 构造社交服务（事务内传入 tx 适配器）
 * - publishAudit：实例级审计发布入口（可选）
 */
export function createOAuthHandler(deps: {
    db: DatabaseAdapter;
    getProvider: (provider: string) => OAuthProviderConfig | undefined;
    socialService: (db: DatabaseAdapter) => SocialServiceForOAuth;
    publishAudit?: (event: Omit<AuditEvent, "timestamp">) => Promise<void>;
}): OAuthHandler {
    const { db, getProvider, socialService, publishAudit } = deps;

    async function audit(event: Omit<AuditEvent, "timestamp">): Promise<void> {
        if (publishAudit) await publishAudit(event);
    }

    // ---- initiateOAuth: 发起授权 ----

    async function initiateOAuth(
        provider: string,
        redirectUri: string,
    ): Promise<OAuthInitiateResult> {
        const config = getProvider(provider);
        if (!config) {
            throw new Error(
                `未注册的 OAuth 平台: "${provider}"。请先调用 auth.registerOAuthProvider。`,
            );
        }

        // 生成 state + code_verifier（PKCE）
        const state = randomBytes(32).toString("base64url");
        const codeVerifier = randomBytes(32).toString("base64url");

        let authorizationUrl: string;

        if (config.getOAuthConfig) {
            // 标准 OAuth2: 使用 @better-auth/core/oauth2 的 createAuthorizationURL
            // createAuthorizationURL 内部调用 generateCodeChallenge 计算 S256 code_challenge
            const oauthConfig = config.getOAuthConfig();
            const url = await createAuthorizationURL({
                id: provider,
                options: {
                    clientId: oauthConfig.clientId,
                    clientSecret: oauthConfig.clientSecret,
                    redirectURI: redirectUri,
                },
                authorizationEndpoint: oauthConfig.authorizationEndpoint,
                redirectURI: redirectUri,
                state,
                codeVerifier,
                scopes: oauthConfig.scopes,
            });
            authorizationUrl = url.toString();
        } else if (config.buildAuthorizationUrl) {
            // 非标准 OAuth2 (如微信): 使用 provider 自定义 URL 构建器
            authorizationUrl = config.buildAuthorizationUrl({
                state,
                codeVerifier,
                redirectUri,
            });
        } else {
            throw new Error(
                `Provider "${provider}" 不支持 initiateOAuth（未实现 getOAuthConfig 或 buildAuthorizationUrl）`,
            );
        }

        return { authorizationUrl, state, codeVerifier };
    }

    // ---- handleOAuthCallback: 处理回调 ----

    async function handleOAuthCallback(
        provider: string,
        code: string,
        redirectUri: string,
        stateOrOptions?: string | OAuthCallbackOptions,
        codeVerifierArg?: string,
    ): Promise<OAuthCallbackResult> {
        const config = getProvider(provider);
        if (!config) {
            throw new Error(
                `未注册的 OAuth 平台: "${provider}"。请先调用 auth.registerOAuthProvider。`,
            );
        }

        // ---- 0. state 校验 ----

        let state: string | undefined;
        let codeVerifier: string | undefined;

        if (typeof stateOrOptions === "object" && stateOrOptions !== null) {
            // 对象形式：库内强制校验 state（CSRF 防护）
            const { state: incoming, expectedState, codeVerifier: cv } = stateOrOptions;
            codeVerifier = cv;
            state = incoming;
            if (!incoming || !expectedState || incoming !== expectedState) {
                await audit({
                    action: "oauthLogin",
                    metadata: { provider, rejected: "state_mismatch" },
                });
                throw new OAuthStateMismatchError(
                    !incoming || !expectedState
                        ? "OAuth state 缺失：回调必须携带 state 且服务端保存 expectedState"
                        : "OAuth state 不匹配",
                );
            }
        } else {
            // 旧位置参数签名（已弃用，不校验 state）
            state = stateOrOptions;
            codeVerifier = codeVerifierArg;
            if (!legacySignatureWarned) {
                legacySignatureWarned = true;
                console.warn(
                    "[omni-auth] handleOAuthCallback 位置参数签名已弃用且不校验 state，请改用对象形式 { state, expectedState, codeVerifier }。",
                );
            }
        }

        // ---- 1. 换取 token + 用户信息 ----

        let exchanged: {
            openid: string;
            accessToken: string;
            refreshToken?: string;
            expiresAt?: Date;
            profileData?: Record<string, unknown>;
            email?: string;
            name?: string;
        };

        if (config.getOAuthConfig && config.getUserInfo) {
            // 标准 OAuth2: 使用 @better-auth/core/oauth2 的 validateAuthorizationCode
            const oauthConfig = config.getOAuthConfig();
            const tokens = await validateAuthorizationCode({
                code,
                codeVerifier,
                redirectURI: redirectUri,
                options: {
                    clientId: oauthConfig.clientId,
                    clientSecret: oauthConfig.clientSecret,
                    redirectURI: redirectUri,
                },
                tokenEndpoint: oauthConfig.tokenEndpoint,
            });

            const userInfo = await config.getUserInfo(tokens);
            exchanged = {
                openid: userInfo.openid,
                accessToken: tokens.accessToken ?? "",
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.accessTokenExpiresAt,
                profileData: userInfo.profileData,
                email: userInfo.email,
                name: userInfo.name,
            };
        } else {
            // 兼容模式: 使用 provider 的 exchangeCode（传入 codeVerifier 供 PKCE）
            if (!config.exchangeCode) {
                throw new Error(
                    `Provider "${provider}" 未实现 exchangeCode，无法换取 token`,
                );
            }
            exchanged = await config.exchangeCode(code, redirectUri, codeVerifier);
        }

        // ---- 2. 查是否已有绑定 ----

        const existingSocial = await socialService(db).findByProvider(
            provider,
            exchanged.openid,
        );

        if (existingSocial) {
            // 已有绑定: 审计（不创建会话令牌）
            const userId = existingSocial.userId;

            await audit({
                action: "oauthLogin",
                userId,
                metadata: {
                    provider,
                    isNewUser: false,
                    state: state ?? null,
                },
            });

            return {
                userId,
                isNewUser: false,
                channel: {
                    id: existingSocial.id,
                    provider,
                    providerOpenid: exchanged.openid,
                    valid: existingSocial.valid,
                    allowPasswordUpdate: existingSocial.allowPasswordUpdate,
                },
            };
        }

        // ---- 3. 新建用户 + 绑定社交账户（事务，原子提交） ----

        // 渠道模型：OAuth 身份 = provider + openid，provider 邮箱仅作渠道资料，
        // 不充当 user.email（避免不同渠道用户邮箱碰撞触发唯一约束冲突）
        const email = buildPlaceholderEmail(provider, exchanged.openid);
        const name = exchanged.name ?? `${provider}_用户`;
        const password = generateRandomPassword();
        const passwordHash = await hashPassword(password);
        const userId = randomUUID();

        let bindResult: {
            id: string;
            valid: number;
            allowPasswordUpdate: number;
        };

        try {
            bindResult = await withTransaction(db, async (tx) => {
                const dbf = createDbFacade(tx);
                const now = new Date();

                // 创建 user 记录
                await dbf.user.create({
                    data: {
                        id: userId,
                        email,
                        name,
                        createdAt: now,
                        updatedAt: now,
                    },
                });

                // 创建 credential account 记录（存储密码哈希）
                await dbf.account.create({
                    data: {
                        id: randomUUID(),
                        accountId: email,
                        providerId: "credential",
                        userId,
                        password: passwordHash,
                        createdAt: now,
                        updatedAt: now,
                    },
                });

                // 绑定社交账户（valid=1，真实的 OAuth 绑定）
                return socialService(tx).bindToUser(userId, {
                    provider,
                    providerOpenid: exchanged.openid,
                    accessToken: exchanged.accessToken,
                    refreshToken: exchanged.refreshToken,
                    tokenExpiresAt: exchanged.expiresAt,
                    profileData: {
                        ...(exchanged.profileData ?? {}),
                        ...(exchanged.email ? { email: exchanged.email } : {}),
                    },
                    valid: 1,
                    allowPasswordUpdate: 0,
                });
            });
        } catch (err) {
            if (err instanceof UniqueViolationError) {
                // 占位邮箱 / 渠道并发注册等唯一约束冲突
                throw new SocialAccountConflictError(provider, exchanged.openid);
            }
            throw err;
        }

        await audit({
            action: "oauthLogin",
            userId,
            metadata: {
                provider,
                isNewUser: true,
                state: state ?? null,
            },
        });

        return {
            userId,
            isNewUser: true,
            channel: {
                id: bindResult.id,
                provider,
                providerOpenid: exchanged.openid,
                valid: bindResult.valid,
                allowPasswordUpdate: bindResult.allowPasswordUpdate,
            },
        };
    }

    // 将 initiateOAuth 挂载到 handleOAuthCallback 上
    return Object.assign(handleOAuthCallback, { initiateOAuth });
}
