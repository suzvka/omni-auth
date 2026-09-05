// ============================================================
// OmniRegistry — 实例级注册表容器
//
// 3.0.0 起，OAuth provider / 验证码 sender/verifier / token
// refresher / 审计处理器全部收编为 OmniAuth 实例成员，
// 多实例互不干扰。
//
// 模块级全局注册函数（已弃用）通过 getActiveRegistry()
// 转发到最近创建的实例注册表，仅作过渡兼容。
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

/** 最近创建的注册表（弃用全局函数的兼容转发目标） */
let activeRegistry: OmniRegistry | null = null;

/** 全局弃用警告（仅提示一次） */
let deprecationWarned = false;

export function createRegistry(): OmniRegistry {
  const registry: OmniRegistry = {
    oauthProviders: new Map(),
    senders: new Map(),
    verifiers: new Map(),
    tokenRefreshers: new Map(),
    auditHandler: null,
  };
  activeRegistry = registry;
  return registry;
}

/** 兼容层：获取最近创建的实例注册表（无实例时为 null） */
export function getActiveRegistry(): OmniRegistry | null {
  return activeRegistry;
}

/** 兼容层：弃用全局函数统一经由此入口访问活跃注册表 */
export function requireActiveRegistry(caller: string): OmniRegistry {
  if (!activeRegistry) {
    throw new Error(
      `${caller}: 尚未创建 OmniAuth 实例。请先调用 createAuth()，或改用实例方法。`
    );
  }
  if (!deprecationWarned) {
    deprecationWarned = true;
    console.warn(
      `[omni-auth] 模块级全局注册函数已弃用（调用方: ${caller}），请改用 OmniAuth 实例方法，将在下个 major 版本移除。`
    );
  }
  return activeRegistry;
}
