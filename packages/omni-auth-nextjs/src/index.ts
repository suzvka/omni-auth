import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { OmniAuth, RequestContext, AuthContext } from "omni-auth";
import {
  createRequestContext,
  createAuth,
  setAccountResolver,
  PgAdapter,
} from "omni-auth";
import type { AccountResolver, DatabaseAdapter, LifecycleHooks, RoleResolver } from "omni-auth";
import type { PgAdapterOptions } from "omni-auth";
import type { BetterAuthOptions } from "better-auth";
import { toBetterAuthAdapter } from "./adapter-bridge";

// ============================================================
// 统一导出：所有常用类型只需从 omni-auth-nextjs 导入
// ============================================================

export { createRequestContext };

// 核心类型
export type { AuthContext, Account, SocialAccountBrief } from "omni-auth";
export type { AccountResolver } from "omni-auth";
export type { SocialAccountDTO } from "omni-auth";
export type { TokenRefresher, TokenRefreshResult, SocialAccountRef } from "omni-auth";
export type { OAuthProviderConfig, OAuthCallbackResult } from "omni-auth";

// 错误类
export { UnauthorizedError, InvalidPasswordError, SocialAccountConflictError } from "omni-auth";

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

/** 创建 Next.js catch-all API 路由处理器 */
export function createRouteHandlers(auth: OmniAuth) {
  const handler = auth.getBetterAuthHandler();

  const wrapHandler = async (req: NextRequest): Promise<Response> => {
    try {
      return await handler(req);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const message = error.message || "Unknown auth handler error";
      console.error("[omni-auth createRouteHandlers]", error.name, message);

      const isProduction = process.env.NODE_ENV === "production";
      return NextResponse.json(
        { error: "AUTH_HANDLER_ERROR", message: isProduction ? "Internal Server Error" : message },
        { status: 500 },
      );
    }
  };

  return {
    GET: (req: NextRequest) => wrapHandler(req),
    POST: (req: NextRequest) => wrapHandler(req),
  };
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
 * import { nextjsRequestContext } from "omni-auth-nextjs";
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

// 重新导出 middleware（兼容 import from "omni-auth-nextjs"，仅限 Node.js Runtime）
// Edge Runtime 场景必须从 "omni-auth-nextjs/middleware" 导入：
// 主入口依赖链含 pg（Node 专用），Edge 打包器无法解析。
export { createMiddleware, createDefaultMiddleware, createEdgeMiddleware } from "./middleware";
export type { MiddlewareConfig, EdgeMiddlewareConfig } from "./middleware";

// ============================================================
// oauthCookieResponse — OAuth 回调 Cookie 管理
// ============================================================

interface OAuthResult { token: string | null; userId: string; isNewUser: boolean }

/**
 * 创建带有签名 session cookie 的 OAuth 回调响应。
 *
 * 核心修复：Better Auth 要求 session_token cookie 必须带有 HMAC 签名
 * （格式：`rawToken.base64urlSignature`），否则 getSession 无法读取会话。
 * 此方法内部调用 auth.signSessionToken() 完成签名，调用者无需了解
 * Better Auth 的签名细节，彻底消除抽象泄漏。
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
    const signedToken = auth.signSessionToken(result.token);
    response.cookies.set("better-auth.session_token", signedToken, {
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
  /**
   * Better Auth 原生数据库适配器（可选，高级用法）。
   *
   * 仅在以下场景手动设置：
   * - 使用非 Pg 的 DatabaseAdapter（如 DrizzleAdapter）
   * - 需要接管 better-auth 适配器的全部配置
   *
   * @see database — 主适配器配置
   */
  betterAuthDatabase?: BetterAuthOptions["database"];
  /** Better Auth 密钥 */
  secret: string;
  /** 应用基础 URL */
  baseUrl: string;
  /** Session 配置 */
  session?: {
    expiresIn?: number;
    updateAge?: number;
    rememberMeExpiresIn?: number;
  };
  /** 自定义业务账户解析器（不设置则 authContext.account 为 null） */
  accountResolver?: AccountResolver;
  /** 角色解析器（提供则 getContext 自动填充 roles） */
  roleResolver?: RoleResolver;
  /** Better Auth 插件列表 */
  plugins?: BetterAuthOptions["plugins"];
  /** 覆盖 Better Auth 配置 */
  overrides?: Partial<BetterAuthOptions>;
  /** 生命周期钩子 */
  hooks?: LifecycleHooks;
  /** 是否在创建 User 时自动创建 BusinessAccount，默认 true */
  autoCreateBusinessAccount?: boolean;
}

/**
 * 一站式初始化认证 SDK。
 *
 * 自动处理：数据库适配器连接、BusinessAccount 自动创建、
 * 账户解析器注册、角色解析器注册。
 *
 * @example
 * ```ts
 * import { createQuickAuth } from "omni-auth-nextjs";
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
    // v0.6.0 声明式配置：内置 pg 驱动
    console.log("[omni-auth] 使用内置 PgAdapter（声明式配置）");
    database = PgAdapter(config.database);
  } else {
    database = config.database;
  }
  if (config.accountResolver) {
    setAccountResolver(config.accountResolver);
  }

  // 构建 BusinessAccount 自动创建 hook
  const autoCreateHooks: Record<string, unknown> = {};
  if (config.autoCreateBusinessAccount !== false) {
    autoCreateHooks.user = {
      create: {
        after: async (user: { id: string; email?: string }) => {
          await database.create({
            model: "businessAccount",
            data: {
              authUserId: user.id,
              displayName: user.email ?? user.id,
              status: "active",
            },
          });
        },
      },
    };
  }

  // 合并用户 overrides 中的 databaseHooks
  const mergedOverrides: Record<string, unknown> = { ...config.overrides };
  if (Object.keys(autoCreateHooks).length > 0) {
    const overrideHooks = (config.overrides as Record<string, unknown> | undefined)
      ?.databaseHooks as Record<string, Record<string, Record<string, unknown>>> | undefined;

    if (overrideHooks) {
      // 深度合并：用户 hook 优先
      const merged: Record<string, unknown> = {};
      for (const model of ["user"]) {
        merged[model] = {
          ...((autoCreateHooks[model] as Record<string, Record<string, unknown>>) ?? {}),
          ...((overrideHooks[model] ?? {})),
        };
      }
      for (const [model, events] of Object.entries(overrideHooks)) {
        if (!merged[model]) {
          merged[model] = { ...events };
        } else {
          Object.assign(merged[model] as Record<string, unknown>, events);
        }
      }
      mergedOverrides.databaseHooks = merged;
    } else {
      mergedOverrides.databaseHooks = autoCreateHooks;
    }
  }

  // 设置 better-auth 兼容的数据库适配器
  // Priority:
  //   1. overrides.database — 用户显式设置，最高优先级
  //   2. betterAuthDatabase — 用户通过快捷字段设置
  //   3. database 回退 — PgAdapter 或其他 DatabaseAdapter 直接透传
  if (!mergedOverrides.database) {
    if (config.betterAuthDatabase) {
      mergedOverrides.database = config.betterAuthDatabase;
    } else {
      // v0.6.0: 桥接 DatabaseAdapter → Better Auth CustomAdapter
      // 解决方法名差异（update/delete vs updateOne/deleteOne）和 Where 运算符翻译
      //
      // 必须以函数形式传入：better-auth@1.6.26 的 full 模式（import { betterAuth } from
      // "better-auth"）中 getBaseAdapter 对 database 对象一律走 Kysely 路径
      // （createKyselyAdapter），CustomAdapter 对象会被判为 { kysely: null } 并抛出
      // "Failed to initialize database adapter"；只有函数形式会命中
      // `typeof database === "function"` 分支被直接调用。
      mergedOverrides.database = (() => toBetterAuthAdapter(database)) as never;
    }
  }

  return createAuth({
    database,
    secret: config.secret,
    baseUrl: config.baseUrl,
    session: config.session,
    roleResolver: config.roleResolver,
    plugins: config.plugins,
    overrides: mergedOverrides as Partial<BetterAuthOptions>,
    hooks: config.hooks,
  });
}
