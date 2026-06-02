import { describe, it, expect, vi } from "vitest";
import {
  setAuditHandler,
  getAuditHandler,
  publishAuditEvent,
  extractAuditContext,
} from "./audit";
import type { AuditEvent, AuditHandler } from "./audit";
import { createRequestContext } from "../adapters/request";

describe("Audit Handler 注册表", () => {
  it("初始状态下 getAuditHandler 返回 null", () => {
    setAuditHandler(null as unknown as AuditHandler);
    expect(getAuditHandler()).toBeNull();
  });

  it("setAuditHandler 注册后 getAuditHandler 返回同一实例", () => {
    const handler: AuditHandler = async () => {};
    setAuditHandler(handler);
    expect(getAuditHandler()).toBe(handler);
  });
});

describe("publishAuditEvent", () => {
  it("无 handler 时不应抛异常", async () => {
    setAuditHandler(null as unknown as AuditHandler);
    await expect(
      publishAuditEvent({ action: "signUp", userId: "u1" })
    ).resolves.toBeUndefined();
  });

  it("有 handler 时应调用并传递完整事件", async () => {
    const received: AuditEvent[] = [];
    const handler: AuditHandler = async (event) => {
      received.push(event);
    };
    setAuditHandler(handler);

    await publishAuditEvent({ action: "signIn", userId: "u2" });

    expect(received).toHaveLength(1);
    expect(received[0].action).toBe("signIn");
    expect(received[0].userId).toBe("u2");
    expect(received[0].timestamp).toBeInstanceOf(Date);
  });

  it("多次发布应依次调用 handler", async () => {
    const received: AuditEvent[] = [];
    setAuditHandler(async (event) => {
      received.push(event);
    });

    await publishAuditEvent({ action: "signUp", userId: "u1" });
    await publishAuditEvent({ action: "signIn", userId: "u1" });
    await publishAuditEvent({ action: "signOut", userId: "u1" });

    expect(received).toHaveLength(3);
    expect(received.map((e) => e.action)).toEqual(["signUp", "signIn", "signOut"]);
  });

  it("handler 抛异常时应容错不抛出", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setAuditHandler(async () => {
      throw new Error("DB write failed");
    });

    await expect(
      publishAuditEvent({ action: "deleteAccount", userId: "u1" })
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("应支持 metadata 字段", async () => {
    const received: AuditEvent[] = [];
    setAuditHandler(async (event) => {
      received.push(event);
    });

    await publishAuditEvent({
      action: "signInFailed",
      userId: "u3",
      metadata: { email: "test@example.com", ip: "1.2.3.4" },
    });

    expect(received[0].metadata).toEqual({
      email: "test@example.com",
      ip: "1.2.3.4",
    });
  });
});

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
