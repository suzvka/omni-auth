#!/usr/bin/env node
// ============================================================
// omni-auth codegen — Prisma schema 生成 CLI
//
// 用法：
//   npx omni-auth codegen
//   npx omni-auth codegen --out ./prisma/schema.prisma
//
// 行为：
//   - 从 schema.ts（单一事实源）读取表定义
//   - 生成 Prisma schema（含 generator + datasource + models）
//   - 默认输出到 stdout，--out 指定文件路径
//
// App 端使用：
//   - 生成后手动合并到 prisma/schema.prisma
//   - 或直接用 --out 覆盖（仅当 schema 完全由 omni-auth 管理时）
// ============================================================

import { writeFileSync } from "fs";
import { schema } from "../dist/schema.js";
import { generatePrismaSchema } from "../dist/codegen-prisma.js";

// ============================================================
// Args
// ============================================================

const args = process.argv.slice(2);
let outPath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) {
    outPath = args[i + 1];
    i++;
  }
}

// ============================================================
// Main
// ============================================================

console.log("🔧 omni-auth codegen v2.0.1");
console.log(`   表数量: ${Object.keys(schema).length}`);

const prismaSchema = generatePrismaSchema(schema, {
  generator: "prisma-client-js",
  datasource: {
    provider: "postgresql",
    url: 'env("DATABASE_URL")',
  },
});

if (outPath) {
  writeFileSync(outPath, prismaSchema, "utf-8");
  console.log(`✅ Prisma schema 已写入: ${outPath}`);
} else {
  console.log("");
  console.log("--- Prisma Schema ---");
  console.log(prismaSchema);
  console.log("--- End ---");
  console.log("");
  console.log("💡 提示: 使用 --out <path> 写入文件，例如:");
  console.log("   npx omni-auth codegen --out ./prisma/schema.prisma");
}
