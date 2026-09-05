// ============================================================
// Schema 同步 — 自动建表/迁移的包内单一实现
//
// 认证域表结构由 schema.ts 单一管理，本模块负责将 schema 同步到数据库：
//   1. bootstrap：确保目标数据库存在（连接 postgres 默认库检查/创建）
//   2. DDL 同步：CREATE TABLE IF NOT EXISTS + 索引（幂等）
//   3. 列修正：缺失列 ADD COLUMN；旧版全小写列名 RENAME 保真
//
// 安全策略：
//   - 不删除表或列
//   - 不修改已有列的类型
//   - 不执行数据迁移
//
// 入参为宿主注入的连接池（PgPoolLike），不走 DATABASE_URL——
// 渠道差异（postgres / coze）由宿主的凭证解析层消化，本模块不感知。
// ============================================================

import type { PgPoolLike } from "./builtin/pg/adapter";
import { schema } from "./schema";
import { generateDDL } from "./codegen-ddl";
import type { Schema, TableDef, ColumnBuilder } from "./schema-builder";

export interface SyncSchemaOptions {
  /** 目标库连接串（可选）。提供时先执行 bootstrap（连 postgres 默认库检查/创建目标库） */
  databaseUrl?: string;
  /** 是否执行自动同步；false 时仅检查缺表并返回（不写库） */
  autoSync?: boolean;
}

export interface SyncSchemaResult {
  /** 是否执行了写入 */
  synced: boolean;
  /** 缺表列表（autoSync=false 时检测） */
  missingTables: string[];
  /** 新增列数（autoSync=true 时统计） */
  addedColumns: number;
}

// ============================================================
// 阶段 0：确保目标库存在（bootstrap）
// ============================================================

function getTargetDbName(dbUrl: string): string {
  return new URL(dbUrl).pathname.replace(/^\//, "") || "postgres";
}

function buildBootstrapUrl(dbUrl: string): string {
  const url = new URL(dbUrl);
  url.pathname = "/postgres";
  return url.toString();
}

/** 用独立单连接连 postgres 默认库检查/创建目标库（避免占用注入池的连接） */
async function ensureDatabase(databaseUrl: string): Promise<void> {
  const dbName = getTargetDbName(databaseUrl);
  const bootstrapUrl = buildBootstrapUrl(databaseUrl);

  const pool = new (await import("pg")).Pool({ connectionString: bootstrapUrl, max: 1 });

  try {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT 1 AS exists FROM pg_database WHERE datname = $1`,
      [dbName]
    );

    if (rows.length === 0) {
      // CREATE DATABASE 不支持参数化，dbName 来自解析后的连接 URL，安全
      await pool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`[omni-auth] 已创建数据库 "${dbName}"`);
    }
  } finally {
    await pool.end();
  }
}

// ============================================================
// 阶段 1：DDL 同步（建表 + 列修正，幂等）
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

/** 对注入池执行单条语句；返回受影响行数 */
async function run(pool: PgPoolLike, sql: string): Promise<void> {
  await pool.query(sql);
}

/** 逐表检查并添加缺失的列（幂等；旧版全小写列名修正为驼峰保真） */
async function syncColumns(pool: PgPoolLike, tables: TableDef[]): Promise<number> {
  let added = 0;

  for (const tableDef of tables) {
    const { rows } = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [tableDef.name]
    )) as { rows: Array<{ column_name: string }> };
    const existingNames = new Set(rows.map((r) => r.column_name));

    for (const [colName, col] of Object.entries(tableDef.columns)) {
      if (existingNames.has(colName)) continue;

      // 旧版 schema 同步（列名未加引号）会把驼峰列折叠为全小写，
      // 检测到小写变体时重命名列以保真大小写（RENAME 不丢数据）。
      const lowerVariant = colName.toLowerCase();
      if (existingNames.has(lowerVariant)) {
        try {
          await run(pool, `ALTER TABLE "${tableDef.name}" RENAME COLUMN "${lowerVariant}" TO "${colName}"`);
          console.log(`   ↳ 修正列名大小写 "${tableDef.name}"."${lowerVariant}" → "${colName}"`);
          existingNames.delete(lowerVariant);
          existingNames.add(colName);
          continue;
        } catch (err) {
          console.warn(
            `   ⚠️ 修正列名 "${tableDef.name}"."${lowerVariant}" 失败: ${err instanceof Error ? err.message : String(err)}`
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
        await run(pool, `ALTER TABLE "${tableDef.name}" ADD COLUMN "${colName}" ${parts.join(" ")}`);
        added += 1;
        console.log(`   ↳ 新增列 "${tableDef.name}"."${colName}"`);
      } catch (err) {
        console.warn(
          `   ⚠️ 添加列 "${tableDef.name}"."${colName}" 失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return added;
}

/** 仅检查缺表（不写库），返回缺失表名列表 */
async function findMissingTables(pool: PgPoolLike): Promise<string[]> {
  const { rows } = (await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  )) as { rows: Array<{ table_name: string }> };
  const existing = new Set(rows.map((r) => r.table_name));
  return Object.values(schema)
    .map((t) => t.name)
    .filter((name) => !existing.has(name));
}

// ============================================================
// 入口
// ============================================================

/**
 * 同步认证域 schema 到数据库（幂等）。
 *
 * - autoSync=true（默认）：bootstrap（可选）→ 执行 DDL → 补列
 * - autoSync=false：仅检查缺表并警告，不写库
 *
 * @returns 同步结果（是否写入、缺表列表、新增列数）
 */
export async function syncSchema(
  pool: PgPoolLike,
  opts: SyncSchemaOptions = {}
): Promise<SyncSchemaResult> {
  const autoSync = opts.autoSync ?? true;

  // 连接串兜底：未显式传入时读标准 env（宿主无需感知渠道细节）
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL ?? process.env.PGDATABASE_URL;

  if (databaseUrl) {
    await ensureDatabase(databaseUrl);
  }

  if (!autoSync) {
    const missing = await findMissingTables(pool);
    return { synced: false, missingTables: missing, addedColumns: 0 };
  }

  // 1. 执行生成 DDL（CREATE TABLE IF NOT EXISTS + 索引，幂等）
  //    建表语句失败视为真实错误（中断）；索引创建失败仅警告（历史数据重复等场景不阻断）
  const ddl = generateDDL(schema);
  const statements = ddl.split(";").filter((s) => s.trim());
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    const isCreateTable = /^CREATE TABLE/i.test(trimmed);
    try {
      await run(pool, trimmed);
    } catch (err) {
      if (isCreateTable) {
        throw err;
      }
      console.warn(
        `[omni-auth] 索引语句执行失败（跳过）: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 2. 逐表检查并添加缺失的列（幂等；含小写折叠 RENAME 修复）
  const addedColumns = await syncColumns(pool, Object.values(schema));

  console.log(
    `[omni-auth] Schema 同步完成：${Object.keys(schema).length} 张认证表就绪` +
      (addedColumns > 0 ? `，新增 ${addedColumns} 列` : "")
  );

  return { synced: true, missingTables: [], addedColumns };
}

// 导出类型辅助（供 CLI 复用）
export type { Schema, TableDef, ColumnBuilder };
