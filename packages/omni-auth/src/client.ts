// ============================================================
// 前端 Client SDK
//
// 基于 Better Auth 客户端，提供开箱即用的 React hooks 
// 和简化 API。无需手写 fetch 调用。
//
// 使用方式：
//   import { createOmniClient } from "omni-auth/client";
//   const { signIn, signUp, signOut, useSession } = createOmniClient();
// ============================================================

import { createAuthClient } from "better-auth/react";
import type { AuthContext, SocialAccountBrief } from "./types";

// 重新导出 Better Auth 客户端（向后兼容）
export { createAuthClient };

// 重新导出常用类型
export type { Session } from "better-auth";

// ----------------------------------------------------------
// 高级客户端类型
// ----------------------------------------------------------

export interface SignInParams {
  email: string;
  password: string;
}

export interface SignUpParams {
  email: string;
  password: string;
  name: string;
}

export interface OmniClient {
  /** React hook：获取当前 session */
  useSession: ReturnType<typeof createAuthClient>["useSession"];
  /** 邮箱登录 */
  signIn: (params: SignInParams) => Promise<void>;
  /** 邮箱注册 */
  signUp: (params: SignUpParams) => Promise<void>;
  /** 登出 */
  signOut: () => Promise<void>;
  /** 获取完整认证上下文（含 roles, socialAccounts） */
  getContext: () => Promise<AuthContext>;
  /** 忘记密码 */
  forgetPassword: (email: string) => Promise<void>;
  /** 重置密码 */
  resetPassword: (token: string, newPassword: string) => Promise<void>;
  /** 底层 Better Auth client（高级用法） */
  _raw: ReturnType<typeof createAuthClient>;
}

export function createOmniClient(baseURL?: string): OmniClient {
  const authClient = createAuthClient(
    baseURL ? { baseURL } : undefined
  );

  return {
    useSession: authClient.useSession,

    async signIn({ email, password }: SignInParams): Promise<void> {
      await authClient.signIn.email({ email, password });
    },

    async signUp({ email, password, name }: SignUpParams): Promise<void> {
      await authClient.signUp.email({ email, password, name });
    },

    async signOut(): Promise<void> {
      await authClient.signOut();
    },

    async getContext(): Promise<AuthContext> {
      const res = await fetch("/api/me");
      if (!res.ok) {
        throw new Error(`获取用户上下文失败: ${res.status}`);
      }
      return res.json() as Promise<AuthContext>;
    },

    async forgetPassword(email: string): Promise<void> {
      // Better Auth client forgetPassword 在不同版本可能签名不同
      const client = authClient as unknown as { forgetPassword: (params: Record<string, unknown>) => Promise<unknown> };
      await client.forgetPassword({ email });
    },

    async resetPassword(token: string, newPassword: string): Promise<void> {
      const client = authClient as unknown as { resetPassword: (params: Record<string, unknown>) => Promise<unknown> };
      await client.resetPassword({ token, newPassword });
    },

    _raw: authClient,
  };
}
