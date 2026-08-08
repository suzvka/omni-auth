// ============================================================
// Session 管理（列表 / 吊销）
// ============================================================

import type { BetterAuthInstance } from "../auth";
import type { DatabaseAdapter } from "../adapters/database";
import type { RequestContext } from "../adapters/request";
import type { BetterAuthSession } from "./betterAuthTypes";
import { UnauthorizedError } from "../errors";

export interface SessionInfo {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** 是否为当前请求的 session */
  isCurrent: boolean;
}

export interface SessionManagementDeps {
  auth: BetterAuthInstance;
  db: DatabaseAdapter;
}

export function createSessionManagement(deps: SessionManagementDeps) {
  const { auth, db } = deps;

  return {
    /**
     * 列出当前用户的所有活跃 session。
     */
    async listSessions(ctx: RequestContext): Promise<SessionInfo[]> {
      const session = await auth.api.getSession({
        headers: ctx.asHeaders ? ctx.asHeaders() : {},
      }) as unknown as BetterAuthSession | null;

      if (!session?.user?.id) {
        throw new UnauthorizedError("UNAUTHENTICATED", "请先登录");
      }

      const userId = session.user.id;
      const currentToken = session.session?.token;

      const records = (await db.findMany({
        model: "session",
        where: [{ field: "userId", value: userId }],
      })) as {
        id: string;
        token: string;
        userId: string;
        expiresAt: Date;
        createdAt: Date;
        ipAddress?: string | null;
        userAgent?: string | null;
      }[];

      return records.map((r) => ({
        id: r.id,
        token: r.token,
        userId: r.userId,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        isCurrent: r.token === currentToken,
      }));
    },

    /**
     * 吊销指定的 session。
     */
    async revokeSession(
      ctx: RequestContext,
      sessionId: string
    ): Promise<void> {
      const session = await auth.api.getSession({
        headers: ctx.asHeaders ? ctx.asHeaders() : {},
      }) as unknown as BetterAuthSession | null;

      if (!session?.user?.id) {
        throw new UnauthorizedError("UNAUTHENTICATED", "请先登录");
      }

      // 只允许删除自己的 session
      const target = (await db.findOne({
        model: "session",
        where: [{ field: "id", value: sessionId }],
      })) as { userId: string } | null;

      if (!target) {
        throw new Error("Session 不存在");
      }

      if (target.userId !== session.user.id) {
        throw new UnauthorizedError("FORBIDDEN", "无权操作他人的 session");
      }

      await db.deleteOne({
        model: "session",
        where: [{ field: "id", value: sessionId }],
      });
    },

    /**
     * 吊销当前用户除本次请求外的所有 session。
     * 用于"踢出所有其他设备"场景。
     */
    async revokeAllSessions(ctx: RequestContext): Promise<number> {
      const session = await auth.api.getSession({
        headers: ctx.asHeaders ? ctx.asHeaders() : {},
      }) as unknown as BetterAuthSession | null;

      if (!session?.user?.id) {
        throw new UnauthorizedError("UNAUTHENTICATED", "请先登录");
      }

      const userId = session.user.id;
      const currentToken = session.session?.token;

      // 删除除当前 token 外的所有 session
      const result = await db.deleteMany({
        model: "session",
        where: [
          { field: "userId", value: userId },
          ...(currentToken ? [{ field: "token", value: currentToken, operator: "neq" as const }] : []),
        ],
      });

      return result;
    },
  };
}
