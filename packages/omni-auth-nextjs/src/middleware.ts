// ============================================================
// Next.js Middleware 支持
//
// 提供两种 middleware 策略：
//
// 1. createEdgeMiddleware（推荐）— Edge Runtime 兼容
//    只做轻量 token 校验：读 cookie → 调 /api/auth/get-session 验证。
//    不直接访问数据库，可安全运行在 Edge Runtime。
//
//    用法：
//      export const middleware = createEdgeMiddleware();
//
// 2. createMiddleware（高级）— 仅 Node.js Runtime
//    通过 OmniAuth 实例做完整 session 校验 + 角色检查，
//    需在 middleware.ts 顶部添加: export const runtime = "nodejs"。
//    适用于需要中间件层做角色/权限判断的场景。
//
//    用法：
//      export const runtime = "nodejs";
//      export const middleware = createMiddleware(auth, { requiredRoles: ["admin"] });
//
// 配置 matcher 以限制 middleware 触发范围（推荐）：
//   export const config = {
//     matcher: ["/((?!api|_next|favicon.ico).*)"],
//   };
// ============================================================

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { OmniAuth } from "omni-auth";
import { createRequestContext } from "omni-auth";

// ============================================================
// 类型定义
// ============================================================

/** Edge 中间件配置（无 auth 实例依赖，Edge Runtime 安全） */
export interface EdgeMiddlewareConfig {
  /**
   * 公开路径（无需登录），支持字符串前缀匹配或正则。
   * 默认：/api/auth, /sign-in, /sign-up, /reset-password, /favicon.ico, /_next
   */
  publicPaths?: (string | RegExp)[];
  /** 登录页路径（未登录时重定向到此），默认 "/sign-in" */
  signInPath?: string;
  /**
   * Session cookie 名称，默认 "better-auth.session_token"。
   * 如果自定义了 Better Auth cookie 名称，需要修改此项。
   */
  sessionCookieName?: string;
  /** 自定义未授权处理（返回 Response 则使用该响应，返回 void 则走默认重定向） */
  onUnauthorized?: (req: NextRequest) => Response | void;
  /**
   * Auth API 基础路径，默认 "/api/auth"。
   * 必须与 Better Auth handler 挂载路径一致。
   */
  authBasePath?: string;
  /**
   * 自定义错误处理（中间件内部异常时触发）。
   * 返回 Response 则使用该响应，返回 void 则放行请求。
   */
  onError?: (req: NextRequest, error: Error) => Response | void;
}

/** Node.js 中间件配置（需 OmniAuth 实例，仅 Node.js Runtime） */
export interface MiddlewareConfig {
  /**
   * 需要登录才能访问的路径前缀。
   * 支持字符串或正则。未设置则所有路径都需要登录。
   */
  protectedPaths?: (string | RegExp)[];
  /**
   * 公开路径（无需登录），优先级高于 protectedPaths。
   */
  publicPaths?: (string | RegExp)[];
  /** 登录页路径（未登录时重定向到此） */
  signInPath?: string;
  /** 要求特定角色（所有受保护路径都需要） */
  requiredRoles?: string[];
  /** 自定义未授权处理（返回 Response 或 void 放行） */
  onUnauthorized?: (req: NextRequest, reason: "unauthenticated" | "forbidden") => Response | void;
  /**
   * 自定义错误处理（中间件内部异常时触发）。
   * 返回 Response 则使用该响应，返回 void 则返回 500。
   */
  onError?: (req: NextRequest, error: Error) => Response | void;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 检查请求路径是否匹配指定模式。
 */
function matchesPath(pathname: string, patterns: (string | RegExp)[]): boolean {
  return patterns.some((pattern) => {
    if (typeof pattern === "string") {
      return pathname.startsWith(pattern);
    }
    return pattern.test(pathname);
  });
}

function redirectToSignIn(req: NextRequest, signInPath: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = signInPath;
  url.searchParams.set("redirect", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

/**
 * 格式化错误日志（结构化，方便接入日志系统）。
 */
function logMiddlewareError(
  req: NextRequest,
  error: Error,
  context: string
): void {
  console.error(
    `[omni-auth middleware] ${context}`,
    JSON.stringify({
      pathname: req.nextUrl.pathname,
      method: req.method,
      ip: req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown",
      errorName: error.name,
      errorMessage: error.message,
      timestamp: new Date().toISOString(),
    })
  );
}

// ============================================================
// createEdgeMiddleware — Edge Runtime 兼容（推荐）
// ============================================================

/**
 * 创建 Edge Runtime 兼容的 Next.js middleware。
 *
 * 工作原理：
 * 1. 从请求 cookie 中读取 session token
 * 2. 通过 HTTP fetch 调 /api/auth/get-session 验证 token
 * 3. 验证通过 → 放行；验证失败 → 重定向到登录页
 *
 * 不直接访问数据库，可安全运行在 Edge Runtime。
 *
 * @example
 * ```ts
 * // middleware.ts
 * import { createEdgeMiddleware } from "omni-auth-nextjs";
 *
 * export const middleware = createEdgeMiddleware();
 *
 * export const config = {
 *   matcher: ["/((?!api|_next|favicon.ico).*)"],
 * };
 * ```
 */
export function createEdgeMiddleware(config: EdgeMiddlewareConfig = {}) {
  const {
    publicPaths = [
      "/api/auth",
      "/sign-in",
      "/sign-up",
      "/reset-password",
      "/favicon.ico",
      "/_next",
    ],
    signInPath = "/sign-in",
    sessionCookieName = "better-auth.session_token",
    authBasePath = "/api/auth",
    onUnauthorized,
    onError,
  } = config;

  return async function middleware(req: NextRequest) {
    const { pathname } = req.nextUrl;

    // 1. 公开路径直接放行
    if (matchesPath(pathname, publicPaths)) {
      return NextResponse.next();
    }

    // 2. 从 cookie 中读取 session token
    const sessionToken = req.cookies.get(sessionCookieName)?.value;

    if (!sessionToken) {
      if (onUnauthorized) {
        const res = onUnauthorized(req);
        if (res) return res;
      }
      return redirectToSignIn(req, signInPath);
    }

    // 3. 通过 HTTP 调 auth API 验证 session
    //    API Route 运行在 Node.js Runtime，可以安全访问数据库
    try {
      const authUrl = `${req.nextUrl.origin}${authBasePath}/get-session`;
      const verifyRes = await fetch(authUrl, {
        headers: {
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
      });

      if (!verifyRes.ok) {
        // API 返回非 2xx，token 无效或服务异常
        if (onUnauthorized) {
          const res = onUnauthorized(req);
          if (res) return res;
        }
        return redirectToSignIn(req, signInPath);
      }

      const data = (await verifyRes.json()) as {
        user?: { id: string; email?: string; name?: string } | null;
      } | null;

      // get-session 返回 null 表示未登录或 session 过期
      if (!data || !data.user) {
        if (onUnauthorized) {
          const res = onUnauthorized(req);
          if (res) return res;
        }
        return redirectToSignIn(req, signInPath);
      }

      // 4. 验证通过，注入用户信息到 header 供下游使用
      const res = NextResponse.next();
      res.headers.set("x-auth-user-id", data.user.id);
      if (data.user.email) {
        res.headers.set("x-auth-email", data.user.email);
      }
      if (data.user.name) {
        res.headers.set("x-auth-display-name", data.user.name);
      }

      return res;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logMiddlewareError(req, error, "Session 验证失败");

      if (onError) {
        const errRes = onError(req, error);
        if (errRes) return errRes;
      }
      // 出错时放行，避免因 auth 服务抖动导致全站不可用
      return NextResponse.next();
    }
  };
}

// ============================================================
// createMiddleware — Node.js Runtime 专用（高级场景）
// ============================================================

/**
 * 创建 Node.js Runtime 专用的 Next.js middleware。
 *
 * **需要 middleware.ts 顶部声明 `export const runtime = "nodejs"`。**
 *
 * 通过 OmniAuth 实例做完整 session 校验 + 角色检查 + 业务账户查询，
 * 将结果注入 x-auth-* headers 供下游使用。
 *
 * 适用场景：需要在中间件层做精细化的角色/权限判断。
 * 大多数场景推荐使用 createEdgeMiddleware。
 *
 * @example
 * ```ts
 * // middleware.ts
 * export const runtime = "nodejs";
 *
 * import { createMiddleware } from "omni-auth-nextjs";
 * import { auth } from "@/lib/auth";
 *
 * export const middleware = createMiddleware(auth, {
 *   protectedPaths: ["/dashboard", "/admin"],
 *   requiredRoles: ["admin"],
 * });
 * ```
 */
export function createMiddleware(auth: OmniAuth, config: MiddlewareConfig = {}) {
  const {
    protectedPaths = ["/"],
    publicPaths = [
      "/api/auth",
      "/sign-in",
      "/sign-up",
      "/reset-password",
      "/favicon.ico",
      "/_next",
    ],
    signInPath = "/sign-in",
    requiredRoles,
    onUnauthorized,
    onError,
  } = config;

  return async function middleware(req: NextRequest) {
    const { pathname } = req.nextUrl;

    // 1. 公开路径直接放行
    if (matchesPath(pathname, publicPaths)) {
      return NextResponse.next();
    }

    // 2. 检查是否需要保护
    const needsAuth = matchesPath(pathname, protectedPaths);
    if (!needsAuth) {
      return NextResponse.next();
    }

    // 3. 从 cookie 中读取 session token
    const sessionToken =
      req.cookies.get("better-auth.session_token")?.value ??
      req.cookies.get("auth_session")?.value;

    if (!sessionToken) {
      if (onUnauthorized) {
        const res = onUnauthorized(req, "unauthenticated");
        if (res) return res;
      }
      return redirectToSignIn(req, signInPath);
    }

    // 4. 通过 auth instance 校验 session（需要数据库访问）
    const ctx = createRequestContext({
      cookie: `better-auth.session_token=${sessionToken}`,
    });

    try {
      const authCtx = await auth.getContext(ctx);

      if (!authCtx.authUserId) {
        if (onUnauthorized) {
          const res = onUnauthorized(req, "unauthenticated");
          if (res) return res;
        }
        return redirectToSignIn(req, signInPath);
      }

      // 5. 角色检查
      if (requiredRoles && requiredRoles.length > 0) {
        const hasRequiredRole = requiredRoles.some((r) => authCtx.roles.includes(r));
        if (!hasRequiredRole) {
          if (onUnauthorized) {
            const res = onUnauthorized(req, "forbidden");
            if (res) return res;
          }
          return new NextResponse("Forbidden", { status: 403 });
        }
      }

      // 6. 注入 auth context 到 header 供下游使用
      const res = NextResponse.next();
      res.headers.set("x-auth-user-id", authCtx.authUserId);
      if (authCtx.account?.displayName) {
        res.headers.set("x-auth-display-name", authCtx.account.displayName);
      }
      res.headers.set("x-auth-roles", authCtx.roles.join(","));

      return res;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logMiddlewareError(req, error, "getContext 失败");

      if (onError) {
        const errRes = onError(req, error);
        if (errRes) return errRes;
      }
      // 出错时返回 500，不再静默放行
      return new NextResponse(
        JSON.stringify({
          error: "auth_middleware_error",
          message: "认证服务暂时不可用，请稍后重试",
        }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  };
}

// ============================================================
// 快捷工厂
// ============================================================

/**
 * 使用默认预设创建 middleware。
 *
 * @deprecated 推荐使用 createEdgeMiddleware()（Edge Runtime 兼容）。
 *             如果仍需要完整 session + 角色校验，请使用 createMiddleware(auth, config)
 *             并在 middleware.ts 中声明 `export const runtime = "nodejs"`。
 */
export function createDefaultMiddleware(auth: OmniAuth) {
  return createMiddleware(auth, {});
}
