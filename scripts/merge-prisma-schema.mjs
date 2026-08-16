#!/usr/bin/env node
// ============================================================
// merge-prisma-schema — 合并 omni-auth 生成的 Prisma schema 与 app 自定义表
//
// 用法：pnpm update:prisma
//
// 输出 prisma/schema.prisma：
//   1. generator + datasource
//   2. omni-auth 认证两表（由 omni-auth schema.ts 单一事实源生成）
//   3. app 自定义表（BusinessAccount 等，在此脚本中维护）
//
// 表结构修改流程：
//   - SDK 表（user/socialAccount）：改 packages/omni-auth/src/schema.ts
//   - app 表（BusinessAccount 等）：改本脚本的 appModels
//   - 然后运行 pnpm update:prisma && pnpm exec prisma generate
// ============================================================

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { schema } from "omni-auth/schema";
import { generatePrismaModels } from "omni-auth/codegen-prisma";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// ----------------------------------------------------------
// 1. 生成 omni-auth 认证表模型
// ----------------------------------------------------------

const generated = generatePrismaModels(schema);

// 注入 app 反向关系（BusinessAccount → User 的一对一反向字段）
const withBackRelation = generated.replace(
  "model User {",
  "model User {\n  businessAccount BusinessAccount?"
);

// ----------------------------------------------------------
// 2. app 自定义表
// ----------------------------------------------------------

const appModels = `
// ============================================================
// app 自定义表
// ============================================================

model BusinessAccount {
  id          String   @id @default(cuid())
  authUserId  String   @unique
  user        User     @relation(fields: [authUserId], references: [id], onDelete: Cascade)
  displayName String
  status      String   @default("active")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
`;

// ----------------------------------------------------------
// 3. 组装完整 schema
// ----------------------------------------------------------

const full = `// ============================================================
// omni-auth 生成 + app 自定义
// 由 scripts/merge-prisma-schema.mjs 生成，勿手动修改本文件
// ============================================================

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ============================================================
// omni-auth 认证表（来自 packages/omni-auth/src/schema.ts）
// ============================================================

${withBackRelation}
${appModels}`;

writeFileSync(join(root, "prisma", "schema.prisma"), full, "utf-8");
console.log("✅ prisma/schema.prisma 已更新");
console.log("   表: user / socialAccount（omni-auth 生成）+ businessAccount（app）");
