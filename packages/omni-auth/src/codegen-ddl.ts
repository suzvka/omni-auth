// ============================================================
// DDL 生成器
//
// 从 schema.ts 的表定义生成 PostgreSQL DDL（幂等：IF NOT EXISTS）
// 由 bin/db-push.mjs 在运行时调用
// ============================================================

import type { Schema, TableDef, ColumnBuilder } from "./schema-builder";

// ----------------------------------------------------------
// 列类型 → SQL 类型
// ----------------------------------------------------------

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

// ----------------------------------------------------------
// 默认值 → SQL 表达式
// ----------------------------------------------------------

function defaultValueToSQL(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") {
    // 特殊标记：NOW() 等 SQL 函数不加引号
    if (value === "NOW()" || value === "CURRENT_TIMESTAMP") {
      return value;
    }
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    // JSONB 默认值：转为 JSON 字符串
    return `'${JSON.stringify(value)}'::jsonb`;
  }
  return String(value);
}

// ----------------------------------------------------------
// 列定义 → SQL 片段
// ----------------------------------------------------------

function buildColumnDef(colName: string, col: ColumnBuilder): string {
  const parts: string[] = [`"${colName}"`, columnTypeToSQL(col._def.type)];

  if (col._def.required) {
    parts.push("NOT NULL");
  }

  if (col._def.default !== undefined) {
    parts.push(`DEFAULT ${defaultValueToSQL(col._def.default)}`);
  }

  return parts.join(" ");
}

// ----------------------------------------------------------
// 单表 → CREATE TABLE
// ----------------------------------------------------------

function buildCreateTableSQL(table: TableDef): string {
  const colDefs: string[] = [];

  for (const [colName, col] of Object.entries(table.columns)) {
    colDefs.push(buildColumnDef(colName, col));
  }

  // 主键
  const pkCols = Object.entries(table.columns)
    .filter(([, col]) => col._def.primaryKey)
    .map(([colName]) => `"${colName}"`);

  if (pkCols.length > 0) {
    colDefs.push(`PRIMARY KEY (${pkCols.join(", ")})`);
  }

  let sql = `CREATE TABLE IF NOT EXISTS "${table.name}" (\n  ${colDefs.join(",\n  ")}\n);`;

  // 单列唯一约束
  for (const [colName, col] of Object.entries(table.columns)) {
    if (col._def.unique && !col._def.primaryKey) {
      sql += `\nCREATE UNIQUE INDEX IF NOT EXISTS "${table.name}_${colName}_key" ON "${table.name}" ("${colName}");`;
    }
  }

  // 复合唯一约束
  if (table.uniqueConstraints) {
    for (const group of table.uniqueConstraints) {
      const idxName = `${table.name}_${group.join("_")}_key`;
      const colList = group.map((c) => `"${c}"`).join(", ");
      sql += `\nCREATE UNIQUE INDEX IF NOT EXISTS "${idxName}" ON "${table.name}" (${colList});`;
    }
  }

  return sql;
}

// ----------------------------------------------------------
// Schema → 完整 DDL
// ----------------------------------------------------------

/**
 * 断言 schema 变量名与物理表名一致（单一标识符约束）。
 *
 * 运行时查询层（createDbFacade / adapter）直接以 model 名（schema 变量名）
 * 拼 SQL，因此 table() 的物理表名必须与之相同；若二者分道扬镳，
 * autoSync / db:push 建出的表与运行时查询的表不是同一张（5.1.2 回归教训），
 * 此处 fail-fast 防止再次发生。
 */
export function assertConsistentTableNames(schema: Schema): void {
  for (const [model, tableDef] of Object.entries(schema)) {
    if (model !== tableDef.name) {
      throw new Error(
        `[omni-auth] schema 变量名与物理表名不一致: model="${model}" table()="${tableDef.name}"。` +
          `物理表名必须与 model 名相同（运行时直接以 model 名拼 SQL）。`
      );
    }
  }
}

/** 从 schema 对象生成完整 DDL（所有表的 CREATE TABLE + INDEX） */
export function generateDDL(schema: Schema): string {
  assertConsistentTableNames(schema);

  const statements: string[] = [];

  for (const table of Object.values(schema)) {
    statements.push(buildCreateTableSQL(table));
  }

  return statements.join("\n\n") + "\n";
}
