// ============================================================
// Next.js Middleware 支持
//
// createMiddleware — 仅 Node.js Runtime
// 通过 OmniAuth 实例做完整 token 校验 + 角色检查，
// 需在 middleware.ts 顶部添加: export const runtime = "nodejs"。
//
// 用法：
//   export const runtime = "nodejs";
//   import { createMiddleware } from "omni-auth/nextjs";
//   import { auth } from "@/lib/auth";
//
//   export const middleware = createMiddleware(auth, {
//     protectedPaths: ["/dashboard", "/admin"],
//     requiredRoles: ["admin"],
//   });
//
// 配置 matcher 以限制 middleware 触发范围（推荐）：
//   export const config = {
//     matcher: ["/((?!api|_next|favicon.ico).*)"],
//   };
// ============================================================

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { OmniAuth } from "../auth";
import { createRequestContext } from "../adapters/request";

// ============================================================
// 类型定义
// ============================================================

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
// createMiddleware — Node.js Runtime 专用
// ============================================================

/**
 * 创建 Node.js Runtime 专用的 Next.js middleware。
 *
 * **需要 middleware.ts 顶部声明 `export const runtime = "nodejs"`。**
 *
 * 通过 OmniAuth 实例做完整 token 校验 + 角色检查 + 业务账户查询，
 * 将结果注入 x-auth-* headers 供下游使用。
 *
 * Token 来源（自动检测）：
 * - `omni-auth.token` cookie
 * - `Authorization: Bearer <token>` header
 *
 * @example
 * ```ts
 * // middleware.ts
 * export const runtime = "nodejs";
 *
 * import { createMiddleware } from "omni-auth/nextjs";
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

    // 3. 从请求 headers（含 cookie + Authorization）构建 RequestContext
    //    auth.getContext() 内部通过 _extractToken 自动从
    //    omni-auth.token cookie 或 Authorization: Bearer header 读取 token
    const rawHeaders: Record<string, string> = {};
    req.headers.forEach((value: string, key: string) => {
      rawHeaders[key] = value;
    });
    const ctx = createRequestContext(rawHeaders);

    try {
      // 4. 通过 auth instance 校验 token（需要数据库访问）
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
