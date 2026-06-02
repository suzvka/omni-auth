// ============================================================
// RBAC 角色系统
//
// 通过 RoleResolver 模式解耦角色存储：
//   1. 实现 RoleResolver.getRolesForUser(authUserId)
//   2. 注册到 SDK（类似 AccountResolver）
//   3. getContext() 自动填充 roles 字段
//   4. 使用 hasRole / requireRole 做权限检查
// ============================================================

import { UnauthorizedError } from "../errors";

export type RoleResolver = {
  /** 查询用户拥有的所有角色 */
  getRolesForUser(authUserId: string): Promise<string[]>;
};

let registeredRoleResolver: RoleResolver | null = null;

export function setRoleResolver(resolver: RoleResolver): void {
  registeredRoleResolver = resolver;
}

export function getRoleResolver(): RoleResolver | null {
  return registeredRoleResolver;
}

export async function resolveRoles(authUserId: string): Promise<string[]> {
  if (!registeredRoleResolver) return [];
  try {
    return await registeredRoleResolver.getRolesForUser(authUserId);
  } catch (err) {
    console.error("[resolveRoles] 查询角色失败:", err);
    return [];
  }
}

/**
 * 检查用户是否拥有指定角色。
 * @throws UnauthorizedError 如果检查不通过
 */
export function requireRole(roles: string[], required: string): void {
  if (!roles.includes(required)) {
    throw new UnauthorizedError(
      "FORBIDDEN",
      `需要角色 "${required}"，当前角色: [${roles.join(", ")}]`
    );
  }
}

/**
 * 检查用户是否拥有指定角色之一。
 * @throws UnauthorizedError 如果检查不通过
 */
export function requireAnyRole(roles: string[], required: string[]): void {
  const hasAny = required.some((r) => roles.includes(r));
  if (!hasAny) {
    throw new UnauthorizedError(
      "FORBIDDEN",
      `需要角色 [${required.join(", ")}] 之一，当前角色: [${roles.join(", ")}]`
    );
  }
}

/**
 * 判断用户是否拥有指定角色（不抛异常）。
 */
export function hasRole(roles: string[], target: string): boolean {
  return roles.includes(target);
}

/**
 * 判断用户是否拥有任一指定角色（不抛异常）。
 */
export function hasAnyRole(roles: string[], targets: string[]): boolean {
  return targets.some((r) => roles.includes(r));
}
