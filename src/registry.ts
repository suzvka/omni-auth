// ============================================================
// OmniRegistry — 实例级注册表容器
//
// 3.0.0 起，OAuth provider / 验证码 sender/verifier / token
// refresher / 审计处理器全部收编为 OmniAuth 实例成员，
// 多实例互不干扰。8.0.0 已移除模块级全局注册函数。
// ============================================================

import type { OAuthProviderConfig } from "./oauth/types";
import type { VerificationSender, VerificationVerifier } from "./core/verification-channel";
import type { TokenRefresher } from "./social/token";
import type { AuditHandler } from "./core/audit";

/** 单个 OmniAuth 实例持有的全部可扩展注册表 */
export interface OmniRegistry {
  /** OAuth provider 配置 */
  oauthProviders: Map<string, OAuthProviderConfig>;
  /** 验证码投递器 */
  senders: Map<string, VerificationSender>;
  /** 验证码验证器 */
  verifiers: Map<string, VerificationVerifier>;
  /** 社交 token 刷新器 */
  tokenRefreshers: Map<string, TokenRefresher>;
  /** 审计事件处理器 */
  auditHandler: AuditHandler | null;
}

export function createRegistry(): OmniRegistry {
  return {
    oauthProviders: new Map(),
    senders: new Map(),
    verifiers: new Map(),
    tokenRefreshers: new Map(),
    auditHandler: null,
  };
}
