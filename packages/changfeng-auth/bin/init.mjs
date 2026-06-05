#!/usr/bin/env node

// ============================================================
// changfeng-auth init — Prisma Schema 自动设置工具
//
// 用法：
//   npx changfeng-auth init
//   npx changfeng-auth init --provider sqlite
// ============================================================

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const SCHEMA_SOURCE = join(PACKAGE_ROOT, "prisma", "schema.prisma");

// ============================================================
// 交互式询问
// ============================================================

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log("");
  console.log("  ╔══════════════════════════════════════╗");
  console.log("  ║   changfeng-auth — Prisma 初始化    ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log("");

  // 1. 读取模板 schema
  if (!existsSync(SCHEMA_SOURCE)) {
    console.error(`  ❌ 找不到模板 schema: ${SCHEMA_SOURCE}`);
    console.error("     请确保 changfeng-auth 已正确安装。");
    process.exit(1);
  }

  let schema = readFileSync(SCHEMA_SOURCE, "utf-8");

  // 2. 确定数据库 provider
  let provider = process.argv.includes("--provider")
    ? process.argv[process.argv.indexOf("--provider") + 1]
    : null;

  if (!provider) {
    console.log("  请选择数据库类型：");
    console.log("    [1] PostgreSQL (推荐)");
    console.log("    [2] MySQL");
    console.log("    [3] SQLite");
    console.log("");

    const choice = await ask("  输入数字 (1/2/3) [默认: 1]: ");

    switch (choice || "1") {
      case "1":
        provider = "postgresql";
        break;
      case "2":
        provider = "mysql";
        break;
      case "3":
        provider = "sqlite";
        break;
      default:
        console.error(`  ❌ 无效选择: ${choice}`);
        process.exit(1);
    }
  }

  // 3. 更新 provider
  schema = schema.replace(
    /provider\s*=\s*"postgresql"/,
    `provider = "${provider}"`
  );

  // 4. 确认目标路径
  const targetDir = join(process.cwd(), "prisma");
  const targetFile = join(targetDir, "schema.prisma");

  if (existsSync(targetFile)) {
    const overwrite = await ask(
      `  ⚠️  ${targetFile} 已存在，是否覆盖？(y/N): `
    );
    if (overwrite.toLowerCase() !== "y") {
      console.log("  ❌ 已取消。");
      process.exit(0);
    }
  }

  // 5. 写入文件
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetFile, schema, "utf-8");

  console.log("");
  console.log(`  ✅ Schema 已写入: ${targetFile}`);
  console.log("");
  console.log("  📋 后续步骤：");
  console.log("");
  console.log("  1. 配置 .env 中的 DATABASE_URL：");
  if (provider === "postgresql") {
    console.log('     DATABASE_URL="postgresql://user:password@localhost:5432/mydb"');
  } else if (provider === "mysql") {
    console.log('     DATABASE_URL="mysql://user:password@localhost:3306/mydb"');
  } else {
    console.log('     DATABASE_URL="file:./dev.db"');
  }
  console.log("");
  console.log("  2. 生成 Prisma Client：");
  console.log("     npx prisma generate");
  console.log("");
  console.log("  3. 推送到数据库（开发环境）：");
  console.log("     npx prisma db push");
  console.log("");
  console.log("  4. 在 lib/auth.ts 中初始化 SDK：");
  console.log("     import { PrismaClient } from '@prisma/client';");
  console.log('     import { PrismaAdapter } from "changfeng-auth/adapters/prisma";');
  console.log('     import { createQuickAuth } from "changfeng-auth-nextjs";');
  console.log("");
  console.log("     const prisma = new PrismaClient();");
  console.log("");
  console.log("     export const auth = createQuickAuth({");
  console.log("       database: PrismaAdapter({ prisma }),");
  console.log("       secret: process.env.BETTER_AUTH_SECRET!,");
  console.log("       baseUrl: process.env.BETTER_AUTH_URL!,");
  console.log("     });");
  console.log("");
}

main().catch((err) => {
  console.error("  ❌ 初始化失败:", err.message);
  process.exit(1);
});
