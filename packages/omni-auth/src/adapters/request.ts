// ============================================================
// RequestContext — HTTP 请求上下文抽象
//
// 替代 next/headers()，框架无关。
// 通过 createRequestContext() 从原始 headers 对象构建。
// ============================================================

export interface RequestContext {
  /** 读取请求头，大小写不敏感 */
  getHeader(name: string): string | null;

  /** 读取 Cookie 值 */
  getCookie(name: string): string | null;

  /** 返回原始 headers 对象 */
  asHeaders(): Record<string, string>;
}

/**
 * 从原始 headers 对象创建 RequestContext。
 * 支持 Express req.headers、fetch Headers、Next.js headers() 等。
 */
export function createRequestContext(
  rawHeaders: Record<string, string | string[] | undefined>
): RequestContext {
  // 构建大小写不敏感的 header 查找表
  const headersMap = new Map<string, string>();

  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    const val = Array.isArray(value) ? value.join(", ") : value;
    headersMap.set(key.toLowerCase(), val);
  }

  return {
    getHeader(name: string): string | null {
      return headersMap.get(name.toLowerCase()) ?? null;
    },

    getCookie(name: string): string | null {
      const cookieHeader = headersMap.get("cookie");
      if (!cookieHeader) return null;

      const nameEq = `${name}=`;
      const parts = cookieHeader.split(";");
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith(nameEq)) {
          return decodeURIComponent(trimmed.slice(nameEq.length));
        }
      }
      return null;
    },

    asHeaders(): Record<string, string> {
      return Object.fromEntries(headersMap);
    },
  };
}

/**
 * 从 RequestContext 提取客户端 IP（限流键 / 审计用）。
 *
 * 优先级：x-forwarded-for 首段 → x-real-ip → "anonymous"。
 * ctx 缺省或无相关 header 时返回 "anonymous"。
 */
export function getClientIp(ctx?: RequestContext | null): string {
  if (!ctx) return "anonymous";
  const forwarded = ctx.getHeader("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = ctx.getHeader("x-real-ip");
  if (realIp) return realIp.trim();
  return "anonymous";
}
