// ============================================================
// 会话模块 — 认证域私有（宿主请使用 auth.sessions.* 语义 API）
//
// 单令牌共享模型：同一用户至多一枚有效会话令牌（session.userId 唯一
// 约束），多设备复用同一枚；getOrCreateSession 以原子 upsert 实现
// 「有效即复用，过期才重铸」，无并发窗口。
// validateSession 内置账号状态校验（user.active=false 的会话即时失效），
// 替代宿主 JOIN "user" 直读认证表的旧做法。
// ============================================================

import { randomUUID } from "crypto";
import type { DatabaseAdapter } from "../adapters/database";
import { OmniAuthError } from "../errors";

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

/** 会话令牌与过期时间 */
export interface SessionToken {
  token: string;
  expiresAt: Date;
}

export interface SessionService {
  /**
   * 获取或铸造用户的会话令牌（单令牌共享模型唯一铸造入口）。
   * 既有令牌仍有效 → 复用（多设备共用同一枚）；无 / 已过期 → 原子重铸。
   */
  getOrCreateSession(
    userId: string,
    opts?: { ttlMs?: number }
  ): Promise<SessionToken>;
  /** 读取用户当前会话（不铸造、不写库）；无 / 已过期 / 账号禁用 → null */
  getUserSession(userId: string): Promise<SessionToken | null>;
  /** 校验会话令牌：有效返回 userId；过期/账号禁用时销毁会话并返回 null */
  validateSession(token: string): Promise<string | null>;
  /** 销毁用户的所有会话（登出 / 一键下线 / 禁用 / 删除用户时级联） */
  destroyUserSessions(userId: string): Promise<void>;
  /** 清理全部过期会话（供定时任务调用） */
  cleanupExpiredSessions(): Promise<void>;
}

export function createSessionService(db: DatabaseAdapter): SessionService {
  // 单令牌原子性依赖 upsert（ON CONFLICT DO UPDATE ... WHERE），构造期 fail-fast
  if (typeof db.upsert !== "function") {
    throw new OmniAuthError(
      "ADAPTER_UPSERT_UNSUPPORTED",
      "数据库适配器未实现 upsert，单令牌会话的原子「复用或重铸」不可用。" +
        "请为适配器实现 DatabaseAdapter.upsert（PostgreSQL 可用 ON CONFLICT ... DO UPDATE）。"
    );
  }

  return {
    async getOrCreateSession(userId, opts) {
      const now = new Date();
      const token = randomUUID();
      const expiresAt = new Date(now.getTime() + (opts?.ttlMs ?? SESSION_TTL_MS));

      // 原子 upsert：无行即插入；既有行仅过期时重铸（未过期受 where 保护 → 复用共享令牌）
      const row = (await db.upsert!({
        model: "session",
        data: { id: randomUUID(), userId, token, expiresAt, createdAt: now },
        conflictOn: ["userId"],
        update: { token, expiresAt },
        where: [{ field: "expiresAt", operator: "lt", value: now }],
      })) as SessionRecord | null;

      if (row) return { token, expiresAt };

      // 未重铸 ⇒ 既有令牌仍有效：回退读取复用（并发登录收敛到同一枚）
      const existing = (await db.findOne({
        model: "session",
        where: [{ field: "userId", value: userId }],
      })) as SessionRecord | null;

      if (!existing) {
        // upsert 冲突说明语句执行时行存在，此处为空仅可能是并发销毁（登出/禁用/改密）；
        // 抛错而非静默重铸：宁让本次登录失败，也不向正在被吊销的用户下发令牌
        throw new OmniAuthError(
          "SESSION_CONCURRENT_REVOKE",
          "会话在复用判定与读取之间被并发吊销，请重试。"
        );
      }

      return { token: existing.token, expiresAt: existing.expiresAt };
    },

    async getUserSession(userId) {
      const session = (await db.findOne({
        model: "session",
        where: [{ field: "userId", value: userId }],
      })) as SessionRecord | null;

      if (!session) return null;
      if (new Date(session.expiresAt).getTime() < Date.now()) return null;

      // 账号禁用即时视为无会话（销毁由 validateSession / 管理链路承担，本方法纯读）
      const user = (await db.findOne({
        model: "user",
        where: [{ field: "id", value: userId }],
      })) as { active?: unknown } | null;

      if (!user || !normalizeUserFlag(user.active, true)) return null;

      return { token: session.token, expiresAt: session.expiresAt };
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
