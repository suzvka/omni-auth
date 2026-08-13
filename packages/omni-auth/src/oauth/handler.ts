// ============================================================
// OAuth 回调处理逻辑 — state/PKCE + @better-auth/core/oauth2
//
// 发起授权: 生成 state + code_verifier → 签名 cookie → 授权 URL
// 回调: 读 cookie → 验签 → 比对 state → PKCE 换 token → 用户查找/创建 + 渠道绑定
// ============================================================

import { randomBytes, randomUUID } from "crypto";
import {
    createAuthorizationURL,
    validateAuthorizationCode,
} from "@better-auth/core/oauth2";
import type { DatabaseAdapter } from "../adapters/database";
import type { OAuthCallbackResult } from "./types";
import { getOAuthProvider } from "./registry";
import { publishAuditEvent } from "../core/audit";
import { hashPassword } from "@better-auth/utils/password";

// ---- 类型 ----

/** SocialService 在 OAuth handler 中的最小依赖接口 */
interface SocialServiceForOAuth {
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

/** OAuth handler 实例类型 */
export interface OAuthHandler {
    (
        provider: string,
        code: string,
        redirectUri: string,
        state?: string,
        codeVerifier?: string,
    ): Promise<OAuthCallbackResult>;
    initiateOAuth(provider: string, redirectUri: string): Promise<OAuthInitiateResult>;
}

// ---- 辅助函数 ----

/** 为 OAuth 用户生成随机密码 */
function generateRandomPassword(): string {
    return randomBytes(32).toString("hex");
}

/** 生成平台邮箱占位符 */
function generatePlaceholderEmail(provider: string, openid: string): string {
    return `${provider}_${openid.substring(0, 12)}@oauth.usercenter`;
}

// ============================================================
// OAuth 回调处理器工厂
// ============================================================

/**
 * OAuth 回调处理器工厂。
 *
 * 自行创建 user / account / businessAccount 记录（不依赖第三方 auth 内核）；
 * 通过 @better-auth/core/oauth2 完成授权 URL 生成与 code 交换（含 state/PKCE）；
 * 登录成功后发布 oauthLogin 审计事件。不创建任何会话令牌。
 */
export function createOAuthHandler(deps: {
    db: DatabaseAdapter;
    socialService: SocialServiceForOAuth;
}): OAuthHandler {
    const { db, socialService } = deps;

    // ---- initiateOAuth: 发起授权 ----

    async function initiateOAuth(
        provider: string,
        redirectUri: string,
    ): Promise<OAuthInitiateResult> {
        const config = getOAuthProvider(provider);
        if (!config) {
            throw new Error(
                `未注册的 OAuth 平台: "${provider}"。请先调用 registerOAuthProvider。`,
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
        state?: string,
        codeVerifier?: string,
    ): Promise<OAuthCallbackResult> {
        const config = getOAuthProvider(provider);
        if (!config) {
            throw new Error(
                `未注册的 OAuth 平台: "${provider}"。请先调用 registerOAuthProvider。`,
            );
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

        const existingSocial = await socialService.findByProvider(
            provider,
            exchanged.openid,
        );

        if (existingSocial) {
            // 已有绑定: 审计（不创建会话令牌）
            const userId = existingSocial.userId;

            await publishAuditEvent({
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

        // ---- 3. 新建用户 + 绑定社交账户 ----

        const email =
            exchanged.email ?? generatePlaceholderEmail(provider, exchanged.openid);
        const name = exchanged.name ?? `${provider}_用户`;
        const password = generateRandomPassword();
        const passwordHash = await hashPassword(password);

        // 创建 user 记录
        const userId = randomUUID();
        await db.create({
            model: "user",
            data: {
                id: userId,
                email,
                name,
                emailVerified: false,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        });

        // 创建 credential account 记录（存储密码哈希）
        await db.create({
            model: "account",
            data: {
                id: randomUUID(),
                accountId: email,
                providerId: "credential",
                userId,
                password: passwordHash,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        });

        // 创建 BusinessAccount（与 signUp 保持一致，内联创建）
        await db.create({
            model: "businessAccount",
            data: {
                id: randomUUID(),
                authUserId: userId,
                displayName: name || email,
                status: "active",
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        });

        // 绑定社交账户（valid=1，真实的 OAuth 绑定）
        const bindResult = await socialService.bindToUser(userId, {
            provider,
            providerOpenid: exchanged.openid,
            accessToken: exchanged.accessToken,
            refreshToken: exchanged.refreshToken,
            tokenExpiresAt: exchanged.expiresAt,
            profileData: exchanged.profileData,
            valid: 1,
            allowPasswordUpdate: 0,
        });

        await publishAuditEvent({
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

// ============================================================
// 全局 handler（向后兼容，由 OmniAuth 初始化时注入依赖）
// ============================================================

let globalHandler: OAuthHandler | null = null;

export function setOAuthHandler(handler: OAuthHandler): void {
    globalHandler = handler;
}

/**
 * 全局 handleOAuthCallback。
 *
 * state / codeVerifier 为可选参数，由 social callback 路由从签名 cookie 中读取后传入。
 * 未传入时回退到旧路径（无 PKCE），保持向后兼容。
 */
export async function handleOAuthCallback(
    provider: string,
    code: string,
    redirectUri: string,
    state?: string,
    codeVerifier?: string,
): Promise<OAuthCallbackResult> {
    if (!globalHandler) {
        throw new Error("OAuth handler 未初始化。请先创建 OmniAuth 实例。");
    }
    return globalHandler(provider, code, redirectUri, state, codeVerifier);
}

/**
 * 全局 initiateOAuth。发起授权流程，返回授权 URL + state + codeVerifier。
 */
export async function initiateOAuth(
    provider: string,
    redirectUri: string,
): Promise<OAuthInitiateResult> {
    if (!globalHandler) {
        throw new Error("OAuth handler 未初始化。请先创建 OmniAuth 实例。");
    }
    return globalHandler.initiateOAuth(provider, redirectUri);
}
