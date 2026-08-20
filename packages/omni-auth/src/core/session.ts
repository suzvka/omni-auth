// ============================================================
// 会话模块 — 认证域私有（宿主请使用 auth.sessions.* 语义 API）
//
// 会话数据存 session 表（认证域私有表），token 经 cookie 传递。
// validateSession 内置账号状态校验（user.active=false 的会话即时失效），
// 替代宿主 JOIN "user" 直读认证表的旧做法。
// ============================================================

import { randomUUID } from "crypto";
import type { DatabaseAdapter } from "../adapters/database";

/** 会话默认有效期（7 天，与历史宿主行为一致） */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 会话记录 */
export interface SessionRecord {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

/** 将 user 表的状态列（0/1 或 boolean）归一化为 boolean */
export function normalizeUserFlag(
  value: unknown,
  fallback: boolean = false
): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return fallback;
}

export interface SessionService {
  /** 创建会话，返回令牌与过期时间 */
  createSession(
    userId: string,
    opts?: { ttlMs?: number }
  ): Promise<{ token: string; expiresAt: Date }>;
  /** 校验会话令牌：有效返回 userId；过期/账号禁用时销毁会话并返回 null */
  validateSession(token: string): Promise<string | null>;
  /** 销毁指定令牌的会话 */
  invalidateSession(token: string): Promise<void>;
  /** 销毁用户的所有会话（禁用/删除用户时级联） */
  destroyUserSessions(userId: string): Promise<void>;
  /** 清理全部过期会话（供定时任务调用） */
  cleanupExpiredSessions(): Promise<void>;
}

export function createSessionService(db: DatabaseAdapter): SessionService {
  return {
    async createSession(userId, opts) {
      const id = randomUUID();
      const token = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + (opts?.ttlMs ?? SESSION_TTL_MS));

      await db.create({
        model: "session",
        data: {
          id,
          userId,
          token,
          expiresAt,
          createdAt: now,
        },
      });

      return { token, expiresAt };
    },

    async validateSession(token) {
      const session = (await db.findOne({
        model: "session",
        where: [{ field: "token", value: token }],
      })) as SessionRecord | null;

      if (!session) return null;

      const now = new Date();

      // 过期：销毁会话并视为未登录
      if (new Date(session.expiresAt).getTime() < now.getTime()) {
        await db.deleteOne({
          model: "session",
          where: [{ field: "id", value: session.id }],
        });
        return null;
      }

      // 账号禁用：销毁会话并视为未登录（禁用即时生效）
      const user = (await db.findOne({
        model: "user",
        where: [{ field: "id", value: session.userId }],
      })) as { active?: unknown } | null;

      if (!user || !normalizeUserFlag(user.active, true)) {
        await db.deleteOne({
          model: "session",
          where: [{ field: "id", value: session.id }],
        });
        return null;
      }

      return session.userId;
    },

    async invalidateSession(token) {
      await db.deleteOne({
        model: "session",
        where: [{ field: "token", value: token }],
      });
    },

    async destroyUserSessions(userId) {
      await db.deleteMany({
        model: "session",
        where: [{ field: "userId", value: userId }],
      });
    },

    async cleanupExpiredSessions() {
      await db.deleteMany({
        model: "session",
        where: [{ field: "expiresAt", operator: "lt", value: new Date() }],
      });
    },
  };
}
