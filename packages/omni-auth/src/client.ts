// ============================================================
// OmniAuth 客户端 — 纯 fetch 封装
//
// 无 better-auth/react 依赖。
// signIn / signUp / forgetPassword / resetPassword
// 走 app 自有 API 路由。
// 不维护会话：登录/注册成功后由调用方自行管理后续状态。
// ============================================================

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

export interface OmniClient {
  /** 邮箱登录（凭证校验） */
  signIn: (params: SignInParams) => Promise<void>;
  /** 邮箱注册 */
  signUp: (params: SignUpParams) => Promise<void>;
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

  return {
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
