// ============================================================
// CSRF 同源校验 — Origin/Referer 验证
//
// 所有写操作（POST/DELETE）校验 Origin/Referer 与 baseUrl 同源。
// 配合 cookie sameSite=lax 提供双重 CSRF 防护。
// ============================================================

import type { RequestContext } from "../adapters/request";

/**
 * 校验请求是否同源。
 *
 * 规则：
 * 1. 读取 Origin header（优先）或 Referer header（回退）
 * 2. 与 baseUrl 比较：协议 + host + 端口 必须一致
 * 3. 缺失 header → 拒绝（安全优先）
 *
 * @param ctx 请求上下文
 * @param baseUrl 应用基础 URL（如 "http://localhost:3000"）
 * @returns true 表示同源（通过），false 表示跨源或缺失（拒绝）
 */
export function isSameOrigin(ctx: RequestContext, baseUrl: string): boolean {
    // 1. 尝试 Origin header（getHeader 已大小写不敏感）
    const origin = ctx.getHeader("origin");
    if (origin) {
        return normalizeUrl(origin) === normalizeUrl(baseUrl);
    }

    // 2. 回退到 Referer header
    const referer = ctx.getHeader("referer");
    if (referer) {
        return normalizeUrl(referer) === normalizeUrl(baseUrl);
    }

    // 3. 缺失 header → 拒绝
    return false;
}

/**
 * 规范化 URL：提取 protocol + host（含端口），移除 path/query。
 * 用于同源比较。
 */
function normalizeUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}`;
    } catch {
        return "";
    }
}

/**
 * 创建 CSRF 校验中间件函数。
 *
 * 用法：
 * ```typescript
 * const csrfCheck = createOriginCheck(auth.config.baseUrl);
 * if (!csrfCheck(ctx)) {
 *   return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
 * }
 * ```
 */
export function createOriginCheck(baseUrl: string): (ctx: RequestContext) => boolean {
    return (ctx: RequestContext) => isSameOrigin(ctx, baseUrl);
}
