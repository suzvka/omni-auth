// ============================================================
// 数据库初始化（简化版）
//
// 表结构由 omni-auth 的 schema.ts 单一管理：
//   - 建表 / 加列：npx omni-auth db:push（运行时生成 DDL）
//   - Prisma schema 合并：pnpm update:prisma
//
// 本模块只负责：
//   1. 确保目标数据库存在（bootstrap）
//   2. 只读健康检查（缺表时警告并提示运行 db:push，不自动建表）
// ============================================================

import type { PrismaClient } from "@prisma/client";
import { schema } from "omni-auth/schema";

// ============================================================
// URL 工具：将 DATABASE_URL 中的库名替换为 postgres（bootstrap 用）
// ============================================================

function buildBootstrapUrl(dbUrl: string): string {
  const url = new URL(dbUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function getDbName(dbUrl: string): string {
  return new URL(dbUrl).pathname.replace(/^\//, "") || "postgres";
}

// ============================================================
// 阶段 0：确保目标库存在（连接 postgres 默认库做检查）
// ============================================================

async function ensureDatabase(dbName: string): Promise<void> {
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
        // CREATE DATABASE 不支持参数化，这里 dbName 来自 DATABASE_URL，安全
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
// 阶段 1：只读健康检查（表缺失时警告，不自动建表）
// ============================================================

interface ExistingTable {
  table_name: string;
}

async function checkSchemaHealth(client: PrismaClient): Promise<string[]> {
  const expected = Object.values(schema).map((t) => t.name);

  const rows = (await client.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  )) as ExistingTable[];
  const existing = new Set(rows.map((r) => r.table_name));

  const missing = expected.filter((t) => !existing.has(t));
  if (missing.length > 0) {
    console.warn(
      `[DB Check] 缺少表: ${missing.join(", ")}。请运行 npx omni-auth db:push 同步 schema。`
    );
  } else {
    console.log(`[DB Check] 全部 ${expected.length} 张认证表就绪。`);
  }
  return missing;
}

// ============================================================
// 初始化入口：库 → 健康检查
// ============================================================

export async function initializeDatabase(
  client: PrismaClient
): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is required for database bootstrap.");
  }

  // 阶段 0：确保库存在
  await ensureDatabase(getDbName(dbUrl));

  // 阶段 1：只读健康检查
  await checkSchemaHealth(client);

  console.log("[DB Init] Initialization complete.");
}
