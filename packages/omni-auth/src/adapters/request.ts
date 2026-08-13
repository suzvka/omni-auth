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
