// ============================================================
// Google OAuth Provider
//
// 使用方式：
//   auth.registerOAuthProvider(createGoogleProvider({
//     clientId: process.env.GOOGLE_CLIENT_ID!,
//     clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
//   }));
//
// M3: 实现 getOAuthConfig + getUserInfo，走 @better-auth/core/oauth2
// 的 validateAuthorizationCode 路径，支持 state/PKCE。
// ============================================================

import type { OAuth2Tokens } from "@better-auth/core/oauth2";
import type { OAuthProviderConfig } from "../types";

export interface GoogleProviderConfig {
    clientId: string;
    clientSecret: string;
}

export function createGoogleProvider(
    config: GoogleProviderConfig,
): OAuthProviderConfig {
    return {
        provider: "google",

        // ---- 标准 OAuth2 配置（供 @better-auth/core/oauth2 使用） ----

        getOAuthConfig() {
            return {
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
                tokenEndpoint: "https://oauth2.googleapis.com/token",
                scopes: ["openid", "email", "profile"],
            };
        },

        // ---- 用户信息获取（配合 validateAuthorizationCode） ----

        async getUserInfo(tokens: OAuth2Tokens) {
            const userRes = await fetch(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                {
                    headers: {
                        Authorization: `Bearer ${tokens.accessToken}`,
                    },
                },
            );

            if (!userRes.ok) {
                const errText = await userRes.text();
                throw new Error(
                    `Google 用户信息获取失败 (${userRes.status}): ${errText}`,
                );
            }

            const userData = (await userRes.json()) as {
                id: string;
                email: string;
                name: string;
                picture?: string;
                verified_email?: boolean;
            };

            return {
                openid: userData.id,
                email: userData.email,
                name: userData.name,
                profileData: {
                    picture: userData.picture,
                    verifiedEmail: userData.verified_email,
                },
            };
        },

        // ---- 兼容路径: exchangeCode（不支持 PKCE 的调用方使用） ----

        async exchangeCode(code: string, redirectUri: string, codeVerifier?: string) {
            // 1. 用 code 换取 access_token
            const body = new URLSearchParams({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                code,
                grant_type: "authorization_code",
                redirect_uri: redirectUri,
            });
            if (codeVerifier) {
                body.set("code_verifier", codeVerifier);
            }

            const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
            });

            if (!tokenRes.ok) {
                const errText = await tokenRes.text();
                throw new Error(
                    `Google token 换取失败 (${tokenRes.status}): ${errText}`,
                );
            }

            const tokenData = (await tokenRes.json()) as {
                access_token: string;
                refresh_token?: string;
                expires_in?: number;
                id_token?: string;
            };

            // 2. 获取用户信息
            const userRes = await fetch(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                {
                    headers: {
                        Authorization: `Bearer ${tokenData.access_token}`,
                    },
                },
            );

            if (!userRes.ok) {
                const errText = await userRes.text();
                throw new Error(
                    `Google 用户信息获取失败 (${userRes.status}): ${errText}`,
                );
            }

            const userData = (await userRes.json()) as {
                id: string;
                email: string;
                name: string;
                picture?: string;
                verified_email?: boolean;
            };

            return {
                openid: userData.id,
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                expiresAt: tokenData.expires_in
                    ? new Date(Date.now() + tokenData.expires_in * 1000)
                    : undefined,
                profileData: {
                    picture: userData.picture,
                    verifiedEmail: userData.verified_email,
                },
                email: userData.email,
                name: userData.name,
            };
        },
    };
}
