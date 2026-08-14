// ============================================================
// omni-auth Schema — 单一事实源
//
// 此处定义的表结构用于：
// 1. TypeScript 行类型推导（InferSelect）
// 2. SQL DDL 生成（codegen-ddl.ts → bin/db-push.mjs）
// 3. Prisma schema 生成（codegen-prisma.ts → bin/codegen.mjs）
//
// 修改表结构时只需改此文件，其余产物由 codegen 自动同步。
// ============================================================

import {
  table,
  text,
  integer,
  jsonb,
  timestamptz,
  defineSchema,
  type InferSelect,
  type InferInsert,
} from "./schema-builder";

// ----------------------------------------------------------
// user 表
// ----------------------------------------------------------

export const user = table("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  image: text(),
  createdAt: timestamptz().notNull().default("NOW()"),
  updatedAt: timestamptz().notNull(),
});

// ----------------------------------------------------------
// account 表（凭证账户，密码存放处）
// ----------------------------------------------------------

export const account = table("account", {
  id: text().primaryKey(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text().notNull().references("user", { onDelete: "cascade" }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: timestamptz(),
  refreshTokenExpiresAt: timestamptz(),
  scope: text(),
  password: text(),
  createdAt: timestamptz().notNull().default("NOW()"),
  updatedAt: timestamptz().notNull(),
});

// ----------------------------------------------------------
// socialAccount 表（社交账户）
// ----------------------------------------------------------

export const socialAccount = table(
  "socialAccount",
  {
    id: text().primaryKey(),
    userId: text().notNull().references("user", { onDelete: "cascade" }),
    provider: text().notNull(),
    providerOpenid: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    tokenExpiresAt: timestamptz(),
    profileData: jsonb().notNull().default({}),
    valid: integer().notNull().default(0),
    allowPasswordUpdate: integer().notNull().default(0),
    allowVerification: integer().notNull().default(0),
    createdAt: timestamptz().notNull().default("NOW()"),
    updatedAt: timestamptz().notNull(),
  },
  {
    uniqueConstraints: [["provider", "providerOpenid"]],
  }
);

// ----------------------------------------------------------
// Schema 容器
// ----------------------------------------------------------

export const schema = defineSchema({
  user,
  account,
  socialAccount,
});

// ----------------------------------------------------------
// 派生行类型（零手写，自动跟随 schema 改动）
// ----------------------------------------------------------

export type UserRow = InferSelect<typeof user>;
export type AccountRow = InferSelect<typeof account>;
export type SocialAccountRow = InferSelect<typeof socialAccount>;

// INSERT 输入类型（NOT NULL 无默认值列必填）
export type UserInsert = InferInsert<typeof user>;
export type AccountInsert = InferInsert<typeof account>;
export type SocialAccountInsert = InferInsert<typeof socialAccount>;
