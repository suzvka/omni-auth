/**
 * 数据库连接客户端（kit 统一抽象）
 *
 * 基于 yunzone-service-kit/db 的 SqlDb 契约（PgSqlDb 渠道适配器）：
 * - 凭证经 kit/config 的 resolveDatabaseUrl 按渠道解析（postgres → DATABASE_URL；
 *   coze → 平台注入 PGDATABASE_URL / PG* 变量组），禁止嗅探。
 * - 执行器单例挂在 globalThis，避免热重载重复建池（复用 user_center raw.ts 模式）。
 * - 表结构由 omni-auth 包 schema.ts 单一管理，sync.ts 直接执行幂等 DDL（无 Prisma）。
 */

import "server-only";

import { PgSqlDb } from "yunzone-service-kit/db";
import type { SqlDb } from "yunzone-service-kit/db";
import { resolveDatabaseUrl } from "yunzone-service-kit/config";
import { initializeDatabase } from "./sync";

const globalForDb = globalThis as unknown as {
  sqlDb: SqlDb | undefined;
  initDone: boolean | undefined;
};

function getDb(): SqlDb {
  if (!globalForDb.sqlDb) {
    const ssl =
      process.env.PGSSLMODE === "require" || process.env.PGSSLMODE === "verify-full"
        ? { rejectUnauthorized: false }
        : false;
    globalForDb.sqlDb = new PgSqlDb(resolveDatabaseUrl(), ssl ? { ssl } : undefined);
  }
  return globalForDb.sqlDb;
}

/**
 * 获取底层 pg 连接池引用（宿主注入场景：如传给 omni-auth 的
 * createQuickAuth({ database: { pool } })），实现单池共享。
 */
export function getPool(): ReturnType<PgSqlDb["getPool"]> {
  // getPool 是 PgSqlDb 类的扩展能力（SqlDb 接口不含），单例实际类型即 PgSqlDb
  return (getDb() as PgSqlDb).getPool();
}

// === 全前置初始化：库 bootstrap → schema 同步 ===
// top-level await 确保模块导出前 DB 100% 就绪；
// globalForDb.initDone 确保热重载时不会重复执行。
if (!globalForDb.initDone) {
  await initializeDatabase(getDb());
  globalForDb.initDone = true;
}
