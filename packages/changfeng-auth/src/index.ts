// changfeng-auth — 框架无关认证 SDK
// ============================================================

export { createAuth, ChangfengAuth } from "./auth";
export type {
  ChangfengAuthConfig,
  SignUpInput,
  SignUpResult,
  SignInInput,
  SignInResult,
  ChannelAuthInput,
  ChannelAuthResult,
  SignUpWithSocialInput,
} from "./auth";

// 错误
export { UnauthorizedError, InvalidPasswordError, SocialAccountConflictError } from "./errors";

// 类型
export type { AuthContext, Account, PublicUser, SocialAccountBrief, UserChannel } from "./types";
export type { AccountResolver } from "./core/resolver";
export { setAccountResolver, getAccountResolver } from "./core/resolver";

// 适配器接口
export type { DatabaseAdapter, WhereCondition, WhereOperator, SearchCondition, OrderByCondition } from "./adapters/database";
export type { RequestContext } from "./adapters/request";
export { createRequestContext } from "./adapters/request";

// 内置适配器
export { PgAdapter } from "./builtin/pg/adapter";
export type { PgAdapterOptions, PgAdapterInstance } from "./builtin/pg/adapter";

// OAuth
export type { OAuthProviderConfig, OAuthCallbackResult } from "./oauth/types";
export { registerOAuthProvider, getOAuthProvider, handleOAuthCallback } from "./oauth";

// 内置 OAuth Provider
export { createGoogleProvider } from "./oauth/providers/google";
export type { GoogleProviderConfig } from "./oauth/providers/google";
export { createGitHubProvider } from "./oauth/providers/github";
export type { GitHubProviderConfig } from "./oauth/providers/github";
export { createWechatProvider } from "./oauth/providers/wechat";
export type { WechatProviderConfig } from "./oauth/providers/wechat";

// 社交账户
export type { SocialAccountDTO } from "./social/types";
export type { TokenRefresher, TokenRefreshResult, SocialAccountRef } from "./social/token";
export { registerTokenRefresher, getTokenRefresher } from "./social/token";

// 渠道验证码
export type { VerificationSender } from "./core/verification-channel";
export { registerVerificationSender, getVerificationSender } from "./core/verification-channel";

// 生命周期钩子
export type { LifecycleHooks, UserCreatedPayload, SessionCreatedPayload, SessionExpiredPayload } from "./core/lifecycle";

// Session 管理
export type { SessionInfo } from "./core/session";

// 账号管理
export type { UpdateProfileInput } from "./core/account";

// RBAC
export type { RoleResolver, DBApi } from "./core/roles";
export { setRoleResolver, getRoleResolver, hasRole, hasAnyRole, requireRole, requireAnyRole } from "./core/roles";

// 速率限制
export type { RateLimiter, RateLimitResult, RateLimitConfig } from "./core/rateLimit";
export { createMemoryRateLimiter, checkRateLimit } from "./core/rateLimit";

// 审计日志
export type { AuditEvent, AuditAction, AuditHandler } from "./core/audit";
export { setAuditHandler, getAuditHandler, publishAuditEvent, extractAuditContext } from "./core/audit";

// 通道映射工具
export {
  phoneToSyntheticEmail,
  isSyntheticEmail,
  syntheticEmailToPhone,
  generateRandomPassword,
  isChannelProvider,
  SYNTHETIC_EMAIL_DOMAIN,
} from "./core/channel-mapping";
export type { ChannelProvider } from "./core/channel-mapping";
