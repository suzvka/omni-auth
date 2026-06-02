// ============================================================
// OAuth 回调处理逻辑
// ============================================================

import { randomUUID, randomBytes } from "crypto";
import { betterAuth } from "better-auth";
import type { DatabaseAdapter } from "../adapters/database";
import type { OAuthCallbackResult } from "./types";
import type { SignUpEmailResult, BetterAuthSession } from "../core/betterAuthTypes";
import { getOAuthProvider } from "./registry";

type BetterAuthInstance = ReturnType<typeof betterAuth>;

interface SocialServiceForOAuth {
  findByProvider(provider: string, providerOpenid: string): Promise<{ userId: string } | null>;
  bindToUser(userId: string, input: Record<string, unknown>): Promise<unknown>;
}

/** 为 OAuth 用户生成随机密码 */
function generateRandomPassword(): string {
  return randomBytes(32).toString("hex");
}

/** 生成平台邮箱占位符 */
function generatePlaceholderEmail(provider: string, openid: string): string {
  return `${provider}_${openid.substring(0, 12)}@oauth.usercenter`;
}

/**
 * OAuth 回调处理器工厂。
 * 接收 database adapter 和 better-auth 实例及 socialService，返回处理函数。
 */
export function createOAuthHandler(deps: {
  db: DatabaseAdapter;
  auth: BetterAuthInstance;
  socialService: SocialServiceForOAuth;
}) {
  const { db, auth, socialService } = deps;

  return async function handleOAuthCallback(
    provider: string,
    code: string,
    redirectUri: string
  ): Promise<OAuthCallbackResult> {
    const config = getOAuthProvider(provider);
    if (!config) {
      throw new Error(
        `未注册的 OAuth 平台: "${provider}"。请先调用 registerOAuthProvider。`
      );
    }

    // 1. 换取 token
    const exchanged = await config.exchangeCode(code, redirectUri);

    // 2. 查是否已有绑定
    const existingSocial = await socialService.findByProvider(
      provider,
      exchanged.openid
    );

    if (existingSocial) {
      // 已有绑定：直接创建 session
      const token = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 24 * 7 * 1000);

      await db.create({
        model: "session",
        data: {
          userId: existingSocial.userId,
          token,
          expiresAt,
        },
      });

      return {
        token,
        userId: existingSocial.userId,
        isNewUser: false,
      };
    }

    // 3. 新建用户 + 绑定
    const email =
      exchanged.email ?? generatePlaceholderEmail(provider, exchanged.openid);
    const name = exchanged.name ?? `${provider}_用户`;
    const password = generateRandomPassword();

    let signUpResult: SignUpEmailResult;
    try {
      signUpResult = await auth.api.signUpEmail({
        body: { email, password, name },
      }) as unknown as SignUpEmailResult;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OAuth 注册失败 (${provider}): ${message}`);
    }

    // 绑定社交账户
    await socialService.bindToUser(signUpResult.user.id, {
      provider,
      providerOpenid: exchanged.openid,
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      tokenExpiresAt: exchanged.expiresAt,
      profileData: exchanged.profileData,
    });

    return {
      token: signUpResult.token ?? "",
      userId: signUpResult.user.id,
      isNewUser: true,
    };
  };
}

// 默认全局 handler（向后兼容，由 ChangfengAuth 初始化时注入依赖）
let globalHandler: ReturnType<typeof createOAuthHandler> | null = null;

export function setOAuthHandler(handler: ReturnType<typeof createOAuthHandler>): void {
  globalHandler = handler;
}

export async function handleOAuthCallback(
  provider: string,
  code: string,
  redirectUri: string
): Promise<OAuthCallbackResult> {
  if (!globalHandler) {
    throw new Error("OAuth handler 未初始化。请先创建 ChangfengAuth 实例。");
  }
  return globalHandler(provider, code, redirectUri);
}
