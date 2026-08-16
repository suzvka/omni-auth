#!/usr/bin/env node
// ============================================================
// omni-auth v5.0.0 迁移 — 渠道化两表模型
//
// 背景：5.0.0 删除 account 表与 user.email 邮箱锚点；
//   密码以共享语义上移至 user.password；邮箱降级为普通渠道
//   （provider="email", providerOpenid=邮箱地址）。
//
// 用法：
//   DATABASE_URL=postgres://... node packages/omni-auth/bin/migrate-v5.mjs
//   DATABASE_URL=postgres://... node packages/omni-auth/bin/migrate-v5.mjs --dry-run
//
// 步骤（全部包入事务，失败整体回滚）：
//   1. 密码搬移：credential account.password → user.password
//   2. 补建 email 渠道：真实邮箱用户（占位邮箱 @oauth.usercenter 跳过，
//      其渠道身份已在 socialAccount）→ INSERT (email, 邮箱地址, valid=1)
//   3. DROP TABLE account（数据已搬移）
//   4. ALTER TABLE "user" DROP COLUMN email（含 user_email_key 索引）
//
// 要求：PostgreSQL 13+（gen_random_uuid 内置）。
// 执行前请备份数据库，并先以 --dry-run 核对生成的 SQL。
// ============================================================

import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.argv.includes("--dry-run");

const SQL_STEPS = [
  {
    name: "1/4 密码搬移: account.password → user.password（credential 账户）",
    sql: `UPDATE "user"
SET password = a.password, "updatedAt" = NOW()
FROM "account" a
WHERE a."userId" = "user".id
  AND a."providerId" = 'credential'
  AND "user".password IS NULL;`,
  },
  {
    name:
      "2/4 补建 email 渠道（真实邮箱用户；占位邮箱 @oauth.usercenter 跳过，身份已在 socialAccount）",
    sql: `INSERT INTO "socialAccount"
(id, "userId", provider, "providerOpenid", "profileData", valid,
 "allowPasswordUpdate", "allowVerification", "createdAt", "updatedAt")
SELECT gen_random_uuid(), id, 'email', email, '{}'::jsonb, 1, 1, 1, NOW(), NOW()
FROM "user"
WHERE email IS NOT NULL
  AND email NOT LIKE '%@oauth.usercenter'
  AND NOT EXISTS (
    SELECT 1 FROM "socialAccount" s
    WHERE s."userId" = "user".id AND s.provider = 'email'
  );`,
  },
  {
    name: "3/4 删除 account 表（数据已搬移）",
    sql: `DROP TABLE IF EXISTS "account";`,
  },
  {
    name: "4/4 删除 user.email 列（含 user_email_key 唯一索引）",
    sql: `ALTER TABLE "user" DROP COLUMN IF EXISTS email;`,
  },
];

// ----------------------------------------------------------
// Main
// ----------------------------------------------------------

async function main() {
  if (DRY_RUN) {
    console.log("🔍 dry-run 模式：仅打印将执行的 SQL（不连接数据库）\n");
    for (const step of SQL_STEPS) {
      console.log(`--- ${step.name} ---`);
      console.log(step.sql.trim());
      console.log("");
    }
    console.log("👆 以上为迁移将执行的 SQL。确认无误后去掉 --dry-run 执行。");
    return;
  }

  if (!DATABASE_URL) {
    console.error("❌ 请设置 DATABASE_URL 环境变量");
    console.error(
      "   示例: DATABASE_URL=postgres://user:pass@localhost:5432/mydb node packages/omni-auth/bin/migrate-v5.mjs"
    );
    process.exit(1);
  }

  console.log("🔧 omni-auth v5.0.0 迁移开始");
  console.log(`   连接: ${DATABASE_URL.replace(/\/\/.*@/, "//***@")}\n`);

  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const step of SQL_STEPS) {
      try {
        const res = await client.query(step.sql);
        const affected = res.rowCount ?? 0;
        console.log(`✅ ${step.name}（影响 ${affected} 行）`);
      } catch (err) {
        console.error(`❌ ${step.name}`);
        console.error(`   原因: ${err instanceof Error ? err.message : String(err)}`);
        await client.query("ROLLBACK");
        console.error("↩️  已回滚，数据库未发生变更");
        process.exit(1);
      }
    }

    await client.query("COMMIT");
    console.log("\n🎉 v5.0.0 迁移完成：account 表与 email 锚点已移除，邮箱已是普通渠道");
  } finally {
    client.release();
    await pool.end();
  }
}

main();
