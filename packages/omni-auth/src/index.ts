// omni-auth — 框架无关认证 SDK
// ============================================================

export { createAuth, OmniAuth } from "./auth";

/** @deprecated 0.6.0 起更名为 OmniAuth，此别名仅作过渡，后续版本将移除 */
export { OmniAuth as ChangfengAuth } from "./auth";

export type {
  OmniAuthConfig,
  OmniAuthRateLimitConfig,
  OmniAuthPasswordPolicy,
  SignUpInput,
  SignUpResult,
  SignInInput,
  SignInResult,
  ChannelAuthInput,
  ChannelAuthResult,
} from "./auth";

/** @deprecated 0.6.0 起更名为 OmniAuthConfig，此别名仅作过渡，后续版本将移除 */
export type { OmniAuthConfig as ChangfengAuthConfig } from "./auth";

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
  isUniqueViolation,
} from "./errors";

// 类型
export type { PublicUser } from "./types";

// 适配器接口
export type { DatabaseAdapter, WhereCondition, WhereOperator, SearchCondition, OrderByCondition } from "./adapters/database";
export { withTransaction } from "./adapters/database";
export type { RequestContext } from "./adapters/request";
export { createRequestContext, getClientIp } from "./adapters/request";
export type { ClientIpOptions } from "./adapters/request";

// 类型化数据访问（typed 门面）
export type {
  UserRow,
  SocialAccountRow,
  SessionRow,
  OAuthTokenRow,
  OAuthClientRow,
  ModelMap,
  ModelName,
  ModelWhere,
  ModelView,
  ModelCreateData,
  DbFacade,
} from "./models";

// Schema 同步（自动建表/迁移，认证域私有）
export { syncSchema } from "./schema-sync";
export type { SyncSchemaOptions, SyncSchemaResult } from "./schema-sync";

// 会话服务（认证域私有）
export { SESSION_TTL_MS, normalizeUserFlag } from "./core/session";
export type { SessionService, SessionRecord } from "./core/session";

// 用户管理（认证域私有）
export { normalizeEmail } from "./core/user-admin";
export type {
  UserAdminService,
  CreateUserParams,
  UpdateUserParams,
  UserView,
  UserListItem,
  ListUsersParams,
} from "./core/user-admin";

// OAuth Server（认证域私有）
export {
  OAuthError,
  invalidGrant,
  invalidClient,
  invalidRequest,
  unsupportedGrantType,
  invalidScope,
  SUPPORTED_SCOPES,
  DEFAULT_SCOPE,
  parseScope,
  negotiateScope,
  hasScope,
  verifyPKCE,
  generateCodeChallenge,
} from "./oauth/server";
export type {
  OAuthServerService,
  TokenAuthorityClient,
  TokenIssueResult,
  TokenIntrospectResult,
  OAuthClientListParams,
} from "./oauth/server";

// SCIM（认证域私有）
export { createScimUserHandler } from "./scim/handler";
export type { ScimUserHandler } from "./scim/handler";
export { USER_SCHEMA_ID, userSchema, allSchemas, getSchemaById } from "./scim/schemas";
export {
  ScimError,
  notFound,
  invalidValue,
  invalidSyntax,
  unauthorized,
  conflict,
  internalError,
  parsePagination,
  buildListResponse,
  parseFilter,
} from "./scim/types";
export type {
  ScimUser,
  ScimListResponse,
  ScimErrorResponse,
  ScimCreateUserRequest,
  ScimPatchRequest,
  ScimPatchOperation,
  ScimServiceProviderConfig,
  PaginationParams,
} from "./scim/types";

// Schema DSL（单一事实源：表结构定义）
export {
  table,
  text,
  boolean,
  integer,
  jsonb,
  timestamptz,
  timestamp,
  defineSchema,
  ColumnBuilder,
} from "./schema-builder";
export type {
  ColumnType,
  ColumnDef,
  TableDef,
  TableOptions,
  Schema,
  InferSelect,
  InferInsert,
} from "./schema-builder";

// Schema 定义（认证表 + 派生类型）
export { schema, user, socialAccount, session, oauthToken, oauthClient } from "./schema";
export type {
  UserInsert,
  SocialAccountInsert,
  SessionInsert,
  OAuthTokenInsert,
  OAuthClientInsert,
} from "./schema";

// Codegen（DDL + Prisma schema 生成）
export { generateDDL } from "./codegen-ddl";
export { generatePrismaSchema } from "./codegen-prisma";

// 内置适配器
export { PgAdapter } from "./builtin/pg/adapter";
export type { PgAdapterOptions, PgAdapterInstance } from "./builtin/pg/adapter";

// OAuth
export type { OAuthProviderConfig, OAuthCallbackResult } from "./oauth/types";
/** @deprecated 模块级全局注册函数，请改用 auth.registerOAuthProvider 实例方法 */
export { registerOAuthProvider, getOAuthProvider } from "./oauth";
export { createOAuthHandler } from "./oauth";
export type { OAuthHandler, OAuthInitiateResult, OAuthCallbackOptions } from "./oauth";

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
/** @deprecated 模块级全局注册函数，请改用 auth.registerTokenRefresher 实例方法 */
export { registerTokenRefresher, getTokenRefresher } from "./social/token";

// 渠道验证码（委托模式：sender 投递 + verifier 验证）
export type { VerificationSender, VerificationVerifier } from "./core/verification-channel";
/** @deprecated 模块级全局注册函数，请改用 auth.registerVerificationSender / registerVerificationVerifier 实例方法 */
export {
  registerVerificationSender,
  getVerificationSender,
  registerVerificationVerifier,
  getVerificationVerifier,
} from "./core/verification-channel";

// 生命周期钩子
export type { LifecycleHooks, UserCreatedPayload } from "./core/lifecycle";

// 账号管理

// RBAC
export { hasRole, hasAnyRole, requireRole, requireAnyRole } from "./core/roles";

// 速率限制
export type { RateLimiter, RateLimitResult, RateLimitConfig } from "./core/rateLimit";
export { createMemoryRateLimiter, checkRateLimit } from "./core/rateLimit";

// 审计日志
export type { AuditEvent, AuditAction, AuditHandler } from "./core/audit";
/** @deprecated 模块级全局函数，请改用 OmniAuthConfig.audit 或 auth.setAuditHandler */
export { setAuditHandler, getAuditHandler, publishAuditEvent } from "./core/audit";
export { extractAuditContext } from "./core/audit";

// CSRF 同源校验
export { isSameOrigin, createOriginCheck } from "./core/origin";

// 实例注册表
export type { OmniRegistry } from "./registry";
