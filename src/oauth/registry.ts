// ============================================================
// OAuth Provider 注册表
//
// 3.0.0 起注册表收编为 OmniAuth 实例成员（OmniRegistry），
// 模块级全局注册函数已弃用，仅转发到最近创建的实例。
// ============================================================

import type { OAuthProviderConfig } from "./types";
import { requireActiveRegistry } from "../registry";

/** @deprecated 使用 OmniAuth 实例方法 registerOAuthProvider 替代 */
export function registerOAuthProvider(config: OAuthProviderConfig): void {
  requireActiveRegistry("registerOAuthProvider").oauthProviders.set(config.provider, config);
}

/** @deprecated 使用 OmniAuth 实例注册表替代 */
export function getOAuthProvider(
  provider: string
): OAuthProviderConfig | undefined {
  return requireActiveRegistry("getOAuthProvider").oauthProviders.get(provider);
}

/** @deprecated 实例注册表随实例生命周期管理，无需手动清理 */
export function clearOAuthProviders(): void {
  requireActiveRegistry("clearOAuthProviders").oauthProviders.clear();
}
