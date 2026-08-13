import { headers } from "next/headers";
import type { OmniAuth } from "../auth";
import type { RequestContext } from "../adapters/request";
import { createRequestContext } from "../adapters/request";
import { createAuth } from "../auth";
import { PgAdapter } from "../builtin/pg/adapter";
import type { DatabaseAdapter } from "../adapters/database";
import type { LifecycleHooks } from "../core/lifecycle";
import type { PgAdapterOptions } from "../builtin/pg/adapter";

// ============================================================
// 统一导出：所有常用类型只需从 omni-auth/nextjs 导入
// ============================================================

export { createRequestContext };

// 核心类型
export type { PublicUser } from "../types";
export type { SocialAccountDTO } from "../social/types";
export type { TokenRefresher, TokenRefreshResult, SocialAccountRef } from "../social/token";
export type { OAuthProviderConfig, OAuthCallbackResult } from "../oauth/types";

// 错误类
export { UnauthorizedError, InvalidPasswordError, SocialAccountConflictError } from "../errors";

/** 从 Next.js headers() 构建 RequestContext */
export function nextjsRequestContext(
  hdrs: Awaited<ReturnType<typeof headers>>
): RequestContext {
  const raw: Record<string, string> = {};
  if (hdrs && typeof (hdrs as unknown as { forEach: unknown }).forEach === "function") {
    (hdrs as unknown as { forEach: (fn: (value: string, key: string) => void) => void }).forEach(
      (value, key) => {
        raw[key.toLowerCase()] = value;
      }
    );
  }
  return createRequestContext(raw);
}

// ============================================================
// createQuickAuth — 一站式初始化工厂
// ============================================================

function isDeclarativeDbConfig(cfg: DatabaseAdapter | DeclarativeDbConfig): cfg is DeclarativeDbConfig {
  return typeof cfg === "object" && cfg !== null && "url" in cfg;
}

/** 声明式数据库配置 */
export interface DeclarativeDbConfig {
  /** PostgreSQL 连接 URL（必填） */
  url: string;
  /** TLS/SSL 配置（Neon、Supabase 等云数据库通常要求启用） */
  ssl?: PgAdapterOptions["ssl"];
  /** 连接池配置（可选） */
  pool?: {
    max?: number;
    idleTimeoutMs?: number;
  };
}

export interface QuickAuthConfig {
  /**
   * 数据库适配器。
   *
   * **声明式配置（推荐）：**
   * ```ts
   * database: { url: process.env.DATABASE_URL }
   * ```
   * SDK 内置 pg 驱动，零 ORM 依赖。
   *
   * **自定义适配器：**
   * 也可传入任意 DatabaseAdapter 实现。
   */
  database: DatabaseAdapter | DeclarativeDbConfig;
  /**
   * 密钥（可选）。
   *
   * 当前版本库内无消费方，为后续会话/令牌签名能力预留。
   */
  secret?: string;
  /** 应用基础 URL（CSRF 同源校验等使用） */
  baseUrl: string;
  /** 生命周期钩子 */
  hooks?: LifecycleHooks;
  /** 审计事件处理器（实例级） */
  audit?: import("../core/audit").AuditHandler;
  /** 速率限制配置 */
  rateLimit?: import("../auth").OmniAuthRateLimitConfig;
}

/**
 * 一站式初始化认证 SDK。
 *
 * 自动处理：数据库适配器连接。
 * 本 SDK 只负责凭证校验（用户是否存在 + 密码是否正确），
 * 不维护任何会话状态（会话由应用层自行管理）。
 *
 * @example
 * ```ts
 * import { createQuickAuth } from "omni-auth/nextjs";
 *
 * export const auth = createQuickAuth({
 *   database: { url: process.env.DATABASE_URL },
 *   baseUrl: process.env.BETTER_AUTH_URL!,
 * });
 * ```
 */
export function createQuickAuth(config: QuickAuthConfig): OmniAuth {
  // === 解析 database 配置（统一为 DatabaseAdapter） ===

  let database: DatabaseAdapter;

  if (isDeclarativeDbConfig(config.database)) {
    // 声明式配置：内置 pg 驱动
    console.log("[omni-auth] 使用内置 PgAdapter（声明式配置）");
    database = PgAdapter(config.database);
  } else {
    database = config.database;
  }

  return createAuth({
    database,
    secret: config.secret,
    baseUrl: config.baseUrl,
    hooks: config.hooks,
    audit: config.audit,
    rateLimit: config.rateLimit,
  });
}
