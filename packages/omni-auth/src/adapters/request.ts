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

/** getClientIp 可选参数 */
export interface ClientIpOptions {
  /**
   * 可信代理跳数（4.1.0）。
   *
   * 每层可信代理会在 x-forwarded-for 末尾追加它看到的对端 IP。
   * 配置后从列表右侧数第 depth 段作为客户端 IP，避免攻击者
   * 伪造头部左侧内容绕过限流。未配置时保持旧行为（取首段）。
   *
   * 例：客户端 → 代理A(不可信) → 代理B(可信) → 应用，depth = 1：
   * xff = "伪造值, 代理A真实IP"，取右侧第 1 段 = 代理A真实IP。
   */
  trustedProxyDepth?: number;
}

/**
 * 从 RequestContext 提取客户端 IP（限流键 / 审计用）。
 *
 * 优先级：x-forwarded-for → x-real-ip → "anonymous"。
 * 默认取 x-forwarded-for 首段（兼容旧行为）；配置
 * options.trustedProxyDepth 后改为从右侧数对应跳数，
 * 防头部伪造。ctx 缺省或无相关 header 时返回 "anonymous"。
 */
export function getClientIp(
  ctx?: RequestContext | null,
  options?: ClientIpOptions
): string {
  if (!ctx) return "anonymous";
  const forwarded = ctx.getHeader("x-forwarded-for");
  if (forwarded) {
    const segments = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    if (segments.length > 0) {
      const depth = options?.trustedProxyDepth;
      if (depth != null && depth >= 1) {
        // 从右侧数第 depth 段；跳数不足时退化为最左段（直连场景）
        const idx = Math.max(0, segments.length - depth);
        return segments[idx];
      }
      return segments[0];
    }
  }
  const realIp = ctx.getHeader("x-real-ip");
  if (realIp) return realIp.trim();
  return "anonymous";
}
