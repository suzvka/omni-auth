import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  setRoleResolver,
  getRoleResolver,
  resolveRoles,
  hasRole,
  hasAnyRole,
  requireRole,
  requireAnyRole,
} from "./roles";
import { UnauthorizedError } from "../errors";

describe("RoleResolver 注册表", () => {
  it("初始状态下 getRoleResolver 返回 null", () => {
    expect(getRoleResolver()).toBeNull();
  });

  it("setRoleResolver 注册后 getRoleResolver 返回同一实例", () => {
    const resolver = { getRolesForUser: async () => ["admin"] };
    setRoleResolver(resolver);
    expect(getRoleResolver()).toBe(resolver);
  });
});

describe("resolveRoles", () => {
  it("无 RoleResolver 时返回空数组", async () => {
    setRoleResolver(null as unknown as Parameters<typeof setRoleResolver>[0]);
    // 由于模块级状态，可能已被其他测试修改
    // 测试独立运行时依赖初始 null 状态
    const roles = await resolveRoles("user_1");
    expect(roles).toEqual([]);
  });

  it("有 RoleResolver 时返回角色列表", async () => {
    setRoleResolver({
      getRolesForUser: async (id: string) => (id === "admin_1" ? ["admin", "editor"] : ["viewer"]),
    });
    const roles = await resolveRoles("admin_1");
    expect(roles).toEqual(["admin", "editor"]);
  });

  it("RoleResolver 抛异常时返回空数组（容错）", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setRoleResolver({
      getRolesForUser: async () => {
        throw new Error("DB 不可用");
      },
    });
    const roles = await resolveRoles("user_1");
    expect(roles).toEqual([]);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

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
