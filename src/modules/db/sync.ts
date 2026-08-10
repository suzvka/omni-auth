import type { PrismaClient } from "@prisma/client";
import schemaDeclaration from "./schema.declarative.json";

// ============================================================
// 类型定义
// ============================================================

export interface ColumnDecl {
  name: string;
  type: string;
  required?: boolean;
  default?: string;
  unique?: boolean;
}

export interface TableDecl {
  name: string;
  columns: ColumnDecl[];
  primaryKey?: string[];
  uniqueGroups?: string[][];
}

export interface SchemaDeclaration {
  database: string;
  version: number;
  tables: TableDecl[];
}

interface ExistingColumn {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
}

interface ExistingTable {
  table_name: string;
}

interface SyncReport {
  tablesCreated: string[];
  columnsAdded: { table: string; column: string }[];
  uniqueIndexesCreated: string[];
  mismatches: string[];
}

// ============================================================
// 类型映射：将 information_schema 返回的 data_type 归一化
// ============================================================

function normalizePgType(dataType: string): string {
  const lower = dataType.toLowerCase();
  // timestamp with time zone -> timestamptz
  if (lower === "timestamp with time zone") return "timestamptz";
  if (lower === "timestamp without time zone") return "timestamp";
  if (lower === "character varying") return "varchar";
  if (lower === "character") return "char";
  return lower;
}

// ============================================================
// DDL 生成
// ============================================================

function buildColumnDef(col: ColumnDecl): string {
  const parts: string[] = [`"${col.name}"`, col.type];

  if (col.required) {
    parts.push("NOT NULL");
  }

  if (col.default !== undefined) {
    parts.push(`DEFAULT ${col.default}`);
  }

  return parts.join(" ");
}

function buildCreateTableSQL(table: TableDecl): string {
  const colDefs = table.columns.map(buildColumnDef);

  if (table.primaryKey && table.primaryKey.length > 0) {
    const pkCols = table.primaryKey.map((c) => `"${c}"`).join(", ");
    colDefs.push(`PRIMARY KEY (${pkCols})`);
  }

  return `CREATE TABLE IF NOT EXISTS "${table.name}" (\n  ${colDefs.join(",\n  ")}\n);`;
}

function buildAddColumnSQL(tableName: string, col: ColumnDecl): string {
  return `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS ${buildColumnDef(col)};`;
}

function buildUniqueIndexSQL(tableName: string, colName: string): string {
  const idxName = `${tableName}_${colName}_key`;
  return `CREATE UNIQUE INDEX IF NOT EXISTS "${idxName}" ON "${tableName}" ("${colName}");`;
}

function buildCompositeUniqueIndexSQL(
  tableName: string,
  columns: string[]
): string {
  const idxName = `${tableName}_${columns.join("_")}_key`;
  const colList = columns.map((c) => `"${c}"`).join(", ");
  return `CREATE UNIQUE INDEX IF NOT EXISTS "${idxName}" ON "${tableName}" (${colList});`;
}

// ============================================================
// 自省：查询 information_schema
// ============================================================

async function fetchExistingTables(
  client: PrismaClient
): Promise<Set<string>> {
  const rows = (await client.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  )) as ExistingTable[];
  return new Set(rows.map((r: ExistingTable) => r.table_name));
}

async function fetchExistingColumns(
  client: PrismaClient,
  tableName: string
): Promise<Map<string, ExistingColumn>> {
  const rows = (await client.$queryRawUnsafe(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    tableName
  )) as ExistingColumn[];
  const map = new Map<string, ExistingColumn>();
  for (const row of rows) {
    map.set(row.column_name, row);
  }
  return map;
}

async function fetchExistingUniqueIndexes(
  client: PrismaClient,
  tableName: string
): Promise<{ singleCols: Set<string>; compositeGroups: Set<string> }> {
  // 查询该表上所有唯一约束涉及的列
  const rows = (await client.$queryRawUnsafe(
    `SELECT kcu.column_name, tc.constraint_name, tc.constraint_type
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')
       AND tc.table_schema = 'public'
       AND tc.table_name = $1
     ORDER BY tc.constraint_name, kcu.ordinal_position`,
    tableName
  )) as { column_name: string; constraint_name: string; constraint_type: string }[];

  // 按 constraint_name 聚合列，区分 single 和 composite
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    if (row.constraint_type === "PRIMARY KEY") continue;
    if (!groups.has(row.constraint_name)) {
      groups.set(row.constraint_name, []);
    }
    groups.get(row.constraint_name)!.push(row.column_name);
  }

  const singleCols = new Set<string>();
  const compositeGroups = new Set<string>();
  for (const cols of groups.values()) {
    if (cols.length === 1) {
      singleCols.add(cols[0]);
    } else {
      compositeGroups.add(cols.join(","));
    }
  }
  return { singleCols, compositeGroups };
}

// ============================================================
// URL 工具：将 DATABASE_URL 中的库名替换为 postgres（bootstrap 用）
// ============================================================

function buildBootstrapUrl(dbUrl: string): string {
  // 格式: postgresql://user:password@host:port/dbname?params
  // 如果缺少 dbname，补上 /postgres 作为 bootstrap 库
  const url = new URL(dbUrl);
  url.pathname = "/postgres";
  return url.toString();
}

// ============================================================
// 阶段 0：确保目标库存在（连接 postgres 默认库做检查）
// ============================================================

async function ensureDatabase(
  dbName: string
): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is required for database bootstrap.");
  }

  const autoSync = process.env.AUTO_SYNC_DB !== "false";
  const bootstrapUrl = buildBootstrapUrl(dbUrl);

  console.log(`[DB Bootstrap] Checking database "${dbName}"...`);

  // 用 postgres 默认库建立临时连接
  const { PrismaClient } = await import("@prisma/client");
  const bootstrapClient = new PrismaClient({
    datasources: { db: { url: bootstrapUrl } },
    log: ["warn", "error"],
  });

  try {
    const rows = (await bootstrapClient.$queryRawUnsafe(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      dbName
    )) as unknown[];

    if (rows.length === 0) {
      console.log(
        `[DB Bootstrap] Database "${dbName}" not found — creating.`
      );
      if (autoSync) {
        // CREATE DATABASE 不支持参数化，这里 dbName 来自声明文件，安全
        await bootstrapClient.$queryRawUnsafe(
          `CREATE DATABASE "${dbName}"`
        );
        console.log(`[DB Bootstrap] Created database "${dbName}".`);
      } else {
        console.log(
          `[DB Bootstrap] [DRY-RUN] Would create database "${dbName}".`
        );
      }
    } else {
      console.log(`[DB Bootstrap] Database "${dbName}" already exists.`);
    }
  } finally {
    await bootstrapClient.$disconnect();
  }
}

// ============================================================
// 全链初始化：库 → 表 → 列 → 索引（一次性全部完成）
// ============================================================

export async function initializeDatabase(
  client: PrismaClient
): Promise<void> {
  const declared = schemaDeclaration as SchemaDeclaration;

  console.log(
    `[DB Init] Starting full initialization for database "${declared.database}"...`
  );

  // 阶段 0：确保库存在
  await ensureDatabase(declared.database);

  // 阶段 1：确保表结构符合声明
  await ensureDatabaseSchema(client);

  console.log(`[DB Init] Full initialization complete.`);
}

// ============================================================
// 阶段 1：确保表/列/索引符合声明（内部函数，由 initializeDatabase 调用）
// ============================================================

export async function ensureDatabaseSchema(
  client: PrismaClient
): Promise<SyncReport> {
  const report: SyncReport = {
    tablesCreated: [],
    columnsAdded: [],
    uniqueIndexesCreated: [],
    mismatches: [],
  };

  const autoSync = process.env.AUTO_SYNC_DB !== "false";
  const declared = schemaDeclaration as SchemaDeclaration;

  console.log(
    `[DB Sync] Declared schema v${declared.version}, ${declared.tables.length} tables. AUTO_SYNC_DB=${autoSync}`
  );

  const existingTables = await fetchExistingTables(client);

  for (const table of declared.tables) {
    const tableExists = existingTables.has(table.name);

    if (!tableExists) {
      // --- 表不存在：创建整张表 ---
      const sql = buildCreateTableSQL(table);
      console.log(`[DB Sync] Table "${table.name}" missing — creating.`);
      if (autoSync) {
        await client.$queryRawUnsafe(sql);
        report.tablesCreated.push(table.name);
        console.log(`[DB Sync] Created table "${table.name}".`);
      } else {
        console.log(`[DB Sync] [DRY-RUN] Would create table "${table.name}".`);
      }
    } else {
      // --- 表存在：逐列检查 ---
      const existingCols = await fetchExistingColumns(client, table.name);
      const { singleCols: existingUniqueCols, compositeGroups: existingCompositeGroups } =
        await fetchExistingUniqueIndexes(client, table.name);

      // 复合唯一索引检查
      if (table.uniqueGroups) {
        for (const group of table.uniqueGroups) {
          const groupKey = group.join(",");
          if (!existingCompositeGroups.has(groupKey)) {
            const sql = buildCompositeUniqueIndexSQL(table.name, group);
            const idxName = `${table.name}_${group.join("_")}_key`;
            console.log(
              `[DB Sync] Composite unique index "${idxName}" missing — creating.`
            );
            if (autoSync) {
              await client.$queryRawUnsafe(sql);
              report.uniqueIndexesCreated.push(idxName);
              console.log(`[DB Sync] Created composite unique index "${idxName}".`);
            } else {
              console.log(
                `[DB Sync] [DRY-RUN] Would create composite unique index "${idxName}".`
              );
            }
          }
        }
      }

      for (const col of table.columns) {
        const existing = existingCols.get(col.name);

        if (!existing) {
          // 列缺失：先检查旧版同步（列名未加引号）产生的全小写变体，
          // 存在则重命名以保真大小写（RENAME 不丢数据），避免新旧列并存。
          const lowerVariant = col.name.toLowerCase();
          const lowerExisting = existingCols.get(lowerVariant);
          if (lowerExisting) {
            console.log(
              `[DB Sync] Column "${table.name}"."${lowerVariant}" is lowercase variant of "${col.name}" — renaming.`
            );
            if (autoSync) {
              try {
                await client.$queryRawUnsafe(
                  `ALTER TABLE "${table.name}" RENAME COLUMN "${lowerVariant}" TO "${col.name}"`
                );
                report.columnsAdded.push({ table: table.name, column: col.name });
                console.log(
                  `[DB Sync] Renamed "${table.name}"."${lowerVariant}" → "${col.name}".`
                );
                existingCols.delete(lowerVariant);
                existingCols.set(col.name, { ...lowerExisting, column_name: col.name });
              } catch (err) {
                const msg = `Rename "${table.name}"."${lowerVariant}" failed: ${err instanceof Error ? err.message : String(err)}`;
                console.warn(`[DB Sync] ${msg}`);
                report.mismatches.push(msg);
              }
            } else {
              console.log(
                `[DB Sync] [DRY-RUN] Would rename "${table.name}"."${lowerVariant}" → "${col.name}".`
              );
            }
            continue;
          }

          // 真正缺失 → 添加
          const sql = buildAddColumnSQL(table.name, col);
          console.log(
            `[DB Sync] Column "${table.name}"."${col.name}" missing — adding.`
          );
          if (autoSync) {
            await client.$queryRawUnsafe(sql);
            report.columnsAdded.push({ table: table.name, column: col.name });
            console.log(
              `[DB Sync] Added column "${table.name}"."${col.name}".`
            );
          } else {
            console.log(
              `[DB Sync] [DRY-RUN] Would add column "${table.name}"."${col.name}".`
            );
          }
        } else {
          // 列存在 → 检查类型、可空性、默认值是否一致
          const declaredType = col.type;
          const actualType = normalizePgType(existing.data_type);
          if (declaredType !== actualType) {
            const msg = `Column "${table.name}"."${col.name}": declared type "${declaredType}" but DB has "${actualType}"`;
            console.warn(`[DB Sync] MISMATCH: ${msg}`);
            report.mismatches.push(msg);
          }

          const declaredRequired = col.required === true;
          const actualNullable = existing.is_nullable === "YES";
          if (declaredRequired && actualNullable) {
            const msg = `Column "${table.name}"."${col.name}": declared NOT NULL but DB allows NULL`;
            console.warn(`[DB Sync] MISMATCH: ${msg}`);
            report.mismatches.push(msg);
          }
        }

        // 唯一约束检查
        if (col.unique && !existingUniqueCols.has(col.name)) {
          const sql = buildUniqueIndexSQL(table.name, col.name);
          console.log(
            `[DB Sync] Unique index for "${table.name}"."${col.name}" missing — creating.`
          );
          if (autoSync) {
            await client.$queryRawUnsafe(sql);
            report.uniqueIndexesCreated.push(
              `${table.name}_${col.name}_key`
            );
            console.log(
              `[DB Sync] Created unique index for "${table.name}"."${col.name}".`
            );
          } else {
            console.log(
              `[DB Sync] [DRY-RUN] Would create unique index for "${table.name}"."${col.name}".`
            );
          }
        }
      }
    }
  }

  // 汇总日志
  const total =
    report.tablesCreated.length +
    report.columnsAdded.length +
    report.uniqueIndexesCreated.length;

  if (total > 0) {
    console.log(
      `[DB Sync] Done. Created ${report.tablesCreated.length} table(s), added ${report.columnsAdded.length} column(s), ${report.uniqueIndexesCreated.length} unique index(es).`
    );
  } else {
    console.log(`[DB Sync] Database matches declaration. Nothing to do.`);
  }

  if (report.mismatches.length > 0) {
    console.warn(
      `[DB Sync] ${report.mismatches.length} type/nullability mismatch(es) detected (not auto-fixed).`
    );
  }

  return report;
}
