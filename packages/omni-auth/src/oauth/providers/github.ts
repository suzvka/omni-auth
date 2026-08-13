// ============================================================
// GitHub OAuth Provider
//
// 使用方式：
//   auth.registerOAuthProvider(createGitHubProvider({
//     clientId: process.env.GITHUB_CLIENT_ID!,
//     clientSecret: process.env.GITHUB_CLIENT_SECRET!,
//   }));
//
// 标准 OAuth2 路径：getOAuthConfig + getUserInfo，由 handler 经
// @better-auth/core/oauth2 完成 code 交换（含 state/PKCE）。
// ============================================================

import type { OAuth2Tokens } from "@better-auth/core/oauth2";
import type { OAuthProviderConfig } from "../types";

export interface GitHubProviderConfig {
    clientId: string;
    clientSecret: string;
}

export function createGitHubProvider(
    config: GitHubProviderConfig,
): OAuthProviderConfig {
    return {
        provider: "github",

        // ---- 标准 OAuth2 配置（供 @better-auth/core/oauth2 使用） ----

        getOAuthConfig() {
            return {
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                authorizationEndpoint: "https://github.com/login/oauth/authorize",
                tokenEndpoint: "https://github.com/login/oauth/access_token",
                scopes: ["user", "user:email"],
            };
        },

        // ---- 用户信息获取（配合 validateAuthorizationCode） ----

        async getUserInfo(tokens: OAuth2Tokens) {
            const accessToken = tokens.accessToken;
            if (!accessToken) {
                throw new Error("GitHub token 换取失败: access_token 为空");
            }

            const userRes = await fetch("https://api.github.com/user", {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github.v3+json",
                },
            });

            if (!userRes.ok) {
                const errText = await userRes.text();
                throw new Error(
                    `GitHub 用户信息获取失败 (${userRes.status}): ${errText}`,
                );
            }

            const userData = (await userRes.json()) as {
                id: number;
                login: string;
                name: string | null;
                email: string | null;
                avatar_url?: string;
            };

            // 如果 email 为空，单独获取（GitHub 可能要求 email scope）
            let email = userData.email;
            if (!email) {
                try {
                    const emailRes = await fetch(
                        "https://api.github.com/user/emails",
                        {
                            headers: {
                                Authorization: `Bearer ${accessToken}`,
                                Accept: "application/vnd.github.v3+json",
                            },
                        },
                    );
                    if (emailRes.ok) {
                        const emails = (await emailRes.json()) as {
                            email: string;
                            primary: boolean;
                            verified: boolean;
                        }[];
                        const primary = emails.find(
                            (e) => e.primary && e.verified,
                        );
                        if (primary) email = primary.email;
                    }
                } catch {
                    // 获取邮箱失败不阻断流程
                }
            }

            return {
                openid: String(userData.id),
                email: email ?? `${userData.login}@github.users`,
                name: userData.name ?? userData.login,
                profileData: {
                    login: userData.login,
                    avatarUrl: userData.avatar_url,
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
                redirect_uri: redirectUri,
            });
            if (codeVerifier) {
                body.set("code_verifier", codeVerifier);
            }

            const tokenRes = await fetch(
                "https://github.com/login/oauth/access_token",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        Accept: "application/json",
                    },
                    body,
                },
            );

            if (!tokenRes.ok) {
                const errText = await tokenRes.text();
                throw new Error(
                    `GitHub token 换取失败 (${tokenRes.status}): ${errText}`,
                );
            }

            const tokenData = (await tokenRes.json()) as {
                access_token: string;
                refresh_token?: string;
                error?: string;
                error_description?: string;
            };

            if (tokenData.error) {
                throw new Error(
                    `GitHub token 换取失败: ${tokenData.error_description ?? tokenData.error}`,
                );
            }

            // 2. 获取用户信息
            const userRes = await fetch("https://api.github.com/user", {
                headers: {
                    Authorization: `Bearer ${tokenData.access_token}`,
                    Accept: "application/vnd.github.v3+json",
                },
            });

            if (!userRes.ok) {
                const errText = await userRes.text();
                throw new Error(
                    `GitHub 用户信息获取失败 (${userRes.status}): ${errText}`,
                );
            }

            const userData = (await userRes.json()) as {
                id: number;
                login: string;
                name: string | null;
                email: string | null;
                avatar_url?: string;
            };

            // 3. 如果 email 为空，单独获取（GitHub 可能要求 email scope）
            let email = userData.email;
            if (!email) {
                try {
                    const emailRes = await fetch(
                        "https://api.github.com/user/emails",
                        {
                            headers: {
                                Authorization: `Bearer ${tokenData.access_token}`,
                                Accept: "application/vnd.github.v3+json",
                            },
                        },
                    );
                    if (emailRes.ok) {
                        const emails = (await emailRes.json()) as {
                            email: string;
                            primary: boolean;
                            verified: boolean;
                        }[];
                        const primary = emails.find(
                            (e) => e.primary && e.verified,
                        );
                        if (primary) email = primary.email;
                    }
                } catch {
                    // 获取邮箱失败不阻断流程
                }
            }

            return {
                openid: String(userData.id),
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                profileData: {
                    login: userData.login,
                    avatarUrl: userData.avatar_url,
                },
                email: email ?? `${userData.login}@github.users`,
                name: userData.name ?? userData.login,
            };
        },
    };
}
