#!/usr/bin/env node
// ============================================================
// omni-auth db:push — 声明式数据库 Schema 同步 CLI
//
// 用法：
//   npx omni-auth db:push
//   DATABASE_URL=postgres://... npx omni-auth db:push
//
// 行为：
//   - 从 schema.ts（单一事实源）读取表定义
//   - 运行时生成 DDL 并执行
//   - 创建所有标准表（幂等：IF NOT EXISTS）
//   - 添加缺失的列（幂等：ADD COLUMN IF NOT EXISTS）
//   - 修正旧版遗留的全小写列名（RENAME）
//
// 不执行：
//   - 不删除表或列（安全策略）
//   - 不修改已有列的类型
//   - 不执行数据迁移
// ============================================================

import { Pool } from "pg";
import { schema } from "../dist/schema.js";
import { generateDDL } from "../dist/codegen-ddl.js";

// ============================================================
// Main
// ============================================================

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ 请设置 DATABASE_URL 环境变量");
    console.error("   示例: DATABASE_URL=postgres://user:pass@localhost:5432/mydb npx omni-auth db:push");
    process.exit(1);
  }

  console.log("🔧 omni-auth db:push v2.0.1");
  console.log(`   连接: ${databaseUrl.replace(/\/\/.*@/, "//***@")}`);
  console.log("");

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
  });

  try {
    // 1. 测试连接
    await pool.query("SELECT 1");
    console.log("✅ 数据库连接成功");

    // 2. 生成 DDL 并执行（CREATE TABLE IF NOT EXISTS + INDEX）
    const ddl = generateDDL(schema);
    const statements = ddl.split(";").filter((s) => s.trim());

    for (const stmt of statements) {
      await pool.query(stmt);
    }

    console.log(`✅ 已执行 ${statements.length} 条 DDL 语句`);

    // 3. 逐表检查并添加缺失的列（幂等）
    for (const table of Object.values(schema)) {
      const { rows: existingCols } = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table.name]
      );
      const existingNames = new Set(existingCols.map((c) => c.column_name));

      for (const [colName, col] of Object.entries(table.columns)) {
        if (existingNames.has(colName)) continue;

        // 旧版 schema 同步（列名未加引号）会把驼峰列折叠为全小写，
        // 导致读取字段失败（providerid ≠ providerId）。
        // 检测到小写变体时重命名列以保真大小写（RENAME 不丢数据）。
        const lowerVariant = colName.toLowerCase();
        if (existingNames.has(lowerVariant)) {
          try {
            await pool.query(
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
        const typeSQL = columnTypeToSQL(col._def.type);
        const parts = [typeSQL];
        if (col._def.required) parts.push("NOT NULL");
        if (col._def.default !== undefined) {
          parts.push(`DEFAULT ${defaultValueToSQL(col._def.default)}`);
        }

        try {
          await pool.query(
            `ALTER TABLE "${table.name}" ADD COLUMN "${colName}" ${parts.join(" ")}`
          );
          console.log(`   ↳ 新增列 "${table.name}"."${colName}"`);
        } catch (err) {
          console.warn(
            `   ⚠️ 添加列 "${table.name}"."${colName}" 失败: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    console.log("");
    console.log("🎉 数据库 Schema 同步完成！");
  } catch (err) {
    console.error("❌ 同步失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// ============================================================
// 辅助函数（与 codegen-ddl.ts 一致）
// ============================================================

function columnTypeToSQL(type) {
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

function defaultValueToSQL(value) {
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

main();
