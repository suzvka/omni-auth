// ============================================================
// App 侧 SDK 初始化
//
// createQuickAuth 一站式初始化认证 SDK：
// - 注入式 database 配置（连接池由本应用 modules/db/client 提供，
//   基于 kit SqlDb 单例，凭证经 resolveDatabaseUrl 渠道解析）
// - 仅负责凭证校验（用户是否存在 + 密码是否正确），不维护会话
// ============================================================

import { createQuickAuth } from "omni-auth/nextjs";
import { resolveBaseUrl } from "yunzone-service-kit/config";
import { getPool } from "@/modules/db/client";

/** 应用基础 URL（CSRF 同源校验、SDK 共用同一解析链） */
export const baseUrl = resolveBaseUrl();

export const auth = createQuickAuth({
  database: {
    pool: getPool(),
  },
  secret: process.env.BETTER_AUTH_SECRET ?? "changeme",
  baseUrl,
});
