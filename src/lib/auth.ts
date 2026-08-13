// ============================================================
// App 端 SDK 初始化
//
// createQuickAuth 一站式初始化认证 SDK：
// - 声明式 database 配置（SDK 内置 pg 驱动，零 ORM 依赖）
// - 仅负责凭证校验（用户是否存在 + 密码是否正确），不维护会话
// ============================================================

import { createQuickAuth } from "omni-auth/nextjs";

/** 应用基础 URL（CSRF 同源校验与 SDK 共用同一解析） */
export const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

export const auth = createQuickAuth({
  database: {
    url: process.env.DATABASE_URL!,
  },
  secret: process.env.BETTER_AUTH_SECRET ?? "changeme",
  baseUrl,
});
