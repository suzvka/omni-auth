// ============================================================
// RBAC 角色工具 — 纯函数权限判断
//
// 由调用方在完成凭证校验后，传入用户角色列表进行判断。
// ============================================================

import { UnauthorizedError } from "../errors";

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
