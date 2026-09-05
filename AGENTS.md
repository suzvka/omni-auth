# 仓库定位（最先读，优先于一切结构推断）

本仓库是 **omni-auth 工具库的仓库**，不是网页应用仓库：

- **唯一产品 = `packages/omni-auth`**（npm 包 `omni-auth`，经 `.github/workflows/publish.yml` 发布）。
- **定位 = 服务端认证工具库**：只提供库 API（`createAuth` / `createQuickAuth` 等）与 HTTP 契约，**不发行浏览器客户端**（7.0.0 起移除 `omni-auth/client`）；前端由宿主自行 `fetch` 调用 `/api/auth/*`。
- `apps/demo` 仅是开发/演示宿主（Next.js），用于手动测试工具库行为，**不是产品、不参与发布**。
- 认证领域逻辑只允许存在于 `packages/omni-auth`；demo 只消费工具库公开 API / HTTP 接口（`/api/auth/*`），不存在第二套认证实现。
- 新增功能落在 `packages/omni-auth`（含 vitest 单测）；demo 的改动只服务于验证工具库行为。
- 旧约定失效：仓库根目录已无 `src/` —— 宿主代码一律在 `apps/demo/src/`，工具库代码一律在 `packages/omni-auth/src/`。

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know（仅适用于 apps/demo）

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 数据库架构边界（omni-auth 作为 kit 抽象的消费者）

- **认证逻辑单一来源**：认证领域逻辑只在 omni-auth 库（`packages/omni-auth`）内实现；
  宿主（演示宿主 `apps/demo` 或任何集成方）只消费 HTTP 接口（`/api/auth/*`）或库的公开 API，
  不存在第二套认证实现。
- **认证表单一写者（部署约束）**：认证表（`user`/`socialAccount`/`session`/`oauthToken`/
  `oauthClient`）只能有一个生产实例承担写侧（user_center）。演示宿主 `apps/demo` 与
  user_center 共享同一数据库时，其 sign-up 等写路由仅限开发/演示形态；生产部署请走 HTTP
  消费（`/api/auth/*`），不实例化认证写侧。
- **连接池单一来源（宿主注入）**：omni-auth 库不创建/关闭连接池（`PgAdapter` 要求必填
  注入 `pool`）；演示宿主与 user_center 均由宿主侧 `yunzone-service-kit/db` 的 `PgSqlDb`
  单例提供池（凭证经 `resolveDatabaseUrl` 渠道解析：DATABASE_PROVIDER=postgres/coze），
  认证域与业务域共享同一连接池。
- **错误族边界**：认证域错误（`UniqueViolationError` 等 omni-auth 错误族）留在库契约内；
  业务域错误用 kit 错误族（`StorageError`/`UniqueViolationError`）。二者同源于 pg 错误码
  （23505），不做跨库映射。
- **自动建表/迁移（包内单一实现，默认关闭）**：表结构由 omni-auth 包 `schema.ts` 单一管理；
  建表属部署期操作（需 DDL 权限、影响全实例、应可审计），7.0.0 起默认不在运行期
  初始化执行——显式 `createQuickAuth({ autoSync: true })`（或 `AUTO_SYNC_DB=true`）
  才触发幂等 DDL（`src/schema-sync.ts`），推荐宿主在部署流程显式调用 `syncSchema(pool)`；
  修改表结构只改 `schema.ts`，然后重新 build 包。`apps/demo` 不再持有任何宿主侧 schema 同步实现
  （`apps/demo/src/modules/db/sync.ts` 已删除）。
- **认证域黑盒**：会话（`auth.sessions.*`）、OAuth server（`auth.oauthServer.*`）、
  用户管理（`auth.users.*`）、SCIM（`auth.scim.*`）均为认证域语义 API；宿主禁止直连
  认证表（不写裸 SQL、不 JOIN user 表、不自行编排级联删除）。