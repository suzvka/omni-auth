// ============================================================
// OmniAuth 客户端 — 纯 fetch 封装
//
// 无 better-auth/react 依赖。
// signIn / signUp / signOut / getContext / forgetPassword / resetPassword
// 走 app 自有 API 路由。
// useSession 基于 GET /api/me 的简单 React hook。
// ============================================================

import { useState, useEffect } from "react";
import type { AuthContext, Account } from "./types";

// ----------------------------------------------------------
// 类型定义
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

/** /api/me 返回的会话数据（与 AuthContext 一致） */
export interface SessionData {
  account: Account | null;
  authUserId: string | null;
  roles: string[];
  channels: unknown[];
  socialAccounts: unknown[];
  tokenMetadata?: Record<string, unknown>;
}

/** useSession hook 返回值 */
export interface UseSessionResult {
  data: SessionData | null;
  loading: boolean;
  error: Error | null;
}

export interface OmniClient {
  /** React hook：获取当前 session */
  useSession: () => UseSessionResult;
  /** 邮箱登录 */
  signIn: (params: SignInParams) => Promise<void>;
  /** 邮箱注册 */
  signUp: (params: SignUpParams) => Promise<void>;
  /** 登出 */
  signOut: () => Promise<void>;
  /** 获取完整认证上下文（含 roles, socialAccounts） */
  getContext: () => Promise<AuthContext>;
  /** 忘记密码（发送重置验证码到指定渠道） */
  forgetPassword: (provider: string, providerOpenid: string) => Promise<void>;
  /** 重置密码（使用验证码） */
  resetPassword: (provider: string, providerOpenid: string, code: string, newPassword: string) => Promise<void>;
}

// ----------------------------------------------------------
// 客户端工厂
// ----------------------------------------------------------

export function createOmniClient(baseURL?: string): OmniClient {
  const base = baseURL ?? "";

  /**
   * React hook：从 GET /api/me 获取当前会话。
   * 仅在组件挂载时请求一次，支持取消清理。
   */
  function useSession(): UseSessionResult {
    const [data, setData] = useState<SessionData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
      let cancelled = false;
      fetch(`${base}/api/me`)
        .then(async (res) => {
          if (res.ok) return res.json();
          if (res.status === 401) return null;  // 未登录 — 正常
          throw new Error(`服务器错误: ${res.status}`);  // 5xx — 进入 catch
        })
        .then((json: unknown) => {
          if (cancelled) return;
          setData(json as SessionData | null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, []);

    return { data, loading, error };
  }

  return {
    useSession,

    async signIn({ email, password }: SignInParams): Promise<void> {
      const res = await fetch(`${base}/api/auth/sign-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `登录失败: ${res.status}`);
      }
    },

    async signUp({ email, password, name }: SignUpParams): Promise<void> {
      const res = await fetch(`${base}/api/auth/sign-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `注册失败: ${res.status}`);
      }
    },

    async signOut(): Promise<void> {
      const res = await fetch(`${base}/api/auth/sign-out`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `登出失败: ${res.status}`);
      }
    },

    async getContext(): Promise<AuthContext> {
      const res = await fetch(`${base}/api/me`);
      if (!res.ok) {
        throw new Error(`获取用户上下文失败: ${res.status}`);
      }
      return res.json() as Promise<AuthContext>;
    },

    async forgetPassword(provider: string, providerOpenid: string): Promise<void> {
      const res = await fetch(`${base}/api/auth/forget-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, providerOpenid }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `请求重置密码失败: ${res.status}`);
      }
    },

    async resetPassword(provider: string, providerOpenid: string, code: string, newPassword: string): Promise<void> {
      const res = await fetch(`${base}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, providerOpenid, code, newPassword }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `重置密码失败: ${res.status}`);
      }
    },
  };
}
