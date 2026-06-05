import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { ChangfengAuth, RequestContext, AuthContext } from "changfeng-auth";
import {
  createRequestContext,
  createAuth,
  setAccountResolver,
} from "changfeng-auth";
import type { AccountResolver, DatabaseAdapter, LifecycleHooks, RoleResolver, CaptchaAdapter } from "changfeng-auth";
import type { BetterAuthOptions } from "better-auth";

// ============================================================
// 统一导出：所有常用类型只需从 changfeng-auth-nextjs 导入
// ============================================================

export { createRequestContext };

// 核心类型
export type { AuthContext, Account, SocialAccountBrief } from "changfeng-auth";
export type { AccountResolver } from "changfeng-auth";
export type { SocialAccountDTO } from "changfeng-auth";
export type { TokenRefresher, TokenRefreshResult, SocialAccountRef } from "changfeng-auth";
export type { OAuthProviderConfig, OAuthCallbackResult } from "changfeng-auth";

// 错误类
export { UnauthorizedError, InvalidPasswordError, SocialAccountConflictError } from "changfeng-auth";

/** 从 Next.js headers() 构建 RequestContext */
export function nextjsRequestContext(
  hdrs?: Awaited<ReturnType<typeof headers>>
): RequestContext {
  const raw = hdrs ?? (globalThis as Record<string, unknown>);
  return createRequestContext(raw as Record<string, string | string[] | undefined>);
}

/** 创建 Next.js catch-all API 路由处理器 */
export function createRouteHandlers(auth: ChangfengAuth) {
  const handler = auth.getBetterAuthHandler();

  const wrapHandler = async (req: NextRequest): Promise<Response> => {
    try {
      return await handler(req);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const message = error.message || "Unknown auth handler error";
      console.error("[changfeng-auth createRouteHandlers]", error.name, message);

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
 * import { nextjsRequestContext } from "changfeng-auth-nextjs";
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
export function createRouteHelpers(auth: ChangfengAuth): NextjsRouteHelpers {
  return {
    async getContext(): Promise<AuthContext> {
      return auth.getContext(nextjsRequestContext(await headers()));
    },
    async requireContext(): Promise<AuthContext> {
      return auth.requireContext(nextjsRequestContext(await headers()));
    },
  };
}

// 重新导出 middleware（兼容 import from "changfeng-auth-nextjs"）
export { createMiddleware, createDefaultMiddleware, createEdgeMiddleware } from "./middleware";
export type { MiddlewareConfig, EdgeMiddlewareConfig } from "./middleware";

// ============================================================
// oauthCookieResponse — OAuth 回调 Cookie 管理
// ============================================================

interface OAuthResult { token: string | null; userId: string; isNewUser: boolean }

/**
 * 创建带有 session cookie 的 OAuth 回调响应。
 * 自动设置 better-auth.session_token cookie，无需手写 cookie 设置逻辑。
 */
export function oauthCookieResponse(
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
    response.cookies.set("better-auth.session_token", result.token, {
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

export interface QuickAuthConfig {
  /** 数据库适配器（必填，通过 PrismaAdapter({ prisma }) 创建） */
  database: DatabaseAdapter;
  /**
   * Better Auth 原生数据库适配器（可选）。
   *
   * 由于 changfeng-auth 的自定义 DatabaseAdapter 与 Better Auth 原生
   * DBAdapter 接口不同，需要通过此字段注入 Better Auth 兼容的适配器。
   *
   * 不提供则回退使用 database（通过类型断言），但推荐显式注入以确保
   * 运行时兼容性。使用方式：
   *
   * ```ts
   * import { prismaAdapter } from "@better-auth/prisma-adapter";
   *
   * createQuickAuth({
   *   database: PrismaAdapter({ prisma }),
   *   betterAuthDatabase: prismaAdapter(prisma, { provider: "sqlite" }),
   *   // ...
   * });
   * ```
   *
   * @see overrides — 如果同时设置了 overrides.database，后者优先级更高
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
  /** 验证码适配器（不提供则不启用验证码校验） */
  captcha?: CaptchaAdapter;
  /** 是否在创建 User 时自动创建 BusinessAccount，默认 true */
  autoCreateBusinessAccount?: boolean;
}

/**
 * 一站式初始化认证 SDK。
 *
 * 自动处理：数据库适配器连接、BusinessAccount 自动创建、
 * 账户解析器注册、角色解析器注册。
 *
 * 注意：changfeng-auth 的 DatabaseAdapter 与 Better Auth 原生
 * DBAdapter 接口不同。推荐通过 betterAuthDatabase 显式注入
 * Better Auth 兼容的适配器（如 @better-auth/prisma-adapter）。
 *
 * @example
 * ```ts
 * import { PrismaAdapter } from "changfeng-auth/adapters/prisma";
 * import { prismaAdapter } from "@better-auth/prisma-adapter";
 * import { createQuickAuth } from "changfeng-auth-nextjs";
 *
 * export const auth = createQuickAuth({
 *   database: PrismaAdapter({ prisma }),
 *   betterAuthDatabase: prismaAdapter(prisma, { provider: "postgresql" }),
 *   secret: process.env.BETTER_AUTH_SECRET!,
 *   baseUrl: process.env.BETTER_AUTH_URL!,
 * });
 * ```
 */
export function createQuickAuth(config: QuickAuthConfig): ChangfengAuth {
  // 注册 AccountResolver
  if (config.accountResolver) {
    setAccountResolver(config.accountResolver);
  }

  // 构建 BusinessAccount 自动创建 hook
  const autoCreateHooks: Record<string, unknown> = {};
  if (config.autoCreateBusinessAccount !== false) {
    autoCreateHooks.user = {
      create: {
        after: async (user: { id: string; email?: string }) => {
          await config.database.create({
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
  // priority: overrides.database > betterAuthDatabase > database (with as never)
  if (!mergedOverrides.database) {
    mergedOverrides.database = config.betterAuthDatabase ?? (config.database as never);
  }

  return createAuth({
    database: config.database,
    secret: config.secret,
    baseUrl: config.baseUrl,
    session: config.session,
    roleResolver: config.roleResolver,
    plugins: config.plugins,
    overrides: mergedOverrides as Partial<BetterAuthOptions>,
    hooks: config.hooks,
    captcha: config.captcha,
  });
}
