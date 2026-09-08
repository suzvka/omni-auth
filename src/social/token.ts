// ============================================================
// Token 刷新策略类型
//
// 3.0.0 起注册表收编为 OmniAuth 实例成员（OmniRegistry）；
// 8.0.0 移除已弃用的模块级全局注册函数。
// ============================================================

export interface SocialAccountRef {
  id: string;
  provider: string;
  /** 8.0.0 由 providerOpenid 更名 */
  identifier: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  profileData: Record<string, unknown>;
}

export interface TokenRefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export type TokenRefresher = (
  socialAccount: SocialAccountRef
) => Promise<TokenRefreshResult>;
