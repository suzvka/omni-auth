import { describe, it, expect } from "vitest";
import { createRequestContext, getClientIp } from "./request";
import type { RequestContext } from "./request";

describe("createRequestContext", () => {
  it("应能通过 getHeader 读取请求头（大小写不敏感）", () => {
    const ctx = createRequestContext({
      "Content-Type": "application/json",
      "x-custom-header": "test-value",
    });

    expect(ctx.getHeader("content-type")).toBe("application/json");
    expect(ctx.getHeader("Content-Type")).toBe("application/json");
    expect(ctx.getHeader("X-Custom-Header")).toBe("test-value");
    expect(ctx.getHeader("x-custom-header")).toBe("test-value");
  });

  it("不存在的 header 应返回 null", () => {
    const ctx = createRequestContext({});
    expect(ctx.getHeader("missing-header")).toBeNull();
  });

  it("数组类型的 header 值应被合并为逗号分隔的字符串", () => {
    const ctx = createRequestContext({
      accept: ["text/html", "application/json"],
    });

    const accept = ctx.getHeader("accept");
    expect(accept).toBe("text/html, application/json");
  });

  it("undefined 值应被忽略", () => {
    const ctx = createRequestContext({
      present: "value",
      absent: undefined,
    });

    expect(ctx.getHeader("present")).toBe("value");
    expect(ctx.getHeader("absent")).toBeNull();
  });

  it("getCookie 应正确解析 Cookie 值", () => {
    const ctx = createRequestContext({
      cookie: "session_token=abc123; theme=dark; lang=zh",
    });

    expect(ctx.getCookie("session_token")).toBe("abc123");
    expect(ctx.getCookie("theme")).toBe("dark");
    expect(ctx.getCookie("lang")).toBe("zh");
  });

  it("getCookie 不存在的 cookie 应返回 null", () => {
    const ctx = createRequestContext({
      cookie: "session_token=abc123",
    });

    expect(ctx.getCookie("missing")).toBeNull();
  });

  it("无 cookie header 时 getCookie 返回 null", () => {
    const ctx = createRequestContext({});
    expect(ctx.getCookie("anything")).toBeNull();
  });

  it("asHeaders 应返回原始 headers", () => {
    const ctx = createRequestContext({
      "content-type": "text/plain",
      authorization: "Bearer token123",
    });

    const headers = ctx.asHeaders();
    expect(headers["content-type"]).toBe("text/plain");
    expect(headers["authorization"]).toBe("Bearer token123");
  });
});

// ----------------------------------------------------------
// getClientIp（4.1.0：trustedProxyDepth 防头部伪造）
// ----------------------------------------------------------

describe("getClientIp", () => {
  it("默认取 x-forwarded-for 首段（兼容旧行为）", () => {
    const ctx = createRequestContext({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" });
    expect(getClientIp(ctx)).toBe("1.1.1.1");
  });

  it("无 x-forwarded-for 时回退 x-real-ip，再无则 anonymous", () => {
    expect(getClientIp(createRequestContext({ "x-real-ip": "2.2.2.2" }))).toBe("2.2.2.2");
    expect(getClientIp(createRequestContext({}))).toBe("anonymous");
    expect(getClientIp(null)).toBe("anonymous");
    expect(getClientIp(undefined)).toBe("anonymous");
  });

  it("trustedProxyDepth=1 时取右侧第 1 段（忽略左侧伪造内容）", () => {
    const ctx = createRequestContext({ "x-forwarded-for": "6.6.6.6, 3.3.3.3" });
    expect(getClientIp(ctx, { trustedProxyDepth: 1 })).toBe("3.3.3.3");
  });

  it("trustedProxyDepth=2 时取右侧第 2 段", () => {
    const ctx = createRequestContext({
      "x-forwarded-for": "spoofed, 1.1.1.1, 10.0.0.1",
    });
    expect(getClientIp(ctx, { trustedProxyDepth: 2 })).toBe("1.1.1.1");
  });

  it("跳数不足时退化为最左段（直连场景）", () => {
    const ctx = createRequestContext({ "x-forwarded-for": "4.4.4.4" });
    expect(getClientIp(ctx, { trustedProxyDepth: 3 })).toBe("4.4.4.4");
  });

  it("配置 depth 但无 x-forwarded-for 时仍回退 x-real-ip / anonymous", () => {
    expect(getClientIp(createRequestContext({ "x-real-ip": "5.5.5.5" }), { trustedProxyDepth: 1 })).toBe("5.5.5.5");
    expect(getClientIp(createRequestContext({}), { trustedProxyDepth: 1 })).toBe("anonymous");
  });
});
