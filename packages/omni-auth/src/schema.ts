// ============================================================
// omni-auth Schema — 单一事实源
//
// 此处定义的表结构用于：
// 1. TypeScript 行类型推导（InferSelect）
// 2. SQL DDL 生成（codegen-ddl.ts → schema-sync.ts）
// 3. Prisma schema 生成（codegen-prisma.ts → bin/codegen.mjs）
//
// 修改表结构时只需改此文件，其余产物由 codegen 自动同步。
// ============================================================

import {
  table,
  text,
  integer,
  boolean,
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
  /** 账号启用状态（0/1；历史库可能为 boolean，读取时归一化） */
  active: integer().notNull().default(1),
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
// session 表（宿主会话，认证域私有）
//
// 列名沿用历史物理表（驼峰保真），由 schema-sync 同步。
// ----------------------------------------------------------

export const session = table("session", {
  id: text().primaryKey(),
  userId: text().notNull(),
  token: text().notNull(),
  expiresAt: timestamptz().notNull(),
  createdAt: timestamptz().notNull().default("NOW()"),
});

// ----------------------------------------------------------
// oauthToken 表（授权码 + refresh token 生命周期）
//
// 表名与 model 名一致（驼峰），由 schema-sync 同步；
// 无 id 列（历史 INSERT 不携带），(token, type) 复合唯一索引标识记录。
// ----------------------------------------------------------

export const oauthToken = table(
  "oauthToken",
  {
    token: text().notNull(),
    type: text().notNull(),
    client_id: text().notNull(),
    user_id: text().notNull(),
    code_challenge: text(),
    redirect_uri: text(),
    scope: text(),
    status: text().notNull().default("active"),
    expires_at: timestamptz().notNull(),
    created_at: timestamptz().notNull().default("NOW()"),
  },
  {
    uniqueConstraints: [["token", "type"]],
  }
);

// ----------------------------------------------------------
// oauthClient 表（OAuth 客户端凭证）
//
// client_secret 由 Token Authority Service 签发的证书承载；
// 表名与 model 名一致（驼峰），由 schema-sync 同步。
// ----------------------------------------------------------

export const oauthClient = table("oauthClient", {
  id: text().primaryKey(),
  client_id: text().notNull().unique(),
  client_secret: text(),
  client_name: text().notNull(),
  client_uri: text(),
  /** 回调地址清单（jsonb 数组形状，InferSelect 推导 string[]） */
  redirect_uris: jsonb<string[]>().notNull().default([]),
  is_confidential: boolean().notNull().default(true),
  status: text().notNull().default("active"),
  description: text().notNull().default(""),
  expires_at: timestamptz(),
  revoked_at: timestamptz(),
  issued_by: text().notNull(),
  auto_renew: boolean().notNull().default(false),
  auto_renew_days: integer().notNull().default(30),
  renewal_count: integer().notNull().default(0),
  last_renewed_at: timestamptz(),
  created_at: timestamptz().notNull().default("NOW()"),
});

// ----------------------------------------------------------
// Schema 容器
// ----------------------------------------------------------

export const schema = defineSchema({
  user,
  socialAccount,
  session,
  oauthToken,
  oauthClient,
});

// ----------------------------------------------------------
// 派生行类型（零手写，自动跟随 schema 改动）
// ----------------------------------------------------------

export type UserRow = InferSelect<typeof user>;
export type SocialAccountRow = InferSelect<typeof socialAccount>;
export type SessionRow = InferSelect<typeof session>;
export type OAuthTokenRow = InferSelect<typeof oauthToken>;
export type OAuthClientRow = InferSelect<typeof oauthClient>;

// INSERT 输入类型（NOT NULL 无默认值列必填）
export type UserInsert = InferInsert<typeof user>;
export type SocialAccountInsert = InferInsert<typeof socialAccount>;
export type SessionInsert = InferInsert<typeof session>;
export type OAuthTokenInsert = InferInsert<typeof oauthToken>;
export type OAuthClientInsert = InferInsert<typeof oauthClient>;
