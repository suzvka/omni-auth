// ============================================================
// OAuth Provider 注册表
// ============================================================

import type { OAuthProviderConfig } from "./types";

const providers = new Map<string, OAuthProviderConfig>();

export function registerOAuthProvider(config: OAuthProviderConfig): void {
  providers.set(config.provider, config);
}

export function getOAuthProvider(
  provider: string
): OAuthProviderConfig | undefined {
  return providers.get(provider);
}

export function clearOAuthProviders(): void {
  providers.clear();
}
