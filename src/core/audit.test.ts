import { describe, it, expect } from "vitest";
import { extractAuditContext } from "./audit";
import { createRequestContext } from "../adapters/request";

// 8.0.0：模块级全局审计函数（setAuditHandler/getAuditHandler/publishAuditEvent）
// 已随弃用移除；实例级审计经 OmniAuthConfig.audit / auth.setAuditHandler 配置，
// 其分发容错行为由 auth.test.ts 端到端覆盖。此处保留纯上下文提取辅助。

describe("extractAuditContext", () => {
  it("应提取 x-forwarded-for 作为 ip", () => {
    const ctx = createRequestContext({
      "x-forwarded-for": "10.0.0.1",
      "user-agent": "Mozilla/5.0",
    });
    const result = extractAuditContext(ctx);
    expect(result.ip).toBe("10.0.0.1");
  });

  it("x-forwarded-for 不存在时，应回退到 x-real-ip", () => {
    const ctx = createRequestContext({
      "x-real-ip": "10.0.0.2",
    });
    const result = extractAuditContext(ctx);
    expect(result.ip).toBe("10.0.0.2");
  });

  it("两者都不存在时 ip 为 undefined", () => {
    const ctx = createRequestContext({});
    const result = extractAuditContext(ctx);
    expect(result.ip).toBeUndefined();
  });

  it("应提取 User-Agent", () => {
    const ctx = createRequestContext({
      "user-agent": "Chrome/120.0",
    });
    const result = extractAuditContext(ctx);
    expect(result.userAgent).toBe("Chrome/120.0");
  });

  it("无 User-Agent 时返回 undefined", () => {
    const ctx = createRequestContext({});
    const result = extractAuditContext(ctx);
    expect(result.userAgent).toBeUndefined();
  });
});
