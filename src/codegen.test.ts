import { describe, it, expect } from "vitest";
import { generateDDL, assertConsistentTableNames } from "./codegen-ddl";
import { generatePrismaModels, generatePrismaSchema } from "./codegen-prisma";
import { schema } from "./schema";

// ----------------------------------------------------------
// DDL 生成
// ----------------------------------------------------------

describe("generateDDL（SQL DDL 生成）", () => {
  it("包含全部认证域表的 CREATE TABLE IF NOT EXISTS", () => {
    const ddl = generateDDL(schema);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "user"');
    expect(ddl).not.toContain('CREATE TABLE IF NOT EXISTS "account"');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "socialAccount"');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "session"');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "oauthToken"');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "oauthClient"');
  });

  it("user 表列定义正确（类型/非空/默认值/主键）", () => {
    const ddl = generateDDL(schema);
    expect(ddl).toContain('"password" TEXT');
    expect(ddl).toContain('"createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(ddl).toContain('PRIMARY KEY ("id")');
  });

  it("socialAccount 生成复合唯一索引", () => {
    const ddl = generateDDL(schema);
    expect(ddl).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "socialAccount_provider_providerOpenid_key" ON "socialAccount" ("provider", "providerOpenid")'
    );
  });

  it("user 不再生成 email 唯一索引（邮箱锚点已移除）", () => {
    const ddl = generateDDL(schema);
    expect(ddl).not.toContain('"user_email_key"');
  });

  it("user 不生成 username 列（唯一键归 id，名字归 name）", () => {
    const ddl = generateDDL(schema);
    expect(ddl).not.toContain('"username"');
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
      "oauthClient",
      "oauthToken",
      "session",
      "socialAccount",
      "user",
    ]);
  });

  it("schema 表名与 typed 门面 model 名一致", () => {
    // typed 门面的 model 名（ModelName）应能覆盖全部 schema 表
    const modelNames = ["user", "socialAccount", "session", "oauthToken", "oauthClient"];
    expect(Object.keys(schema).sort()).toEqual(modelNames.sort());
  });

  it("schema 变量名与物理表名逐一一致（单一标识符约束）", () => {
    // 运行时直接以 model 名（schema 变量名）拼 SQL，物理表名必须与之相同；
    // 曾因 oauthToken/oauthClient 表名 snake_case 与 model 名分道扬镳导致
    // 全新库 OAuth 操作必崩（5.1.2），此处为根因守卫。
    for (const [model, tableDef] of Object.entries(schema)) {
      expect(tableDef.name).toBe(model);
    }
  });

  it("assertConsistentTableNames：不一致时抛错（fail-fast）", () => {
    const bad = {
      ...schema,
      // 构造一个 model 名与物理表名不一致的非法 schema
      oauthToken: { ...schema.oauthToken, name: "oauth_token" },
    };
    expect(() => assertConsistentTableNames(bad)).toThrow(/不一致/);
    // 合法 schema 不抛错
    expect(() => assertConsistentTableNames(schema)).not.toThrow();
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
    expect(prisma).not.toContain("model Account {");
    expect(prisma).toContain("model SocialAccount {");
  });

  it("User model 字段映射正确", () => {
    const prisma = generatePrismaModels(schema);
    expect(prisma).toContain("model User {");
    expect(prisma).toContain("  id String @id @default(cuid())");
    expect(prisma).toContain("  name String");
    expect(prisma).toContain("  password String?");
    expect(prisma).toContain("  image String?");
    expect(prisma).toContain("  createdAt DateTime @default(now())");
    expect(prisma).toContain("  updatedAt DateTime @updatedAt");
  });

  it("表名通过 @@map 与 schema.ts 的小写表名保持一致", () => {
    const prisma = generatePrismaModels(schema);
    expect(prisma).toContain('  @@map("user")');
    expect(prisma).not.toContain('  @@map("account")');
    expect(prisma).toContain('  @@map("socialAccount")');
  });

  it("关系字段生成（SocialAccount → User + User 反向）", () => {
    const prisma = generatePrismaModels(schema);
    // SocialAccount.userId 引用 User
    expect(prisma).toContain(
      "  user User @relation(fields: [userId], references: [id], onDelete: Cascade)"
    );
    // User 反向持有 socialAccount 列表（account 表已删除）
    expect(prisma).not.toContain("  account Account[]");
    expect(prisma).toContain("  socialAccount SocialAccount[]");
  });

  it("复合唯一约束生成 @@unique", () => {
    const prisma = generatePrismaModels(schema);
    expect(prisma).toContain(
      "@@unique([provider, providerOpenid])"
    );
  });
});
