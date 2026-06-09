// ============================================================
// RBAC 角色系统
//
// 通过 RoleResolver 模式解耦角色存储：
//   1. 实现 RoleResolver.getRolesForUser(authUserId, db?)
//   2. 注册到 SDK（类似 AccountResolver）
//   3. getContext() 自动填充 roles 字段
//   4. 使用 hasRole / requireRole 做权限检查
// ============================================================

import { UnauthorizedError } from "../errors";
import type { DatabaseAdapter } from "../adapters/database";

/** 对外暴露的 DBApi 子集（与 ChangfengAuth.db 返回类型一致） */
export interface DBApi {
  findOne(params: { model: string; where: { field: string; value: unknown; operator?: string }[] }): Promise<unknown | null>;
  findMany(params: { model: string; where?: { field: string; value: unknown; operator?: string }[]; search?: { fields: string[]; value: string }; orderBy?: { field: string; direction: "asc" | "desc" }; limit?: number; offset?: number }): Promise<unknown[]>;
  create(params: { model: string; data: Record<string, unknown> }): Promise<unknown>;
  updateOne(params: { model: string; where: { field: string; value: unknown }[]; update: Record<string, unknown> }): Promise<unknown>;
  updateMany(params: { model: string; where: { field: string; value: unknown; operator?: string }[]; update: Record<string, unknown> }): Promise<number>;
  deleteOne(params: { model: string; where: { field: string; value: unknown; operator?: string }[] }): Promise<unknown>;
  deleteMany(params: { model: string; where: { field: string; value: unknown; operator?: string }[] }): Promise<number>;
  count(params: { model: string; where?: { field: string; value: unknown; operator?: string }[]; search?: { fields: string[]; value: string } }): Promise<number>;
}

export type RoleResolver = {
  /**
   * 查询用户拥有的所有角色。
   *
   * @param authUserId  Better Auth 用户 ID
   * @param db          SDK 注入的数据库操作接口（v0.6.0 新增，可选以保持向后兼容）
   */
  getRolesForUser(authUserId: string, db?: DBApi): Promise<string[]>;
};

let registeredRoleResolver: RoleResolver | null = null;

export function setRoleResolver(resolver: RoleResolver): void {
  registeredRoleResolver = resolver;
}

export function getRoleResolver(): RoleResolver | null {
  return registeredRoleResolver;
}

/**
 * 解析用户角色。
 *
 * @param authUserId 用户 ID
 * @param db         可选的数据库操作接口（由 ChangfengAuth 内部传入，消除循环依赖）
 */
export async function resolveRoles(authUserId: string, db?: DBApi): Promise<string[]> {
  if (!registeredRoleResolver) return [];
  try {
    return await registeredRoleResolver.getRolesForUser(authUserId, db);
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
