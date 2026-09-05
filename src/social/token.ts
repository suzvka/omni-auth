// ============================================================
// Token 刷新策略注册表
//
// 3.0.0 起注册表收编为 OmniAuth 实例成员（OmniRegistry），
// 模块级全局注册函数已弃用，仅转发到最近创建的实例。
// ============================================================

import { requireActiveRegistry } from "../registry";

export interface SocialAccountRef {
  id: string;
  provider: string;
  providerOpenid: string;
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

/** @deprecated 使用 OmniAuth 实例方法 registerTokenRefresher 替代 */
export function registerTokenRefresher(
  provider: string,
  refresher: TokenRefresher
): void {
  requireActiveRegistry("registerTokenRefresher").tokenRefreshers.set(provider, refresher);
}

/** @deprecated 使用 OmniAuth 实例注册表替代 */
export function getTokenRefresher(
  provider: string
): TokenRefresher | undefined {
  return requireActiveRegistry("getTokenRefresher").tokenRefreshers.get(provider);
}

/** @deprecated 实例注册表随实例生命周期管理，无需手动清理 */
export function clearTokenRefreshers(): void {
  requireActiveRegistry("clearTokenRefreshers").tokenRefreshers.clear();
}
