#!/usr/bin/env node
// ============================================================
// omni-auth db:push — 声明式数据库 Schema 同步 CLI
//
// 行为与运行时 autoSync 完全同源（复用包内 schema-sync 实现）：
//   - 从 schema.ts（单一事实源）读取表定义
//   - 确保目标数据库存在（bootstrap）
//   - 幂等 DDL：CREATE TABLE IF NOT EXISTS + 索引
//   - 添加缺失的列（ADD COLUMN）+ 驼峰列名修复（RENAME）
//
// 不执行：删除表/列、修改列类型、数据迁移。
// ============================================================

import { Pool } from "pg";
import { syncSchema } from "../dist/schema-sync.js";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ 请设置 DATABASE_URL 环境变量");
    console.error("   示例: DATABASE_URL=postgres://user:pass@localhost:5432/mydb npx omni-auth db:push");
    process.exit(1);
  }

  console.log("🔧 omni-auth db:push");
  console.log(`   连接: ${databaseUrl.replace(/\/\/.*@/, "//***@")}`);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    // 测试连接
    await pool.query("SELECT 1");
    console.log("✅ 数据库连接成功");

    // 复用包内单一实现（bootstrap + DDL + 补列，幂等）
    const result = await syncSchema(pool, { databaseUrl, autoSync: true });

    if (result.addedColumns > 0) {
      console.log(`✅ 新增 ${result.addedColumns} 列`);
    }
    console.log("🎉 数据库 Schema 同步完成！");
  } catch (err) {
    console.error("❌ 同步失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
