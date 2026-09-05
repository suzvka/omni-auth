# 仓库定位（最先读，优先于一切结构推断）

本仓库是 **omni-auth 工具库的仓库**，不是网页应用仓库：

- **本仓库即产品包**：扁平单包结构，仓库根就是 npm 包 `omni-auth`（`package.json` 在根，
  源码在 `src/`，产物在 `dist/`，经 `.github/workflows/publish.yml` 发布）。
- **定位 = 服务端认证工具库**：只提供库 API（`createAuth` / `createQuickAuth` 等）与 HTTP 契约，
  **不发行浏览器客户端**（7.0.0 起移除 `omni-auth/client`）；前端由宿主自行 `fetch` 调用 `/api/auth/*`。
- **认证逻辑单一来源**：认证领域逻辑只在 `src/` 内实现；宿主只消费库公开 API 或 HTTP 接口
  （`/api/auth/*`），不存在第二套认证实现。
- 新增功能落在 `src/`（含 vitest 单测）；发布走 CI（`publish.yml`）或根目录 `npm publish`。
- 历史沿革：7.0.0 前曾是 monorepo（`packages/omni-auth` + 演示宿主 `apps/demo`），7.0.0 起
  扁平化为单包并移除 demo——demo 已在真实系统验证库能力，不再随仓维护。

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know（适用于 src/nextjs 集成模块与宿主）

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 数据库架构边界（omni-auth 作为 kit 抽象的消费者）

- **认证表单一写者（部署约束）**：认证表（`user`/`socialAccount`/`session`/`oauthToken`/
  `oauthClient`）只能有一个生产实例承担写侧（user_center）。其它集成方与 user_center 共享
  同一数据库时，其 sign-up 等写路由仅限开发/演示形态；生产部署请走 HTTP 消费
  （`/api/auth/*`），不实例化认证写侧。
- **连接池单一来源（宿主注入）**：omni-auth 库不创建/关闭连接池（`PgAdapter` 要求必填
  注入 `pool`）；宿主（如 user_center）由 `yunzone-service-kit/db` 的 `PgSqlDb` 单例提供池
  （凭证经 `resolveDatabaseUrl` 渠道解析：DATABASE_PROVIDER=postgres/coze），
  认证域与业务域共享同一连接池。
- **错误族边界**：认证域错误（`UniqueViolationError` 等 omni-auth 错误族）留在库契约内；
  业务域错误用 kit 错误族（`StorageError`/`UniqueViolationError`）。二者同源于 pg 错误码
  （23505），不做跨库映射。
- **自动建表/迁移（包内单一实现，默认关闭）**：表结构由 `schema.ts` 单一管理；
  建表属部署期操作（需 DDL 权限、影响全实例、应可审计），7.0.0 起默认不在运行期
  初始化执行——显式 `createQuickAuth({ autoSync: true })`（或 `AUTO_SYNC_DB=true`）
  才触发幂等 DDL（`src/schema-sync.ts`），推荐宿主在部署流程显式调用 `syncSchema(pool)`；
  修改表结构只改 `schema.ts`，然后重新 build。
- **认证域黑盒**：会话（`auth.sessions.*`）、OAuth server（`auth.oauthServer.*`）、
  用户管理（`auth.users.*`）、SCIM（`auth.scim.*`）均为认证域语义 API；宿主禁止直连
  认证表（不写裸 SQL、不 JOIN user 表、不自行编排级联删除）。
