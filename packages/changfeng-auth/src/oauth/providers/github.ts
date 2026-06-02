// ============================================================
// GitHub OAuth Provider
//
// 使用方式：
//   auth.registerOAuthProvider(createGitHubProvider({
//     clientId: process.env.GITHUB_CLIENT_ID!,
//     clientSecret: process.env.GITHUB_CLIENT_SECRET!,
//   }));
// ============================================================

import type { OAuthProviderConfig } from "../types";

export interface GitHubProviderConfig {
  clientId: string;
  clientSecret: string;
}

export function createGitHubProvider(
  config: GitHubProviderConfig
): OAuthProviderConfig {
  return {
    provider: "github",

    async exchangeCode(code: string, redirectUri: string) {
      // 1. 用 code 换取 access_token
      const tokenRes = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        }
      );

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        throw new Error(`GitHub token 换取失败 (${tokenRes.status}): ${errText}`);
      }

      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        error?: string;
        error_description?: string;
      };

      if (tokenData.error) {
        throw new Error(
          `GitHub token 换取失败: ${tokenData.error_description ?? tokenData.error}`
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
        throw new Error(`GitHub 用户信息获取失败 (${userRes.status}): ${errText}`);
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
          const emailRes = await fetch("https://api.github.com/user/emails", {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              Accept: "application/vnd.github.v3+json",
            },
          });
          if (emailRes.ok) {
            const emails = (await emailRes.json()) as {
              email: string;
              primary: boolean;
              verified: boolean;
            }[];
            const primary = emails.find((e) => e.primary && e.verified);
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
