import { PrismaClient } from "@prisma/client";
import { dbConfig } from "./config";
import { initializeDatabase } from "./sync";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  initDone: boolean | undefined;
};

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: dbConfig.logQueries
      ? ["query", "warn", "error"]
      : ["warn", "error"],
  });
}

const _prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = _prisma;
}

// === 全前置初始化：库 → 表 → 列 → 索引 ===
// top-level await 确保 prisma 导出前 DB 100% 就绪
// globalForPrisma.initDone 确保热重载时不会重复执行
if (!globalForPrisma.initDone) {
  await initializeDatabase(_prisma);
  globalForPrisma.initDone = true;
}

export const prisma = _prisma;
