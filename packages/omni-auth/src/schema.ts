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
// user 表（聚合身份 + 共享密码）
//
// 5.0.0 渠道化：email 列删除（邮箱降级为普通渠道，身份见
// socialAccount），密码以共享语义存放于此（可空，OAuth-only
// 用户无密码）；唯一身份锚点为 id + socialAccount(provider, providerOpenid)。
// ----------------------------------------------------------

export const user = table("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  image: text(),
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
  socialAccount,
});

// ----------------------------------------------------------
// 派生行类型（零手写，自动跟随 schema 改动）
// ----------------------------------------------------------

export type UserRow = InferSelect<typeof user>;
export type SocialAccountRow = InferSelect<typeof socialAccount>;

// INSERT 输入类型（NOT NULL 无默认值列必填）
export type UserInsert = InferInsert<typeof user>;
export type SocialAccountInsert = InferInsert<typeof socialAccount>;
