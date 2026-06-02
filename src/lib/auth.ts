// ============================================================
// App 端 SDK 初始化
//
// createQuickAuth 一站式初始化认证 SDK：
// - 自动创建 PrismaAdapter
// - 自动注册 BusinessAccount 的 AccountResolver
// - 自动设置 User 创建后的 BusinessAccount hook
// ============================================================

import { prisma, businessAccountRepo } from "@/modules/db";
import { PrismaAdapter } from "changfeng-auth/adapters/prisma";
import { createQuickAuth, createRouteHelpers } from "changfeng-auth-nextjs";
import type { Account } from "changfeng-auth";

export const auth = createQuickAuth({
  database: PrismaAdapter({ prisma }),
  secret: process.env.BETTER_AUTH_SECRET ?? "changeme",
  baseUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  accountResolver: {
    async findByAuthUserId(authUserId: string): Promise<Account | null> {
      const record = await businessAccountRepo.findByAuthUserId(authUserId);
      if (!record) return null;
      return {
        id: record.id,
        authUserId: record.authUserId,
        displayName: record.displayName,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    },
  },
});

export const routeHelpers = createRouteHelpers(auth);
