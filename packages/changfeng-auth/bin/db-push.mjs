#!/usr/bin/env node
// ============================================================
// changfeng-auth db:push — 声明式数据库 Schema 同步 CLI
//
// 用法：
//   npx changfeng-auth db:push
//   DATABASE_URL=postgres://... npx changfeng-auth db:push
//
// 行为：
//   - 读取 DATABASE_URL 环境变量
//   - 连接 PostgreSQL
//   - 创建所有标准表（幂等：IF NOT EXISTS）
//   - 添加缺失的列（幂等：ADD COLUMN IF NOT EXISTS）
//
// 不执行：
//   - 不删除表或列（安全策略）
//   - 不修改已有列的类型
//   - 不执行数据迁移
// ============================================================

import { Pool } from "pg";

// ============================================================
// Schema Definition（与 Better Auth + changfeng-auth 保持一致）
// ============================================================

const TABLES = [
  {
    name: "user",
    columns: [
      { name: "id", type: "TEXT NOT NULL", pk: true },
      { name: "name", type: "TEXT NOT NULL" },
      { name: "email", type: "TEXT NOT NULL UNIQUE" },
      { name: "emailVerified", type: "BOOLEAN NOT NULL DEFAULT FALSE" },
      { name: "image", type: "TEXT" },
      { name: "createdAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
      { name: "updatedAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
    ],
  },
  {
    name: "session",
    columns: [
      { name: "id", type: "TEXT NOT NULL", pk: true },
      { name: "expiresAt", type: "TIMESTAMPTZ NOT NULL" },
      { name: "token", type: "TEXT NOT NULL UNIQUE" },
      { name: "createdAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
      { name: "updatedAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
      { name: "userId", type: "TEXT NOT NULL" },
      { name: "ipAddress", type: "TEXT" },
      { name: "userAgent", type: "TEXT" },
    ],
  },
  {
    name: "account",
    columns: [
      { name: "id", type: "TEXT NOT NULL", pk: true },
      { name: "accountId", type: "TEXT NOT NULL" },
      { name: "providerId", type: "TEXT NOT NULL" },
      { name: "userId", type: "TEXT NOT NULL" },
      { name: "accessToken", type: "TEXT" },
      { name: "refreshToken", type: "TEXT" },
      { name: "idToken", type: "TEXT" },
      { name: "accessTokenExpiresAt", type: "TIMESTAMPTZ" },
      { name: "refreshTokenExpiresAt", type: "TIMESTAMPTZ" },
      { name: "scope", type: "TEXT" },
      { name: "password", type: "TEXT" },
      { name: "createdAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
      { name: "updatedAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
    ],
  },
  {
    name: "verification",
    columns: [
      { name: "id", type: "TEXT NOT NULL", pk: true },
      { name: "identifier", type: "TEXT NOT NULL" },
      { name: "value", type: "TEXT NOT NULL" },
      { name: "expiresAt", type: "TIMESTAMPTZ NOT NULL" },
      { name: "createdAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
      { name: "updatedAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
    ],
  },
  {
    name: "businessAccount",
    columns: [
      { name: "id", type: "TEXT NOT NULL", pk: true },
      { name: "authUserId", type: "TEXT NOT NULL UNIQUE" },
      { name: "displayName", type: "TEXT NOT NULL" },
      { name: "status", type: "TEXT NOT NULL DEFAULT 'active'" },
      { name: "createdAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
      { name: "updatedAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
    ],
  },
  {
    name: "socialAccount",
    columns: [
      { name: "id", type: "TEXT NOT NULL", pk: true },
      { name: "userId", type: "TEXT NOT NULL" },
      { name: "provider", type: "TEXT NOT NULL" },
      { name: "providerOpenid", type: "TEXT NOT NULL" },
      { name: "accessToken", type: "TEXT" },
      { name: "refreshToken", type: "TEXT" },
      { name: "tokenExpiresAt", type: "TIMESTAMPTZ" },
      { name: "profileData", type: "JSONB NOT NULL DEFAULT '{}'" },
      { name: "valid", type: "INTEGER NOT NULL DEFAULT 0" },
      { name: "allowPasswordUpdate", type: "INTEGER NOT NULL DEFAULT 0" },
      { name: "allowVerification", type: "INTEGER NOT NULL DEFAULT 0" },
      { name: "createdAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
      { name: "updatedAt", type: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" },
    ],
  },
];

const UNIQUE_CONSTRAINTS: { table: string; columns: string[] }[] = [
  { table: "socialAccount", columns: ["provider", "providerOpenid"] },
];

// ============================================================
// Main
// ============================================================

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ 请设置 DATABASE_URL 环境变量");
    console.error("   示例: DATABASE_URL=postgres://user:pass@localhost:5432/mydb npx changfeng-auth db:push");
    process.exit(1);
  }

  console.log("🔧 changfeng-auth db:push v0.6.1");
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

    // 2. 为每张表执行 CREATE TABLE IF NOT EXISTS
    for (const table of TABLES) {
      const colDefs = table.columns.map((col) => {
        let def = `"${col.name}" ${col.type}`;
        if (col.pk) def += " PRIMARY KEY";
        return def;
      }).join(",\n    ");

      const sql = `CREATE TABLE IF NOT EXISTS "${table.name}" (\n    ${colDefs}\n  )`;
      await pool.query(sql);
      console.log(`✅ 表 "${table.name}" 已就绪`);

      // 3. 为表添加缺失的列（幂等）
      const { rows: existingCols } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table.name]
      );
      const existingNames = new Set(existingCols.map((c) => c.column_name));

      for (const col of table.columns) {
        if (!existingNames.has(col.name)) {
          try {
            await pool.query(
              `ALTER TABLE "${table.name}" ADD COLUMN "${col.name}" ${col.type}`
            );
            console.log(`   ↳ 新增列 "${table.name}"."${col.name}"`);
          } catch (err) {
            console.warn(`   ⚠️ 添加列 "${table.name}"."${col.name}" 失败: ${(err as Error).message}`);
          }
        }
      }
    }

    // 4. 创建唯一约束
    for (const uc of UNIQUE_CONSTRAINTS) {
      const colList = uc.columns.map((c) => `"${c}"`).join(", ");
      const constraintName = `${uc.table}_${uc.columns.join("_")}_key`;
      try {
        await pool.query(
          `ALTER TABLE "${uc.table}" ADD CONSTRAINT "${constraintName}" UNIQUE (${colList})`
        );
        console.log(`✅ 唯一约束 "${uc.table}".(${uc.columns.join(", ")}) 已创建`);
      } catch {
        // 约束已存在，忽略
      }
    }

    console.log("");
    console.log("🎉 数据库 Schema 同步完成！");

  } catch (err) {
    console.error("❌ 同步失败:", (err as Error).message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
