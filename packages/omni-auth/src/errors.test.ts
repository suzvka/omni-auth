import { describe, it, expect } from "vitest";
import {
  UnauthorizedError,
  InvalidPasswordError,
  SocialAccountConflictError,
  WeakPasswordError,
} from "./errors";

describe("UnauthorizedError", () => {
  it("应包含 code 和 message 属性", () => {
    const err = new UnauthorizedError("FORBIDDEN", "无权限访问");
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toBe("无权限访问");
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
    const err = new InvalidPasswordError("密码不正确");
    expect(err.message).toBe("密码不正确");
  });

  it("应为 Error 子类", () => {
    const err = new InvalidPasswordError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidPasswordError);
  });
});

describe("SocialAccountConflictError", () => {
  it("应包含 provider 和 providerOpenid", () => {
    const err = new SocialAccountConflictError("wechat", "openid_abc");
    expect(err.message).toContain("wechat");
    expect(err.message).toContain("openid_abc");
    expect(err.message).toContain("已被其他用户绑定");
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
    const err = new WeakPasswordError("密码长度不能少于 8 位");
    expect(err.code).toBe("WEAK_PASSWORD");
    expect(err.message).toBe("密码长度不能少于 8 位");
    expect(err.name).toBe("WeakPasswordError");
  });

  it("应包含默认消息且为 Error 子类", () => {
    const err = new WeakPasswordError();
    expect(err.message).toBe("密码不满足强度要求");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WeakPasswordError);
  });
});
