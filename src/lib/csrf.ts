// ============================================================
// CSRF 同源校验辅助（D13）
//
// 所有写操作（POST/PUT/DELETE）必须校验 Origin/Referer 与 baseUrl 同源。
// 跨源或缺失 Origin/Referer 头的写请求一律拒绝（403）。
//
// 用法（写路由 handler 开头）：
//   - 已有请求上下文：if (!checkSameOrigin(ctx)) return 403;
//   - 无请求上下文：if (!(await checkSameOriginFromHeaders())) return 403;
// ============================================================

import { headers } from "next/headers";
import { nextjsRequestContext } from "omni-auth/nextjs";
import { isSameOrigin, type RequestContext } from "omni-auth";
import { baseUrl } from "./auth";

/** 同源校验（已有请求上下文时直接传入） */
export function checkSameOrigin(ctx: RequestContext): boolean {
  return isSameOrigin(ctx, baseUrl);
}

/** 同源校验（无上下文时从当前请求 headers 构建） */
export async function checkSameOriginFromHeaders(): Promise<boolean> {
  const ctx = nextjsRequestContext(await headers());
  return isSameOrigin(ctx, baseUrl);
}

/** 跨源写请求的统一 403 错误消息 */
export const CROSS_ORIGIN_ERROR = "拒绝跨源写请求";
