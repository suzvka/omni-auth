// ============================================================
// 数据库初始化（无 Prisma）
//
// 表结构由 omni-auth 的 schema.ts 单一管理：
//   - 建表 / 加列：运行时基于 schema 生成幂等 DDL 直接执行（IF NOT EXISTS）
//   - 与 CLI `npx omni-auth db:push` 同源逻辑（codegen-ddl.ts），
//     但连接凭证走 kit resolveDatabaseUrl 渠道解析（coze 渠道可用）。
//
// 本模块负责：
//   1. 确保目标数据库存在（bootstrap，连 postgres 默认库检查/创建）
//   2. 执行 DDL 同步（建表 + 列修正/新增，幂等，不删表不删列）
// ============================================================

import { Pool } from "pg";
import { schema } from "omni-auth/schema";
import { generateDDL } from "omni-auth/codegen-ddl";
import type { SqlDb } from "yunzone-service-kit/db";
import { resolveDatabaseUrl } from "yunzone-service-kit/config";

/** 是否允许自动建库/建表（AUTO_SYNC_DB=false 时仅检查并警告） */
const autoSync = process.env.AUTO_SYNC_DB !== "false";

// ============================================================
// 阶段 0：确保目标库存在（连接 postgres 默认库做检查）
// ============================================================

function getTargetDbName(dbUrl: string): string {
  return new URL(dbUrl).pathname.replace(/^\//, "") || "postgres";
}

function buildBootstrapUrl(dbUrl: string): string {
  const url = new URL(dbUrl);
  url.pathname = "/postgres";
  return url.toString();
}

async function ensureDatabase(dbUrl: string): Promise<void> {
  const dbName = getTargetDbName(dbUrl);
  const bootstrapUrl = buildBootstrapUrl(dbUrl);

  console.log(`[DB Bootstrap] Checking database "${dbName}"...`);

  // 用 postgres 默认库建立临时连接（单连接，用完即弃）
  const pool = new Pool({ connectionString: bootstrapUrl, max: 1 });

  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );

    if (rows.length === 0) {
      console.log(`[DB Bootstrap] Database "${dbName}" not found.`);
      if (autoSync) {
        // CREATE DATABASE 不支持参数化，dbName 来自解析后的连接 URL，安全
        await pool.query(`CREATE DATABASE "${dbName}"`);
        console.log(`[DB Bootstrap] Created database "${dbName}".`);
      } else {
        console.log(`[DB Bootstrap] [DRY-RUN] Would create database "${dbName}".`);
      }
    } else {
      console.log(`[DB Bootstrap] Database "${dbName}" already exists.`);
    }
  } finally {
    await pool.end();
  }
}

// ============================================================
// 阶段 1：DDL 同步（建表 + 列修正/新增，幂等）
// ============================================================

function columnTypeToSQL(type: string): string {
  switch (type) {
    case "text":
      return "TEXT";
    case "boolean":
      return "BOOLEAN";
    case "integer":
      return "INTEGER";
    case "jsonb":
      return "JSONB";
    case "timestamptz":
      return "TIMESTAMPTZ";
    case "timestamp":
      return "TIMESTAMP";
    default:
      return type.toUpperCase();
  }
}

function defaultValueToSQL(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") {
    if (value === "NOW()" || value === "CURRENT_TIMESTAMP") {
      return value;
    }
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    return `'${JSON.stringify(value)}'::jsonb`;
  }
  return String(value);
}

async function syncSchema(db: SqlDb): Promise<void> {
  // 1. 执行生成 DDL（CREATE TABLE IF NOT EXISTS + 索引，幂等）
  const ddl = generateDDL(schema);
  const statements = ddl.split(";").filter((s) => s.trim());
  for (const stmt of statements) {
    await db.execute(stmt);
  }
  console.log(`[DB Sync] 已执行 ${statements.length} 条 DDL 语句`);

  // 2. 逐表检查并添加缺失的列（幂等；旧版全小写列名修正为驼峰保真）
  let added = 0;
  for (const table of Object.values(schema)) {
    const rows = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table.name]
    );
    const existingNames = new Set(rows.map((r) => r.column_name));

    for (const [colName, col] of Object.entries(table.columns)) {
      if (existingNames.has(colName)) continue;

      // 旧版 schema 同步（列名未加引号）会把驼峰列折叠为全小写，
      // 检测到小写变体时重命名列以保真大小写（RENAME 不丢数据）。
      const lowerVariant = colName.toLowerCase();
      if (existingNames.has(lowerVariant)) {
        try {
          await db.execute(
            `ALTER TABLE "${table.name}" RENAME COLUMN "${lowerVariant}" TO "${colName}"`
          );
          console.log(`   ↳ 修正列名大小写 "${table.name}"."${lowerVariant}" → "${colName}"`);
          existingNames.delete(lowerVariant);
          existingNames.add(colName);
          continue;
        } catch (err) {
          console.warn(
            `   ⚠️ 修正列名 "${table.name}"."${lowerVariant}" 失败: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
      }

      // 真正缺失 → ADD COLUMN
      const def = col._def;
      const parts = [columnTypeToSQL(def.type)];
      if (def.required) parts.push("NOT NULL");
      if (def.default !== undefined) {
        parts.push(`DEFAULT ${defaultValueToSQL(def.default)}`);
      }

      try {
        await db.execute(
          `ALTER TABLE "${table.name}" ADD COLUMN "${colName}" ${parts.join(" ")}`
        );
        added += 1;
        console.log(`   ↳ 新增列 "${table.name}"."${colName}"`);
      } catch (err) {
        console.warn(
          `   ⚠️ 添加列 "${table.name}"."${colName}" 失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  console.log(
    added > 0
      ? `[DB Sync] 已新增 ${added} 列`
      : `[DB Sync] 全部 ${Object.keys(schema).length} 张认证表就绪。`
  );
}

// ============================================================
// 初始化入口：库 bootstrap → schema 同步
// ============================================================

export async function initializeDatabase(db: SqlDb): Promise<void> {
  const dbUrl = resolveDatabaseUrl();

  // 阶段 0：确保库存在
  await ensureDatabase(dbUrl);

  // 阶段 1：schema 同步（autoSync=false 时仅检查缺表并警告）
  if (!autoSync) {
    const expected = Object.values(schema).map((t) => t.name);
    const rows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const existing = new Set(rows.map((r) => r.table_name));
    const missing = expected.filter((t) => !existing.has(t));
    if (missing.length > 0) {
      console.warn(
        `[DB Check] 缺少表: ${missing.join(", ")}。请运行 npx omni-auth db:push 或设置 AUTO_SYNC_DB=true。`
      );
    } else {
      console.log(`[DB Check] 全部 ${expected.length} 张认证表就绪。`);
    }
  } else {
    await syncSchema(db);
  }

  console.log("[DB Init] Initialization complete.");
}
