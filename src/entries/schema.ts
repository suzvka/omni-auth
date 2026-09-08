// omni-auth/schema — schema 同步 + DSL + 表定义（部署期关注点，8.0.0 从 root 移出）
// ============================================================
// 独立 leaf barrel：本文件依赖 schema/schema-sync/schema-builder，
// 三者之间不存在对自身的回边，规避 schema ↔ schema-sync 循环导入。

// 同步
export { syncSchema } from "../schema-sync";
export type { SyncSchemaOptions, SyncSchemaResult } from "../schema-sync";

// 表定义 + 派生行/插入类型（单一事实源）
export {
  schema,
  user,
  socialAccount,
  session,
  oauthToken,
  oauthClient,
} from "../schema";
export type {
  UserRow,
  SocialAccountRow,
  SessionRow,
  OAuthTokenRow,
  OAuthClientRow,
  UserInsert,
  SocialAccountInsert,
  SessionInsert,
  OAuthTokenInsert,
  OAuthClientInsert,
} from "../schema";

// DSL（自定义表结构 / codegen 场景）
export {
  table,
  text,
  boolean,
  integer,
  jsonb,
  timestamptz,
  timestamp,
  defineSchema,
  ColumnBuilder,
} from "../schema-builder";
export type {
  ColumnType,
  ColumnDef,
  TableDef,
  TableOptions,
  Schema,
  InferSelect,
  InferInsert,
} from "../schema-builder";
