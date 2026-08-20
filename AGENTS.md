<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 数据库架构边界（omni-auth 作为 kit 抽象的消费者）

- **认证逻辑单一来源**：认证领域逻辑只在 omni-auth 库（`packages/omni-auth`）内实现；
  页面/宿主只消费 HTTP 接口（`/api/auth/*`）或库的公开 API，不存在第二套认证实现。
- **认证表单一写者（部署约束）**：认证表（`user`/`socialAccount`/`session`/`oauth_token`/
  `oauth_client`）只能有一个生产实例承担写侧（user_center）。本应用与 user_center 共享
  同一数据库时，本应用的 sign-up 等写路由仅限开发/演示形态；生产部署请走 HTTP 消费
  （`/api/auth/*`），不实例化认证写侧。
- **连接池单一来源（宿主注入）**：omni-auth 库不创建/关闭连接池（`PgAdapter` 要求必填
  注入 `pool`）；本应用与 user_center 均由宿主侧 `yunzone-service-kit/db` 的 `PgSqlDb`
  单例提供池（凭证经 `resolveDatabaseUrl` 渠道解析：DATABASE_PROVIDER=postgres/coze），
  认证域与业务域共享同一连接池。
- **错误族边界**：认证域错误（`UniqueViolationError` 等 omni-auth 错误族）留在库契约内；
  业务域错误用 kit 错误族（`StorageError`/`UniqueViolationError`）。二者同源于 pg 错误码
  （23505），不做跨库映射。
- **自动建表/迁移（包内单一实现）**：表结构由 omni-auth 包 `schema.ts` 单一管理；
  `createQuickAuth({ autoSync: true })` 初始化时自动执行幂等 DDL（`src/schema-sync.ts`，
  与 `npx omni-auth db:push` 同源逻辑，CLI 复用同一实现）；修改表结构只改 `schema.ts`，
  然后重新 build 包。本仓库不再持有任何宿主侧 schema 同步实现（`src/modules/db/sync.ts`
  已删除）。
- **认证域黑盒**：会话（`auth.sessions.*`）、OAuth server（`auth.oauthServer.*`）、
  用户管理（`auth.users.*`）、SCIM（`auth.scim.*`）均为认证域语义 API；宿主禁止直连
  认证表（不写裸 SQL、不 JOIN user 表、不自行编排级联删除）。
- **omni-auth 库零依赖 kit**：`packages/omni-auth` 不依赖 `yunzone-service-kit`（类型上
  用最小结构形状 `PgPoolLike` 解耦）；接线（kit → omni-auth）只发生在宿主应用层。
