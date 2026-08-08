// ============================================================
// App 端 SDK 初始化
//
// createQuickAuth 一站式初始化认证 SDK：
// - 声明式 database 配置（v0.6.0，内置 pg 驱动，零 Prisma 依赖）
// - 自动注册 BusinessAccount 的 AccountResolver
// - 自动设置 User 创建后的 BusinessAccount hook
// ============================================================

import { createQuickAuth, createRouteHelpers } from "omni-auth-nextjs";
import type { Account, DBApi } from "omni-auth";

export const auth = createQuickAuth({
  database: {
    url: process.env.DATABASE_URL!,
  },
  secret: process.env.BETTER_AUTH_SECRET ?? "changeme",
  baseUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  accountResolver: {
    async findByAuthUserId(authUserId: string): Promise<Account | null> {
      const record = await auth.db.findOne({
        model: "businessAccount",
        where: [{ field: "authUserId", value: authUserId }],
      }) as Record<string, unknown> | null;
      if (!record) return null;
      return {
        id: record.id as string,
        authUserId: record.authUserId as string,
        displayName: record.displayName as string,
        status: record.status as string,
        createdAt: record.createdAt as Date,
        updatedAt: record.updatedAt as Date,
      };
    },
  },
  // v0.6.0: roleResolver 接收 SDK 注入的 db，无需裸调 prisma
  roleResolver: {
    async getRolesForUser(authUserId: string, db?: DBApi): Promise<string[]> {
      if (!db) return [];
      const user = await db.findOne({
        model: "user",
        where: [{ field: "id", value: authUserId }],
      }) as Record<string, unknown> | null;
      return user && user.role ? [user.role as string] : [];
    },
  },
});

export const routeHelpers = createRouteHelpers(auth);
