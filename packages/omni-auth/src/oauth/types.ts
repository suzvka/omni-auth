// ============================================================
// OAuth 回调抽象
//
// M3 阶段：扩展 OAuthProviderConfig 以支持 @better-auth/core/oauth2
// 的 state/PKCE 流程。标准 OAuth2 provider 实现 getOAuthConfig +
// getUserInfo 后由 handler 调用 validateAuthorizationCode；非标准
// provider（如微信）继续使用 exchangeCode 兼容路径。
// ============================================================

import type { OAuth2Tokens } from "@better-auth/core/oauth2";

export interface OAuthProviderConfig {
    /** 平台标识，如 "wechat", "google" */
    provider: string;

    /**
     * 标准 OAuth2 配置元数据（供 @better-auth/core/oauth2 使用）。
     *
     * 实现此方法的 provider 将走 validateAuthorizationCode 路径，
     * 自动获得 state/PKCE 支持。未实现的 provider 回退到 exchangeCode。
     */
    getOAuthConfig?(): {
        clientId: string;
        clientSecret: string;
        authorizationEndpoint: string;
        tokenEndpoint: string;
        scopes?: string[];
    };

    /**
     * 从 OAuth2 tokens 获取用户信息（配合 validateAuthorizationCode 使用）。
     *
     * handler 调用 validateAuthorizationCode 获得 OAuth2Tokens 后，
     * 再调用此方法获取 openid / email / name 等业务字段。
     */
    getUserInfo?(tokens: OAuth2Tokens): Promise<{
        openid: string;
        email?: string;
        name?: string;
        profileData?: Record<string, unknown>;
    }>;

    /**
     * 构建授权 URL（不支持 getOAuthConfig 的 provider 可自定义）。
     *
     * 非标准 OAuth2 provider（如微信）使用此方法构建授权 URL，
     * 参数名 / 端点可能与标准不同。
     */
    buildAuthorizationUrl?(params: {
        state: string;
        codeVerifier?: string;
        redirectUri: string;
    }): string;

    /**
     * 用 OAuth code 换取 access_token + openid + 用户信息。
     *
     * 兼容模式：不支持 getOAuthConfig/getUserInfo 的 provider 使用此方法。
     * codeVerifier 用于 PKCE（如 provider 支持）。
     */
    exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<{
        openid: string;
        accessToken: string;
        refreshToken?: string;
        expiresAt?: Date;
        profileData?: Record<string, unknown>;
        email?: string;
        name?: string;
    }>;
}

export interface OAuthCallbackResult {
    /** AuthToken 明文（用于设置 cookie，M3 起替代旧 session token） */
    token: string;
    /** 用户的 authUserId */
    userId: string;
    /** 是否为新注册用户 */
    isNewUser: boolean;
    /** 绑定的渠道信息 */
    channel: {
        id: string;
        provider: string;
        providerOpenid: string;
        valid: number;
        allowPasswordUpdate: number;
    };
}
