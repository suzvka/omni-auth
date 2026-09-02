import { headers } from "next/headers";
import type { OmniAuth } from "../auth";
import type { RequestContext } from "../adapters/request";
import { createRequestContext } from "../adapters/request";
import { createAuth } from "../auth";
import { PgAdapter } from "../builtin/pg/adapter";
import type { PgPoolLike } from "../builtin/pg/adapter";
import type { DatabaseAdapter } from "../adapters/database";
import type { LifecycleHooks } from "../core/lifecycle";
import type { TokenAuthorityClient } from "../oauth/server";
import { syncSchema } from "../schema-sync";

// ============================================================
// 统一导出：所有常用类型只需从 omni-auth/nextjs 导入
// ============================================================

export { createRequestContext };

// 会话 cookie 辅助（认证域私有）
export {
  setSessionCookie,
  clearSessionCookie,
  getSessionTokenFromCookies,
  SESSION_COOKIE,
} from "./session";

// 核心类型
export type { PublicUser } from "../types";
export type { SocialAccountDTO } from "../social/types";
export type { TokenRefresher, TokenRefreshResult, SocialAccountRef } from "../social/token";
export type { OAuthProviderConfig, OAuthCallbackResult } from "../oauth/types";

// 错误类
export {
  UnauthorizedError,
  InvalidPasswordError,
  SocialAccountConflictError,
  UserExistsError,
  WeakPasswordError,
} from "../errors";

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

function isPoolDbConfig(cfg: DatabaseAdapter | PoolDbConfig): cfg is PoolDbConfig {
  return typeof cfg === "object" && cfg !== null && "pool" in cfg;
}

/**
 * 注入式数据库配置：宿主提供现成连接池。
 *
 * 连接池（含 SSL/max 等配置）由宿主创建与管理，SDK 只消费引用——
 * 认证域与宿主业务域共享同一连接池，避免双池。
 * 类型为最小结构形状（PgPoolLike），与宿主所用 pg 类型版本解耦。
 */
export interface PoolDbConfig {
  /** 宿主提供的现成连接池（必填） */
  pool: PgPoolLike;
}

export interface QuickAuthConfig {
  /**
   * 数据库适配器。
   *
   * **注入式配置（推荐）：**
   * ```ts
   * database: { pool: getPool() }
   * ```
   * SDK 基于注入的 pg 连接池执行参数化 SQL，零 ORM 依赖，
   * 连接池生命周期归宿主（单池共享）。
   *
   * **自定义适配器：**
   * 也可传入任意 DatabaseAdapter 实现。
   */
  database: DatabaseAdapter | PoolDbConfig;
  /**
   * 自动建表/迁移（默认 true）。
   *
   * pool 注入模式下，初始化时自动执行 schema 同步（幂等，
   * 建表/补列/驼峰列名修复）；false 时仅检查缺表并警告。
   * 环境变量 AUTO_SYNC_DB=false 可整体关闭（显式设置优先）。
   */
  autoSync?: boolean;
  /**
   * 目标库连接串（可选）。提供时自动建表前先执行库 bootstrap
   * （连 postgres 默认库检查/创建目标库）；缺省跳过 bootstrap。
   */
  databaseUrl?: string;
  /**
   * 令牌权威服务客户端（可选）。注入后 auth.oauthServer 的
   * access token 签发/校验/吊销能力可用（委托外部证书服务）。
   */
  tokenAuthority?: TokenAuthorityClient;
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
  /** 密码策略（4.1.0；不配置时保持默认最短 6 位） */
  passwordPolicy?: import("../auth").OmniAuthPasswordPolicy;
}

/**
 * 一站式初始化认证 SDK。
 *
 * 自动处理：数据库适配器连接（基于宿主注入的连接池）。
 * 本 SDK 只负责凭证校验（用户是否存在 + 密码是否正确），
 * 不维护任何会话状态（会话由应用层自行管理）。
 *
 * @example
 * ```ts
 * import { createQuickAuth } from "omni-auth/nextjs";
 *
 * export const auth = createQuickAuth({
 *   database: { pool: getPool() },
 *   baseUrl: process.env.BETTER_AUTH_URL!,
 * });
 * ```
 */
export function createQuickAuth(config: QuickAuthConfig): OmniAuth {
  // === 解析 database 配置（统一为 DatabaseAdapter） ===

  let database: DatabaseAdapter;

  if (isPoolDbConfig(config.database)) {
    // 注入式配置：基于宿主提供的连接池
    database = PgAdapter({ pool: config.database.pool });

    // === 自动建表/迁移（幂等，认证域表结构由包内 schema 单一管理） ===
    // AUTO_SYNC_DB=false 整体关闭；显式 autoSync 优先于环境变量；
    // Next.js 构建期（page data 收集）跳过，避免构建环境无 DB 凭证时阻断
    const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
    const envAutoSync = process.env.AUTO_SYNC_DB !== "false";
    const autoSync = config.autoSync ?? envAutoSync;
    if (!isBuildPhase) {
      void syncSchema(config.database.pool, {
        databaseUrl: config.databaseUrl,
        autoSync,
      })
        .then((result) => {
          if (!result.synced && result.missingTables.length > 0) {
            console.warn(
              `[omni-auth] 缺少表: ${result.missingTables.join(", ")}。` +
                `请运行 npx omni-auth db:push 或设置 AUTO_SYNC_DB=true。`
            );
          }
        })
        .catch((err) => {
          console.error(
            `[omni-auth] Schema 同步失败: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    }
  } else {
    database = config.database;
  }

  return createAuth({
    database,
    tokenAuthority: config.tokenAuthority,
    secret: config.secret,
    baseUrl: config.baseUrl,
    hooks: config.hooks,
    audit: config.audit,
    rateLimit: config.rateLimit,
    passwordPolicy: config.passwordPolicy,
  });
}
