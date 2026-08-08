// ============================================================
// Token 刷新策略注册表
// ============================================================

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

const refreshers = new Map<string, TokenRefresher>();

export function registerTokenRefresher(
  provider: string,
  refresher: TokenRefresher
): void {
  refreshers.set(provider, refresher);
}

export function getTokenRefresher(
  provider: string
): TokenRefresher | undefined {
  return refreshers.get(provider);
}

export function clearTokenRefreshers(): void {
  refreshers.clear();
}
