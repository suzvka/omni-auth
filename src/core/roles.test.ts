import { describe, it, expect } from "vitest";
import {
  hasRole,
  hasAnyRole,
  requireRole,
  requireAnyRole,
} from "./roles";
import { UnauthorizedError } from "../errors";

describe("hasRole / hasAnyRole", () => {
  it("hasRole: 拥有角色返回 true", () => {
    expect(hasRole(["admin", "editor"], "admin")).toBe(true);
  });

  it("hasRole: 没有角色返回 false", () => {
    expect(hasRole(["viewer"], "admin")).toBe(false);
  });

  it("hasRole: 空角色列表返回 false", () => {
    expect(hasRole([], "admin")).toBe(false);
  });

  it("hasAnyRole: 拥有任一角色返回 true", () => {
    expect(hasAnyRole(["viewer"], ["admin", "viewer"])).toBe(true);
  });

  it("hasAnyRole: 没有任何角色返回 false", () => {
    expect(hasAnyRole(["viewer"], ["admin", "editor"])).toBe(false);
  });

  it("hasAnyRole: 空目标列表返回 false", () => {
    expect(hasAnyRole(["admin"], [])).toBe(false);
  });
});

describe("requireRole / requireAnyRole", () => {
  it("requireRole: 拥有角色不抛异常", () => {
    expect(() => requireRole(["admin"], "admin")).not.toThrow();
  });

  it("requireRole: 没有角色抛 UnauthorizedError", () => {
    expect(() => requireRole(["viewer"], "admin")).toThrow(UnauthorizedError);
    expect(() => requireRole(["viewer"], "admin")).toThrow("需要角色 \"admin\"");
  });

  it("requireAnyRole: 拥有任一角色不抛异常", () => {
    expect(() => requireAnyRole(["viewer"], ["admin", "viewer"])).not.toThrow();
  });

  it("requireAnyRole: 没有任何角色抛 UnauthorizedError", () => {
    expect(() => requireAnyRole(["viewer"], ["admin", "editor"])).toThrow(UnauthorizedError);
    expect(() => requireAnyRole(["viewer"], ["admin", "editor"])).toThrow(
      '需要角色 [admin, editor] 之一'
    );
  });
});
