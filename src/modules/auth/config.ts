import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma, businessAccountRepo } from "@/modules/db";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    // 密码策略：使用 Better Auth 默认规则（首版不做特殊要求）
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 天
    updateAge: 60 * 60 * 24,     // 每天刷新一次
    rememberMe: {
      expiresIn: 60 * 60 * 24 * 30, // 记住我：30 天
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // 注册回调失败会向上抛错，Better Auth 会回滚注册
          await businessAccountRepo.create({
            authUserId: user.id,
            displayName: user.email ?? user.id,
            status: "active",
          });
        },
      },
    },
  },
});
