// ============================================================
// 微信开放平台 OAuth Provider
//
// 使用方式：
//   auth.registerOAuthProvider(createWechatProvider({
//     appId: process.env.WECHAT_APP_ID!,
//     appSecret: process.env.WECHAT_APP_SECRET!,
//   }));
//
// 文档：https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html
//
// 微信使用非标准 OAuth2（appid 而非 client_id、GET 而非 POST），
// 因此走 buildAuthorizationUrl + exchangeCode 兼容路径。
// 微信不支持 PKCE，codeVerifier 参数接受但忽略。
// ============================================================

import type { OAuthProviderConfig } from "../types";

export interface WechatProviderConfig {
    appId: string;
    appSecret: string;
}

export function createWechatProvider(
    config: WechatProviderConfig,
): OAuthProviderConfig {
    return {
        provider: "wechat",

        // ---- 自定义授权 URL 构建（微信非标准 OAuth2） ----

        buildAuthorizationUrl({ state, redirectUri }) {
            const url = new URL("https://open.weixin.qq.com/connect/qrconnect");
            url.searchParams.set("appid", config.appId);
            url.searchParams.set("redirect_uri", redirectUri);
            url.searchParams.set("response_type", "code");
            url.searchParams.set("scope", "snsapi_login");
            url.searchParams.set("state", state);
            // 微信不支持 PKCE，code_challenge 参数不传递
            return url.toString();
        },

        // ---- 兼容路径: exchangeCode ----

        async exchangeCode(
            code: string,
            _redirectUri: string,
            _codeVerifier?: string,
        ) {
            // 1. 用 code 换取 access_token + openid（微信用 GET + query params）
            const tokenUrl = new URL(
                "https://api.weixin.qq.com/sns/oauth2/access_token",
            );
            tokenUrl.searchParams.set("appid", config.appId);
            tokenUrl.searchParams.set("secret", config.appSecret);
            tokenUrl.searchParams.set("code", code);
            tokenUrl.searchParams.set("grant_type", "authorization_code");

            const tokenRes = await fetch(tokenUrl.toString());

            if (!tokenRes.ok) {
                const errText = await tokenRes.text();
                throw new Error(
                    `微信 token 换取失败 (${tokenRes.status}): ${errText}`,
                );
            }

            const tokenData = (await tokenRes.json()) as {
                access_token: string;
                expires_in?: number;
                refresh_token?: string;
                openid: string;
                scope?: string;
                errcode?: number;
                errmsg?: string;
            };

            if (tokenData.errcode) {
                throw new Error(
                    `微信 token 换取失败: [${tokenData.errcode}] ${tokenData.errmsg}`,
                );
            }

            // 2. 获取用户信息
            const userUrl = new URL(
                "https://api.weixin.qq.com/sns/userinfo",
            );
            userUrl.searchParams.set("access_token", tokenData.access_token);
            userUrl.searchParams.set("openid", tokenData.openid);
            userUrl.searchParams.set("lang", "zh_CN");

            const userRes = await fetch(userUrl.toString());

            if (!userRes.ok) {
                const errText = await userRes.text();
                throw new Error(
                    `微信用户信息获取失败 (${userRes.status}): ${errText}`,
                );
            }

            const userData = (await userRes.json()) as {
                openid: string;
                nickname: string;
                sex: number;
                province: string;
                city: string;
                country: string;
                headimgurl: string;
                unionid?: string;
                errcode?: number;
                errmsg?: string;
            };

            if (userData.errcode) {
                throw new Error(
                    `微信用户信息获取失败: [${userData.errcode}] ${userData.errmsg}`,
                );
            }

            return {
                openid: tokenData.openid,
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                expiresAt: tokenData.expires_in
                    ? new Date(Date.now() + tokenData.expires_in * 1000)
                    : undefined,
                profileData: {
                    nickname: userData.nickname,
                    sex: userData.sex,
                    province: userData.province,
                    city: userData.city,
                    country: userData.country,
                    headimgurl: userData.headimgurl,
                    unionid: userData.unionid,
                },
                // 微信不返回邮箱，使用占位符
                name: userData.nickname,
            };
        },
    };
}
