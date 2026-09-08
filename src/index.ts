// omni-auth — 框架无关认证工具库（root 极简面）
// ============================================================
// 8.0.0：root 只承载 happy-path 装配所需 —— createAuth/OmniAuth、
// 完整错误族，以及配置/公开方法签名引用的纯类型。
// 高级能力与运行时 helper 拆到明确子入口：
//   omni-auth/nextjs  Next.js 一站式（createQuickAuth + 会话 cookie）
//   omni-auth/schema  schema 同步（syncSchema）+ DSL + 表定义
//   omni-auth/oauth   外部 OAuth 登录（provider 工厂 + createOAuthHandler）
//   omni-auth/oauth-server  自建 OAuth 2.0 Authorization Server
//   omni-auth/scim    SCIM 2.0 目录管理面
//   omni-auth/request · omni-auth/adapters/pg · omni-auth/codegen-*
// ============================================================

export { createAuth, OmniAuth } from "./auth";

export type {
  OmniAuthConfig,
  OmniAuthRateLimitConfig,
  OmniAuthPasswordPolicy,
  OmniAuthVerificationPolicy,
  ChannelAuthIntent,
  ChannelAuthInput,
  ChannelAuthCredential,
  ChannelAuthResult,
} from "./auth";

// 错误（OmniAuthError 为基类，均带机器可读 code）
// isUniqueViolation 守卫：数据库唯一约束信号（code=UNIQUE_VIOLATION）不设专用类，
// 与宿主基础设施（yunzone-service-kit）的错误族避免同名不同类型陷阱
export {
  OmniAuthError,
  UnauthorizedError,
  InvalidPasswordError,
  SocialAccountConflictError,
  RateLimitedError,
  UserExistsError,
  WeakPasswordError,
  CredentialInvalidError,
  OAuthStateMismatchError,
  ChannelVerificationDisabledError,
  isUniqueViolation,
} from "./errors";

// ----------------------------------------------------------
// 配置 / 公开方法签名引用的纯类型（无运行时导出）
// ----------------------------------------------------------

export type { PublicUser } from "./types";

// 渠道绑定数据（ChannelAuthInput.channelData / bindToUser 输入的共享形状）
export type { ChannelBindingData } from "./social/types";

// 适配器接口（自定义 DatabaseAdapter / 配置 database 所需）
export type {
  DatabaseAdapter,
  WhereCondition,
  WhereOperator,
  SearchCondition,
  OrderByCondition,
} from "./adapters/database";
export type { RequestContext } from "./adapters/request";

// 令牌权威服务客户端（config.tokenAuthority）
export type { TokenAuthorityClient } from "./oauth/server";

// 社交账户 / Token 刷新（auth.social.* 返回、auth.registerTokenRefresher 参数）
export type { SocialAccountDTO } from "./social/types";
export type {
  TokenRefresher,
  TokenRefreshResult,
  SocialAccountRef,
} from "./social/token";

// 外部 OAuth provider 契约（auth.registerOAuthProvider / handleOAuthCallback）
export type { OAuthProviderConfig, OAuthCallbackResult } from "./oauth/types";

// 验证码委托（auth.registerVerificationSender / registerVerificationVerifier）
export type { VerificationSender, VerificationVerifier } from "./core/verification-channel";

// 生命周期钩子（config.hooks）
export type { LifecycleHooks, UserCreatedPayload } from "./core/lifecycle";

// 审计（config.audit）
export type { AuditEvent, AuditAction, AuditHandler } from "./core/audit";

// 速率限制（config.rateLimit）
export type { RateLimiter, RateLimitResult } from "./core/rateLimit";
