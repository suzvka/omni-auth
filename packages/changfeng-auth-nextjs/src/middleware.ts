// ============================================================
// Next.js Middleware 支持
//
// Edge Runtime 兼容。
//
// 最简用法（preset = "default" 保护所有页面，放行 API 和公开页）：
//   export const middleware = createMiddleware(auth, { preset: "default" });
//
// 自定义配置：
//   export const middleware = createMiddleware(auth, {
//     protectedPaths: ["/dashboard", "/admin"],
//     requiredRoles: ["admin"],
//     signInPath: "/login",
//   });
//
// 配置 matcher 以限制 middleware 触发范围（推荐）：
//   export const config = {
//     matcher: ["/((?!api|_next|favicon.ico).*)"],
//   };
// ============================================================

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { ChangfengAuth } from "changfeng-auth";
import { createRequestContext } from "changfeng-auth";

export interface MiddlewareConfig {
  /**
   * 预设模式。
   * - "default": 保护所有页面路由，自动放行 /api/auth/*, /sign-in, /sign-up, 
   *   /reset-password, /favicon.ico, /_next/*。适合大多数应用。
   * - 不设置: 使用自定义 protectedPaths / publicPaths。
   */
  preset?: "default";
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
}

/**
 * 检查请求路径是否匹配指定模式。
 */
function matchesPath(pathname: string, patterns: (string | RegExp)[]): boolean {
  return patterns.some((pattern) => {
    if (typeof pattern === "string") {
      // 前缀匹配
      return pathname.startsWith(pattern);
    }
    return pattern.test(pathname);
  });
}

/**
 * 创建 Next.js middleware。
 * 在 Edge Runtime 中运行，自动校验 session 和角色。
 */
export function createMiddleware(auth: ChangfengAuth, config: MiddlewareConfig = {}) {
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
    // Better Auth 使用 "better-auth.session_token" cookie
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

    // 4. 通过 auth instance 校验 session
    // 注意：Edge Runtime 中不能直接调用 getSession（依赖 Headers API）
    // 这里通过设置 cookie header 传递 token
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
    } catch {
      // getContext 失败（可能是网络问题等），放行让 API route 自行处理
      return NextResponse.next();
    }
  };
}

function redirectToSignIn(req: NextRequest, signInPath: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = signInPath;
  url.searchParams.set("redirect", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

/**
 * 使用默认预设创建 middleware。
 * 等价于 createMiddleware(auth, { preset: "default" })。
 */
export function createDefaultMiddleware(auth: ChangfengAuth) {
  return createMiddleware(auth, { preset: "default" });
}
