// ============================================================
// Google OAuth Provider
//
// 使用方式：
//   auth.registerOAuthProvider(createGoogleProvider({
//     clientId: process.env.GOOGLE_CLIENT_ID!,
//     clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
//   }));
// ============================================================

import type { OAuthProviderConfig } from "../types";

export interface GoogleProviderConfig {
  clientId: string;
  clientSecret: string;
}

export function createGoogleProvider(
  config: GoogleProviderConfig
): OAuthProviderConfig {
  return {
    provider: "google",

    async exchangeCode(code: string, redirectUri: string) {
      // 1. 用 code 换取 access_token
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        throw new Error(`Google token 换取失败 (${tokenRes.status}): ${errText}`);
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
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        }
      );

      if (!userRes.ok) {
        const errText = await userRes.text();
        throw new Error(`Google 用户信息获取失败 (${userRes.status}): ${errText}`);
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
