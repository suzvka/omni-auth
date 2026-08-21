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

// 单例模式：防止 Next.js 热更新时创建多个 auth 实例
const globalForAuth = globalThis as unknown as {
  auth: ReturnType<typeof createQuickAuth> | undefined;
};

function createAuthInstance(): ReturnType<typeof createQuickAuth> {
  const instance = createQuickAuth({
    // 连接池宿主注入：凭证经 kit resolveDatabaseUrl 统一解析（modules/db/client）
    database: {
      pool: getPool(),
    },
    // 自动建表/迁移：认证域表结构由 omni-auth 包内 schema 单一管理，幂等同步
    autoSync: true,
    secret: process.env.BETTER_AUTH_SECRET ?? "changeme",
    baseUrl,
  });
  return instance;
}

/** 懒加载：仅在首次访问 auth 属性时创建实例，避免构建时触发数据库连接 */
function getAuthInstance(): ReturnType<typeof createQuickAuth> {
  if (!globalForAuth.auth) {
    globalForAuth.auth = createAuthInstance();
  }
  return globalForAuth.auth;
}

/**
 * 通过 Proxy 实现惰性初始化。
 * 构建时 `import { auth }` 只创建 Proxy，不触发 `createAuthInstance()`。
 * 运行时首次访问 `auth.xxx` 时才创建实例并调用 `getPool()`。
 */
export const auth = new Proxy({} as ReturnType<typeof createQuickAuth>, {
  get(_, prop) {
    const instance = getAuthInstance();
    // 通过 Record 索引收紧动态访问类型（instance 类型未暴露属性索引签名）
    const value = (instance as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
  },
  has(_, prop) {
    return prop in getAuthInstance();
  },
  ownKeys() {
    return Reflect.ownKeys(getAuthInstance());
  },
  getOwnPropertyDescriptor() {
    return {
      enumerable: true,
      configurable: true,
    };
  },
});
