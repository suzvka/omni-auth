import { headers } from "next/headers";
import { NextResponse } from "next/server";
import type { OmniAuth } from "../auth";
import type { RequestContext } from "../adapters/request";
import type { AuthContext } from "../types";
import { createRequestContext } from "../adapters/request";
import { createAuth } from "../auth";
import { setAccountResolver } from "../core/resolver";
import { PgAdapter } from "../builtin/pg/adapter";
import type { AccountResolver } from "../core/resolver";
import type { DatabaseAdapter } from "../adapters/database";
import type { LifecycleHooks } from "../core/lifecycle";
import type { RoleResolver } from "../core/roles";
import type { PgAdapterOptions } from "../builtin/pg/adapter";

// ============================================================
// 统一导出：所有常用类型只需从 omni-auth/nextjs 导入
// ============================================================

export { createRequestContext };

// 核心类型
export type { AuthContext, Account, SocialAccountBrief } from "../types";
export type { AccountResolver } from "../core/resolver";
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
// createRouteHelpers — 消除 Route boilerplate
// ============================================================

export interface NextjsRouteHelpers {
  /** 获取当前用户上下文（未登录也返回，authUserId 为 null） */
  getContext(): Promise<AuthContext>;
  /** 获取当前用户上下文（未登录抛 UnauthorizedError） */
  requireContext(): Promise<AuthContext>;
}

/**
 * 创建预绑定 Next.js headers 的路由辅助函数。
 *
 * 将原来 5 行 boilerplate：
 * ```ts
 * import { auth } from "@/lib/auth";
 * import { nextjsRequestContext } from "omni-auth/nextjs";
 * import { headers } from "next/headers";
 * const ctx = await auth.requireContext(nextjsRequestContext(await headers()));
 * ```
 *
 * 缩减为 2 行：
 * ```ts
 * import { routeHelpers } from "@/lib/auth";
 * const { authUserId } = await routeHelpers.requireContext();
 * ```
 */
export function createRouteHelpers(auth: OmniAuth): NextjsRouteHelpers {
  return {
    async getContext(): Promise<AuthContext> {
      return auth.getContext(nextjsRequestContext(await headers()));
    },
    async requireContext(): Promise<AuthContext> {
      return auth.requireContext(nextjsRequestContext(await headers()));
    },
  };
}

// 重新导出 middleware（兼容 import from "omni-auth/nextjs"，仅限 Node.js Runtime）
export { createMiddleware } from "./middleware";
export type { MiddlewareConfig } from "./middleware";

// ============================================================
// oauthCookieResponse — OAuth 回调 Cookie 管理
// ============================================================

interface OAuthResult { token: string | null; userId: string; isNewUser: boolean }

/**
 * 创建带有 AuthToken cookie 的 OAuth 回调响应。
 *
 * token 明文仅通过 omni-auth.token cookie 返回（数据库只存哈希）。
 * auth 参数保留以维持 API 兼容性。
 */
export function oauthCookieResponse(
  auth: OmniAuth,
  result: OAuthResult,
  body?: Record<string, unknown>
): NextResponse {
  const response = NextResponse.json({
    success: true,
    userId: result.userId,
    isNewUser: result.isNewUser,
    ...body,
  });

  if (result.token) {
    response.cookies.set("omni-auth.token", result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7, // 7 天
      path: "/",
    });
  }

  return response;
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
  /** 密钥 */
  secret: string;
  /** 应用基础 URL */
  baseUrl: string;
  /** Token 配置 */
  token?: {
    expiresIn?: number;
  };
  /** 自定义业务账户解析器（不设置则 authContext.account 为 null） */
  accountResolver?: AccountResolver;
  /** 角色解析器（提供则 getContext 自动填充 roles） */
  roleResolver?: RoleResolver;
  /** 生命周期钩子 */
  hooks?: LifecycleHooks;
}

/**
 * 一站式初始化认证 SDK。
 *
 * 自动处理：数据库适配器连接、
 * 账户解析器注册、角色解析器注册。
 *
 * @example
 * ```ts
 * import { createQuickAuth } from "omni-auth/nextjs";
 *
 * export const auth = createQuickAuth({
 *   database: { url: process.env.DATABASE_URL },
 *   secret: process.env.BETTER_AUTH_SECRET!,
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
  if (config.accountResolver) {
    setAccountResolver(config.accountResolver);
  }

  return createAuth({
    database,
    secret: config.secret,
    baseUrl: config.baseUrl,
    token: config.token,
    accountResolver: config.accountResolver,
    roleResolver: config.roleResolver,
    hooks: config.hooks,
  });
}
