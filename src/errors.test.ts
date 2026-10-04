/** test-meta: tier=fast; risk=low; owner=identity; expires=2027-03-31 */
import { describe, it, expect } from "vitest";
import {
  UnauthorizedError,
  InvalidPasswordError,
  SocialAccountConflictError,
  WeakPasswordError,
} from "./errors";

describe("UnauthorizedError", () => {
  it("应包含 code 和 message 属性", () => {
    const message = "无权限访问";
    const err = new UnauthorizedError("FORBIDDEN", message);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toBe(message);
    expect(err.name).toBe("UnauthorizedError");
  });

  it("应为 Error 子类", () => {
    const err = new UnauthorizedError("TEST", "test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UnauthorizedError);
  });
});

describe("InvalidPasswordError", () => {
  it("应包含默认消息", () => {
    const err = new InvalidPasswordError();
    expect(err.message).toBe("Invalid password");
    expect(err.name).toBe("InvalidPasswordError");
  });

  it("应支持自定义消息", () => {
    const message = "密码不正确";
    const err = new InvalidPasswordError(message);
    expect(err.message).toBe(message);
  });

  it("应为 Error 子类", () => {
    const err = new InvalidPasswordError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidPasswordError);
  });
});

describe("SocialAccountConflictError", () => {
  it("应包含 provider 和 providerOpenid", () => {
    const provider = "wechat";
    const identifier = "openid_abc";
    const err = new SocialAccountConflictError(provider, identifier);
    expect(err.code).toBe("SOCIAL_ACCOUNT_CONFLICT");
    // message 透出定位标识（模板文案不锁）
    expect(err.message).toContain(provider);
    expect(err.message).toContain(identifier);
    expect(err.name).toBe("SocialAccountConflictError");
  });

  it("应为 Error 子类", () => {
    const err = new SocialAccountConflictError("google", "oid_123");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SocialAccountConflictError);
  });
});

describe("WeakPasswordError", () => {
  it("应包含机器可读 code WEAK_PASSWORD", () => {
    const message = "密码长度不能少于 8 位";
    const err = new WeakPasswordError(message);
    expect(err.code).toBe("WEAK_PASSWORD");
    expect(err.message).toBe(message);
    expect(err.name).toBe("WeakPasswordError");
  });

  it("应包含默认消息且为 Error 子类", () => {
    const err = new WeakPasswordError();
    // 默认消息存在且非空（展示文案不锁，code 才是程序化消费面）
    expect(err.message.length).toBeGreaterThan(0);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WeakPasswordError);
  });
});
