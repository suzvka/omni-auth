# Changelog

## 5.1.2（未发布）

> **修复全新库注册必失败的问题**：`bindToUser` 插入 `socialAccount` 时未提供 `id`，
> 而 autoSync 建出的 `socialAccount.id` 为 `TEXT NOT NULL PRIMARY KEY`（无 DB
> DEFAULT，应用层不生成），导致全新库（autoSync 建表）上任何渠道注册/OAuth
> 注册在插入社交账户时触发 `null value in column "id" violates not-null
> constraint`，事务回滚、注册必失败。修复为 `bindToUser` 内应用层生成
> `randomUUID()`（与 user/session 插入路径一致）；已存在的旧库（建表时带
> DEFAULT 或手动管理 id）不受影响。新增回归防护：单元测试断言绑定生成 UUID
> id，pg-mem 集成测试覆盖 autoSync 建表后 bindToUser 真实插入。
> 本版本基于 5.1.1 修复（SCIM/OAuth scope 导出构建产物修复，npm 已发布于
> 2026-08-21）。

## 5.1.1（npm 已发布）

> **修复 npm 5.1.0 构建产物缺失 SCIM / OAuth scope 导出的问题**。npm 上的 5.1.0
> 发布于 SCIM 模块与 scope 协商加入源码之前（2026-08-20 15:00 发布，16:41 引入
> SCIM），导致宿主项目（yunzone_user_center）从 `omni-auth` 导入
> `ScimError` / `parsePagination` / `buildListResponse` / `parseFilter` /
> `allSchemas` / `getSchemaById` / `notFound` / `hasScope` / `negotiateScope`
> 在 Turbopack 下构建失败（10 个导出缺失错误）。5.1.1 为 5.1.0 源码的全量
> 重新构建产物，公开 API 无新增、无破坏。

## 5.1.0（npm 已发布；注：该版本构建产物缺失 SCIM 导出，请升级至 5.1.1）

> **数据库适配器改为注入式连接池**（相对 npm 5.0.0 的增量）：`PgAdapter` 不再自行创建/
> 关闭连接池，改由宿主提供现成连接池引用（`createQuickAuth({ database: { pool } })`），
> 认证域与宿主业务域共享同一连接池。`{ url, ssl }` 声明式形态已删除。
> 连接池类型为最小结构接口 `PgPoolLike`，与宿主所用 pg 类型版本解耦（零依赖 kit）。

### 移除（公开 API）

- **`UniqueViolationError` 类删除**：数据库唯一约束冲突（pg 23505）改由适配器转译为
  `code=UNIQUE_VIOLATION` 的 `OmniAuthError` 抛出，新增 `isUniqueViolation(err)` 守卫判断。
  原因：该类是内部信号（仅 4 处业务转译点消费）却误入公共 API，且与宿主基础设施
  （yunzone-service-kit）的同名错误类形成"同名不同类型"陷阱；删除后跨抽象判断统一按
  `err.code`（两族 code 值域已对齐为 `UNIQUE_VIOLATION`）。消费方迁移：
  `err instanceof UniqueViolationError` → `isUniqueViolation(err)`。

### 契约声明

- **事务边界**：`PgAdapter.transaction` 文档显式声明——SDK 事务与宿主事务
  （如 yunzone-service-kit `withTransaction`）互相不可见，宿主应在自身事务外调用
  SDK 写操作，否则其写入会静默逃逸宿主事务。

## 5.0.0（npm 已发布旧版；本仓库源码为渠道化重构，随 5.1.0 发布）

> **渠道化重构：两表模型（user + socialAccount）**。删除 account 表与
> user.email 邮箱锚点，密码以共享语义上移至 user.password；邮箱降级为
> 普通渠道（provider="email"）。占位邮箱、随机密码与全部渠道特判随之
> 消亡——代码只关心抽象的"渠道"，从不关心具体渠道实现。破坏性变更。

### 移除（公开 API / 存储）

- **`account` 表**：整体删除（providerId 恒为 credential 的密码存放表，
  OAuth 字段全部闲置）。密码哈希迁至 `user.password`。
- **`user.email` 列与 `user_email_key` 唯一索引**：邮箱锚点删除。
  邮箱身份 = socialAccount 的 `(provider="email", providerOpenid=邮箱地址)`。
- **占位邮箱整套**：`buildPlaceholderEmail` / `PLACEHOLDER_EMAIL_DOMAIN` /
  `generateRandomPassword` 及 core/channel-mapping.ts 模块整体删除。
- **`signUpWithSocial`**：功能已由 authenticateChannel 覆盖，删除。
- **`PublicUser.email`**：删除（邮箱信息通过 `auth.social.listByUser` 获取渠道记录）。
- **`UserCreatedPayload.email`**：hooks 载荷简化为 `{ userId, name }`。
- **`SignUpInput.channel.provider / identifier`**：signUp 固定创建 email 渠道，
  channel 仅承载该渠道的 token / 资料 / 能力标记。
- **`DbFacade.account` / `AccountRow` / `AccountInsert` / `account`（schema）导出**。

### 行为变更

- **密码共享语义**：登录验证一律 `user.password`（可空，OAuth-only 用户无密码），
  任何渠道密码登录验同一哈希。
- **OAuth 新用户不再生成随机密码**：`password = null`，
  后续可通过渠道验证码设置密码（resetPassword 允许从无到有）。
- **signUp 创建的 email 渠道 `valid=1`**（修正旧行为 0=系统占位）。
- **signIn 限流键**：`signIn:${ip}:email:${email}`（渠道化：ip:provider:providerOpenid）。
- **authenticateChannel 密码登录**：不再经合成邮箱中转 signIn，
  渠道反查用户后直接验证共享密码（含同构限流键）。
- 密码策略默认最短 **8** 位（与 4.1.0 实际行为一致）。

### 迁移

- 运行 `pnpm migrate:v5`（或直接执行 bin/migrate-v5.mjs）完成数据搬移：
  1. `account.password` → `user.password`
  2. 真实邮箱用户补建 email 渠道记录（占位邮箱 `@oauth.usercenter` 跳过，
     其渠道身份已在 socialAccount）
  3. `DROP TABLE account`
  4. `ALTER TABLE "user" DROP COLUMN email`
- 先以 `--dry-run` 核对 SQL；执行前请备份数据库（要求 PostgreSQL 13+）。

## 4.1.0（未发布）

> **安全加固与健壮性改进**。全部改动为新增式（新可选配置 /
> 新错误类），默认行为与 4.0.0 兼容。

### 新增

- **`WeakPasswordError`**（code `WEAK_PASSWORD`）：signUp /
  signUpWithSocial 密码长度不足不再抛裸 `Error`，纳入
  OmniAuthError 体系。
- **`OmniAuthConfig.passwordPolicy`**：`{ minLength }`，默认 6
  （与旧版行为一致），可 opt-in 更严格策略（如 8）。
- **客户端 IP 解析可注入**：`OmniAuthRateLimitConfig.getClientIp`
  自定义解析函数；`getClientIp(ctx, { trustedProxyDepth })` 支持
  从 x-forwarded-for 右侧数 N 跳，可信代理部署下防请求头伪造
  绕过限流。默认行为（取首段）不变。
- **验证码验证尝试限流（opt-in）**：`rateLimit.verifyCode`
  `{ maxAttempts, windowMs }`。配置后 verifyChannelCode 按
  `provider:providerOpenid` 限制尝试次数（防短验证码爆破），
  验证成功时重置计数。未配置时行为与旧版一致。
- **signIn 成功后重置限流计数**（best-effort 调用
  `RateLimiter.reset`，外部限流器异常不影响登录结果）。
- `SignUpInput.channel` 新增可选扩展字段（accessToken /
  refreshToken / tokenExpiresAt / profileData / valid /
  allowPasswordUpdate / allowVerification）。
- 新增 PgAdapter 真实数据库集成测试（设置
  `OMNI_AUTH_TEST_PG_URL` 环境变量时运行，否则跳过）。

### 改进

- **authenticateChannel 新用户路径原子化**：渠道扩展数据随
  signUp 同事务写入（user + account + socialAccount 一次提交），
  移除原事务外的单独 updateOne，消除不一致窗口。
- `_readPublicUser` 记录不存在时抛 `OmniAuthError`
  （code `USER_NOT_FOUND`），不再伪造空用户对象掩盖数据不一致。
- 移除 `createQuickAuth` 的 console.log 日志污染；
  QuickAuthConfig 同步透传 `passwordPolicy`。

## 4.0.0（未发布）

> **渠道模型清理**：接受"手机 / 邮箱 / 社交媒体一律作为渠道登记"的
> 现实，删除基于"邮箱 / 手机特化"假设的机制。破坏性变更。

### 移除（公开 API）

- **手机合成邮箱整套**：`phoneToSyntheticEmail` / `syntheticEmailToPhone` /
  `isSyntheticEmail` / `SYNTHETIC_EMAIL_DOMAIN` 及类型 `ChannelProvider`、
  函数 `isChannelProvider`（均已弃用 / 零消费者）。
  非邮箱渠道统一使用占位邮箱 `{provider}_{openid}@oauth.usercenter`。
- **`user.emailVerified` 列**：纯邮箱中心概念，从未被置 true；渠道模型下
  验证状态由 `SocialAccount.valid` / `allowVerification` 承载。
  `PublicUser` 同步移除该字段（需数据库迁移）。
- **审计类型** `emailVerificationRequest` / `emailVerified`（从未发射）。

### 行为变更

- **OAuth 回调不再以 provider 邮箱充当 `user.email`**：一律使用占位邮箱，
  provider 邮箱仅存入 `socialAccount.profileData.email`。修复不同渠道用户
  邮箱碰撞触发唯一约束的问题。
- **手机渠道** 的 `user.email` 由 `phone+{phone}@phone.omni.internal`
  变为通用占位邮箱 `phone_{openid}@oauth.usercenter`。

### 保留（渠道模型的正当机制）

- `buildPlaceholderEmail` / `PLACEHOLDER_EMAIL_DOMAIN` / `generateRandomPassword`
- `SocialAccount` 的 `valid` / `allowPasswordUpdate` / `allowVerification`
- 渠道验证码委托体系（sender / verifier）

## 3.0.0（2026-08-13）

> **重大版本**：事务原子性、实例级注册表、类型化内部数据访问。
> 包含 2.1.0 的全部安全加固内容。升级前请先阅读下方【升级指南】。

### 新增

- **事务能力**：`DatabaseAdapter` 新增可选 `transaction<T>(fn)`；
  `PgAdapter` 以单连接 BEGIN/COMMIT/ROLLBACK 实现。`signUp` /
  `signUpWithSocial` / OAuth 新用户创建的多表写入（user + account +
  socialAccount）现在包入事务，任一步失败整体回滚。生命周期钩子在
  **commit 之后**触发。新增通用辅助 `withTransaction`（未实现事务的
  适配器回退为顺序写入并警告一次）。
- **实例级注册表 `OmniRegistry`**：OAuth provider / 验证码
  sender/verifier / token refresher / 审计处理器全部收编为
  OmniAuth 实例成员，多实例互不干扰。
- `OmniAuthConfig` 新增 `audit?: AuditHandler`、
  `rateLimit?: OmniAuthRateLimitConfig`（可注入外部限流器，如 Redis）。
- `OmniAuth` 新增实例方法 `setAuditHandler`、属性 `oauth`（含
  `initiateOAuth` 的 handler）。
- 行类型新增 `UserInsert` / `AccountInsert` / `SocialAccountInsert`
  （`InferInsert` 重写：NOT NULL 且无默认值的列编译期必填，带默认值/
  可空列可选），`auth.db.*.create` 的 `data` 使用该类型。

### 破坏性变更

1. **SDK 不再写入 `businessAccount` 表**。该表是 app 业务表，
   `signUp` / OAuth 回调不再创建它；请在 `hooks.onUserCreated` 中
   自行创建（见下方升级指南）。
2. **模块级全局注册函数弃用**：`registerOAuthProvider` /
   `registerVerificationSender` / `registerVerificationVerifier` /
   `registerTokenRefresher` / `setAuditHandler` / `publishAuditEvent`
   仍可用，但仅转发到**最近创建的实例**并打印一次弃用警告；
   请改用实例方法。`oauth/handler.ts` 的 `globalHandler` /
   `setOAuthHandler` / 模块级 `handleOAuthCallback` / `initiateOAuth`
   已移除，统一经 `auth.handleOAuthCallback` / `auth.oauth` 调用。
3. **`PgAdapterInstance._pool` 移除**，改为 `getPool(): Promise<Pool>`。
4. **`PgAdapter` 空 where 防护**：`updateOne` / `updateMany` /
   `deleteOne` / `deleteMany` 传空 `where` 数组时抛 `TypeError`
   （防全表误操作）。
5. **`secret` 配置改为可选**（库内当前无消费方，为会话签名预留）。
6. `createPasswordReset` 依赖变更：需传入实例级
   `channelVerification`（内部使用，影响自定义集成方）。

### 升级指南

```sh
pnpm add omni-auth@3.0.0
```

1. **businessAccount 迁移**（必须）：

```ts
export const auth = createQuickAuth({
  database: { url: process.env.DATABASE_URL! },
  baseUrl,
  hooks: {
    onUserCreated: async ({ userId, email, name }) => {
      await businessAccountRepo.create({
        authUserId: userId,
        displayName: name || email || userId,
        status: "active",
      });
    },
  },
});
```

2. **全局注册函数** → 实例方法：

```ts
// 旧（弃用）                     // 新
registerOAuthProvider(cfg)     → auth.registerOAuthProvider(cfg)
registerVerificationSender(...) → auth.registerVerificationSender(...)
registerTokenRefresher(...)     → auth.registerTokenRefresher(...)
setAuditHandler(fn)             → createAuth({ audit: fn }) 或 auth.setAuditHandler(fn)
```

3. **OAuth 回调强制 state 校验**（2.1.0 引入）：改用对象形式参数，
   `expectedState` 必须来自服务端保存的值（签名 cookie）：

```ts
await auth.handleOAuthCallback(provider, code, redirectUri, {
  state: body.state,
  expectedState: request.cookies.get("oauth_state")?.value,
  codeVerifier: request.cookies.get("oauth_code_verifier")?.value,
});
```

4. **自定义 DatabaseAdapter**：建议实现 `transaction`（未实现时
   多表写入回退为顺序执行，仅警告不报错）。

### 兼容性

- 泛型 CRUD（`db.findOne({ model, ... })` 等）保留 `@deprecated`。
- 位置参数形式的 `handleOAuthCallback(provider, code, redirectUri, state?, codeVerifier?)`
  仍可用但不校验 state（已弃用）。

## 2.1.0（2026-08-13）

> 安全与正确性加固（随 3.0.0 一并交付，此处单独列出便于追溯）。

### 新增

- **OAuth state 库内强制校验**：对象形式回调参数
  `{ state, expectedState, codeVerifier }`，state / expectedState
  任一缺失或二者不一致抛 `OAuthStateMismatchError`。
- **类型化错误体系**：所有错误继承 `OmniAuthError`（带机器可读
  `code`）。新增 `RateLimitedError` / `UserExistsError` /
  `CredentialInvalidError` / `OAuthStateMismatchError` /
  `UniqueViolationError`；signIn 密码失败改抛 `InvalidPasswordError`
  （消息保持"邮箱或密码错误"防枚举）。
- **限流键修正**：signUp 限流键改为客户端 IP（防按邮箱锁死注册的
  DoS），signIn 改为 `ip:email` 复合键；认证方法新增可选
  `requestContext` 参数提取 IP。支持经 `config.rateLimit.limiter`
  注入 Redis 等共享限流器。
- `PgAdapter` 捕获 PostgreSQL `23505` 唯一约束错误并转译为
  `UniqueViolationError`，注册流程进一步转译为 `UserExistsError` /
  `SocialAccountConflictError`（消除 TOCTOU 裸错误）。
- 新增 `getClientIp(ctx)`、`buildPlaceholderEmail(provider, openid)`。

### 修复

- **占位邮箱碰撞**：`{provider}_{openid}@oauth.usercenter` 不再截断
  openid（截断会让不同 openid 生成相同邮箱，触发唯一约束冲突）。
- **`authenticateChannel` 非密码凭证契约**：`credential.type !==
  "password"` 时必须显式声明 `credential.verified = true`（调用方
  已完成验证），否则抛 `CredentialInvalidError`；已有渠道分支去除
  重复的用户读取。
- `auth.db` 门面改为惰性缓存（此前每次访问新建）。

### 设计决策记录

- signUp 邮箱重复提示保留"该邮箱已被注册"明文（注册场景需即时反馈，
  与 signIn 的防枚举策略有意区分）。

## 2.0.1（2026-08-13）

> 修复 2.0.0 发布的 Prisma schema 表名映射缺陷。2.0.0 用户建议尽快升级。

### 修复

- **Prisma 与 DDL 表名一致**：生成的 Prisma schema 为每个 model 补充
  `@@map("表名")`，使 Prisma model（大写）映射到 DDL 创建的小写表
  （`user` / `account` / `socialAccount`）。2.0.0 生成的 schema 缺失该映射，
  会导致 Prisma 与 SDK 访问不同的表（PostgreSQL 带引号标识符区分大小写）。
- **CHANGELOG.md 随包发布**：加入 `files` 字段。

## 2.0.0（2026-08-13）

> **重大版本**：引入 schema 单一事实源架构。所有表结构只在 `src/schema.ts` 定义一次，
> TypeScript 类型、SQL DDL、Prisma schema 均由它派生。升级前请先阅读下方【升级指南】。

### 核心变化

#### 1. Schema 单一事实源

新增 Drizzle 风格的轻量 DSL（`src/schema.ts`），由此一处定义派生三样产物：

| 产物 | 生成方式 | 消费者 |
|---|---|---|
| TS 行类型（`UserRow` / `AccountRow` / `SocialAccountRow`） | `InferSelect` 编译期推导 | typed 门面 `auth.db.*` |
| SQL DDL | `generateDDL` 运行时生成 | `npx omni-auth db:push` |
| Prisma schema（认证三表） | `generatePrismaModels` | app 合并脚本 |

修改表结构只需改 `schema.ts`，重新构建后运行 codegen 即可同步全部产物。

#### 2. 类型化数据访问门面

`auth.db` 新增按表分组的类型化视图，编译期校验表名与列名：

```ts
// 新写法（推荐）：返回 UserRow | null，field 限定为 user 列名
const user = await auth.db.user.findOne({ where: [{ field: "email", value }] });

// 旧写法仍可用，但已标记 @deprecated
auth.db.findOne({ model: "user", where: [...] });

// 以下写法会在编译期直接报错
auth.db.user.create({ data: { role: "user" } });          // 无 role 列
auth.db.user.findOne({ where: [{ field: "emial", ... }] }); // 列名拼错
```

#### 3. db:push 运行时生成 DDL

`npx omni-auth db:push` 不再携带硬编码的表清单，改为从 `schema.ts` 运行时生成
DDL（幂等：`IF NOT EXISTS`），行为不变（不删表、不删列、不改类型）。

#### 4. 新增 Prisma codegen CLI

```
npx omni-auth codegen            # 输出 Prisma schema 到 stdout
npx omni-auth codegen --out xxx  # 写入文件
```

新增子路径导出：`omni-auth/schema`、`omni-auth/codegen-ddl`、`omni-auth/codegen-prisma`。

### 破坏性变更

1. **`PublicUser.role` 已移除**。该字段从未有对应列支撑（无任何 schema 定义过 role
   列），恒为 `null`，故在 2.0.0 移除。
2. **`auth.db.businessAccount` 表视图已移除**。`businessAccount` 是 app 业务表，
   不再属于 SDK schema；app 侧应通过自己的 Prisma repository 访问。
3. **`BusinessAccountRow` 类型已从包入口移除**。
4. **数据库表名统一为小写**（`user` / `account` / `socialAccount`）。
   2.0.1 起生成的 Prisma schema 通过 `@@map` 与 DDL 保持一致。已有数据库若使用的
   是旧版 PascalCase 表名（`User` / `Account` / `SocialAccount`），需要执行一次
   表名迁移，见下方升级指南。
5. **`db:push` 不再创建 `businessAccount` 表**。app 业务表的建表责任回归 app 自身。

### 修复

- **pg 成为正式依赖**：`PgAdapter` 与 `db:push` 运行时需要 `pg`，此前仅为
  devDependency，外部消费者使用声明式 `database: { url }` 配置时会
  `ERR_MODULE_NOT_FOUND`。

### 升级指南

#### 依赖与代码

```sh
pnpm add omni-auth@2.0.1
```

代码层迁移：

1. 若引用了 `PublicUser.role` / `BusinessAccountRow` / `auth.db.businessAccount`，
   相应删除或改用自有数据层。
2. 泛型 `auth.db.findOne({ model, ... })` 调用不受影响（已弃用但仍可用），
   建议迁移到类型化表视图。

#### app 侧集成（使用 Prisma 的项目）

旧的 `schema.declarative.json` 已废弃，Prisma schema 改为生成产物：

```sh
pnpm update:prisma        # 合并 SDK 三表 + app 自定义表 → prisma/schema.prisma
pnpm exec prisma generate # 刷新 Prisma Client
npx omni-auth db:push     # 同步数据库
```

#### 已有数据库迁移

若数据库中的 SDK 表是旧版 PascalCase（由旧 `sync.ts` 创建），执行：

```sql
ALTER TABLE IF EXISTS "User" RENAME TO "user";
ALTER TABLE IF EXISTS "Account" RENAME TO "account";
ALTER TABLE IF EXISTS "SocialAccount" RENAME TO "socialAccount";

-- 无任何代码引用的孤儿表
DROP TABLE IF EXISTS "Verification";
```

注意：若数据库里同时存在旧 db-push 创建的小写表和 sync.ts 创建的 PascalCase 表
（两套数据），请先核对数据归属再决定保留哪一份，避免丢数据。

`businessAccount` 表（PascalCase）属于 app 业务表，保持不变。

#### 新环境初始化

```sh
npx omni-auth db:push                    # 创建 SDK 三表（user/account/socialAccount）
# app 业务表（businessAccount）由 app 自己的迁移流程创建
```

### 兼容性

- `DatabaseAdapter` SPI 接口签名不变，自定义适配器无需改动。
- 泛型 CRUD 方法（`db.findOne` 等）保留并标记 `@deprecated`，预计下个 major 移除。
- `WhereCondition` 泛型化（`WhereCondition<Field extends string = string>`），
  现有无参用法完全兼容。

### 移除的过往弃用项

- `ChangfengAuth` / `ChangfengAuthConfig` 别名仍保留（自 0.6.0 起弃用），未在本次移除。

## 1.1.0

- 引入 `auth.db` 泛型数据访问直通（字符串表名 + unknown 返回）。
- 引入 `schema.declarative.json` 驱动的启动时 schema 同步（app 侧）。