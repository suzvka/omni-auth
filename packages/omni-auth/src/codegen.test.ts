import { describe, it, expect } from "vitest";
import { generateDDL } from "./codegen-ddl";
import { generatePrismaModels, generatePrismaSchema } from "./codegen-prisma";
import { schema } from "./schema";

// ----------------------------------------------------------
// DDL 生成
// ----------------------------------------------------------

describe("generateDDL（SQL DDL 生成）", () => {
  it("包含全部三张表的 CREATE TABLE IF NOT EXISTS", () => {
    const ddl = generateDDL(schema);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "user"');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "account"');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "socialAccount"');
  });

  it("user 表列定义正确（类型/非空/默认值/主键）", () => {
    const ddl = generateDDL(schema);
    expect(ddl).toContain('"email" TEXT NOT NULL');
    expect(ddl).toContain('"createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(ddl).toContain('PRIMARY KEY ("id")');
  });

  it("socialAccount 生成复合唯一索引", () => {
    const ddl = generateDDL(schema);
    expect(ddl).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "socialAccount_provider_providerOpenid_key" ON "socialAccount" ("provider", "providerOpenid")'
    );
  });

  it("user 的 email 生成单列唯一索引", () => {
    const ddl = generateDDL(schema);
    expect(ddl).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "user_email_key" ON "user" ("email")'
    );
  });

  it("不包含已迁出的 businessAccount 表", () => {
    const ddl = generateDDL(schema);
    expect(ddl).not.toContain("businessAccount");
  });
});

// ----------------------------------------------------------
// 与行类型的联动（单一事实源验证）
// ----------------------------------------------------------

describe("schema 与类型联动", () => {
  it("DDL 中的表与 schema 对象一一对应", () => {
    const tables = Object.values(schema);
    expect(tables.map((t) => t.name).sort()).toEqual([
      "account",
      "socialAccount",
      "user",
    ]);
  });

  it("schema 表名与 typed 门面 model 名一致", () => {
    // typed 门面的 model 名（ModelName）应能覆盖全部 schema 表
    const modelNames = ["user", "account", "socialAccount"];
    expect(Object.keys(schema).sort()).toEqual(modelNames.sort());
  });
});

// ----------------------------------------------------------
// Prisma schema 生成
// ----------------------------------------------------------

describe("generatePrismaSchema（Prisma schema 生成）", () => {
  it("生成完整 schema（generator + datasource + models）", () => {
    const prisma = generatePrismaSchema(schema);
    expect(prisma).toContain('provider = "prisma-client-js"');
    expect(prisma).toContain('provider = "postgresql"');
    expect(prisma).toContain('url      = env("DATABASE_URL")');
    expect(prisma).toContain("model User {");
    expect(prisma).toContain("model Account {");
    expect(prisma).toContain("model SocialAccount {");
  });

  it("User model 字段映射正确", () => {
    const prisma = generatePrismaModels(schema);
    expect(prisma).toContain("model User {");
    expect(prisma).toContain("  id String @id @default(cuid())");
    expect(prisma).toContain("  name String");
    expect(prisma).toContain("  email String @unique");
    expect(prisma).toContain("  image String?");
    expect(prisma).toContain("  createdAt DateTime @default(now())");
    expect(prisma).toContain("  updatedAt DateTime @updatedAt");
  });

  it("表名通过 @@map 与 schema.ts 的小写表名保持一致", () => {
    const prisma = generatePrismaModels(schema);
    expect(prisma).toContain('  @@map("user")');
    expect(prisma).toContain('  @@map("account")');
    expect(prisma).toContain('  @@map("socialAccount")');
  });

  it("关系字段生成（Account → User + User 反向）", () => {
    const prisma = generatePrismaModels(schema);
    // Account.userId 引用 User
    expect(prisma).toContain(
      "  user User @relation(fields: [userId], references: [id], onDelete: Cascade)"
    );
    // User 反向持有 account / socialAccount 列表
    expect(prisma).toContain("  account Account[]");
    expect(prisma).toContain("  socialAccount SocialAccount[]");
  });

  it("复合唯一约束生成 @@unique", () => {
    const prisma = generatePrismaModels(schema);
    expect(prisma).toContain(
      "@@unique([provider, providerOpenid])"
    );
  });
});
