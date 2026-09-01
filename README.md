# omni-auth 应签尽签 · 全渠道认证 SDK

> 把**整个认证域**封装成黑盒的框架无关 SDK：凭证校验、用户/渠道记录、会话、OAuth 2.0 Server、SCIM 管理面全部住在包内，宿主**零 SQL、零表名、零事务编排**；邮箱、手机、微信、GitHub 一律是**平权的渠道**。

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![next](https://img.shields.io/badge/peer-next%20%3E%3D16%20%28optional%29-000000)
![module](https://img.shields.io/badge/module-ESM%20%2B%20CJS-orange)

---

## 目录

- [为什么需要它](#为什么需要它)
- [核心概念](#核心概念)
- [数据流：一次认证发生了什么](#数据流一次认证发生了什么)
- [快速开始](#快速开始)
- [指南](#指南)
  - [渠道模型（全渠道平权）](#渠道模型全渠道平权)
  - [认证入口（signUp / signIn / authenticateChannel）](#认证入口signup--signin--authenticatechannel)
  - [认证域语义 API](#认证域语义-api)
  - [外部 OAuth Provider 登录](#外部-oauth-provider-登录)
  - [渠道验证码（委托模式）](#渠道验证码委托模式)
  - [自动建表 / 迁移（schema 单一事实源）](#自动建表--迁移schema-单一事实源)
  - [速率限制与安全加固](#速率限制与安全加固)
  - [令牌权威委托（TokenAuthorityClient）](#令牌权威委托tokenauthorityclient)
  - [在 Next.js 中接入](#在-nextjs-中接入)
- [错误码](#错误码)
- [API 参考](#api-参考)
- [设计原则](#设计原则)
- [项目结构](#项目结构)
- [开发](#开发)
- [License](#license)

---

## 为什么需要它

当你需要在自己的应用里落地一套**生产级认证**时，会反复遇到同一批问题：

- 邮箱、手机、微信、GitHub……每个渠道的凭证形态、token 生命周期、资料结构都不一样，特判代码越堆越乱；
- 会话、密码重置、OAuth 2.0 授权码 / 令牌、SCIM 目录管理面——每一块都是**又深又安全敏感**的轮子，重复造且容易造错；
- 认证表散落在宿主库里，宿主到处 JOIN `user` 表、自己编排级联删除，认证逻辑和业务逻辑缠死；
- 表结构在 schema、类型、DDL、Prisma 之间**多处定义、极易漂移**；
- access token 的签发/校验需要接入集群证书服务，认证 SDK 不该自己实现令牌加密算法。

omni-auth 的回答是**认证域黑盒 + 全渠道平权 + 语义 API + 单一事实源**：

- 整个认证域（五张表 + 全部逻辑）是包内私有黑盒，宿主只经**语义 API** 访问，不碰一行 SQL；
- 邮箱降级为**普通渠道**，代码只关心抽象的「渠道」，从不关心具体渠道实现，占位邮箱 / 随机密码 / 渠道特判随之消亡；
- 会话、用户管理、OAuth Server、SCIM 收敛为 `auth.sessions.* / auth.users.* / auth.oauthServer.* / auth.scim.*` 命名空间；
- 表结构由包内 `schema.ts` **单一管理**，TS 类型 / SQL DDL / Prisma schema 均由它派生，`autoSync` 与 `db:push` 复用同一实现；
- 令牌签发/校验**委托**宿主注入的 `TokenAuthorityClient`，包内不实现令牌算法。

---

## 核心概念

| 概念 | 说明 | 定义 / 入口 |
| --- | --- | --- |
| **认证域黑盒** | 五张表（`user` / `socialAccount` / `session` / `oauthToken` / `oauthClient`）与全部认证逻辑包内私有；宿主零 SQL、零表名、零事务编排。 | `packages/omni-auth` |
| **渠道（Channel）** | 一切身份来源皆渠道：邮箱 = `(provider="email", providerOpenid=邮箱)`，与微信 / GitHub 完全同构。`socialAccount` 承载渠道身份与该渠道的 token / 资料 / 能力标记。 | `authenticateChannel()` |
| **共享密码** | 密码以共享语义存放于 `user.password`（可空，OAuth-only 用户为 `null`）；任何渠道的密码登录都验同一个哈希。 | `user.password` |
| **语义 API** | 认证域四大命名空间：会话 / 用户管理 / OAuth Server / SCIM，宿主唯一的接口面。 | `auth.sessions` 等 |
| **schema 单一事实源** | 表结构只在 `schema.ts` 定义一次，派生 TS 行类型 / SQL DDL / Prisma schema；`autoSync` 与 CLI `db:push` 同源。 | `schema.ts` / `syncSchema()` |
| **注入式连接池** | SDK 不建池、不关池，连接池由宿主注入（最小结构接口 `PgPoolLike`），认证域与业务域共享同一池。 | `createQuickAuth({ database: { pool } })` |
| **令牌权威委托** | access token 签发 / 校验 / 续期 / 吊销委托宿主的 `TokenAuthorityClient`（如集群证书服务），包内不实现令牌加密。 | `config.tokenAuthority` |
| **实例级注册表** | OAuth provider / 验证码 sender·verifier / token refresher / 审计处理器均为实例成员，多实例互不干扰。 | `OmniRegistry` |

**渠道平权**是理解 omni-auth 的关键：不存在「邮箱用户」和「社交用户」之分，只有「聚合身份 `user` + 若干渠道 `socialAccount`」。`signUp` / `signIn` 只是 email 渠道的便捷方法，其余渠道一律走 `authenticateChannel`。

---

## 数据流：一次认证发生了什么

```
凭证（email/password 或 渠道 credential）
  │  ▸ 速率限制（signUp 按 ip；signIn 按 ip:provider:openid）
  │  ▸ 密码策略校验 / 非密码凭证契约校验（verified 必须为 true）
  ▼
渠道反查 socialAccount (provider, providerOpenid)
  │  不存在 → 事务写入 user + socialAccount ── commit ──▶ onUserCreated 钩子
  │  已存在 → 反查 user（密码凭证走 verifyPassword；非密码凭证信任调用方）
  ▼
审计事件（signUp / signIn / signInFailed）
  ▼
返回 { userId, user }
```

- **多表写入原子化**：注册（`user` + `socialAccount`）与删用户级联（`session` / `socialAccount` / `oauthToken` / `user`）包入 `DatabaseAdapter.transaction`，任一步失败整体回滚；适配器未实现事务时回退顺序写入并**仅警告一次**。
- **钩子在 commit 之后触发**：`onUserCreated` 不会看到未提交的数据，其失败仅记录、不影响认证结果。
- **枚举防护**：`signIn` 无论「无渠道 / 无用户 / 密码错」都抛统一消息「邮箱或密码错误」；`signUp` 邮箱重复则有意返回明文提示（注册场景需即时反馈）。

外部 OAuth Provider 回调另有独立链路：`auth.oauth.initiateOAuth()` 发起（保存签名 `state` / PKCE `codeVerifier`）→ `auth.handleOAuthCallback()` 库内强制比对 `state` → 换 token → `authenticateChannel` 落库/登录。

---

## 快速开始

### 安装

```bash
pnpm add omni-auth pg          # pg 是运行时依赖（连接池由宿主注入）
# next 为可选 peer 依赖（>=16），仅 omni-auth/nextjs 入口需要
```

要求 Node >= 18。产物同时提供 ESM / CJS / 类型声明。

### 最小示例（Next.js 一站式）

```ts
import { createQuickAuth } from "omni-auth/nextjs";
import type { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 连接池由宿主注入；autoSync 自动执行幂等建表 / 迁移
export const auth = createQuickAuth({
  database: { pool },
  baseUrl: process.env.BETTER_AUTH_URL!,
  autoSync: true,
});

// —— 凭证校验（email 渠道便捷方法）——
await auth.signUp({ email, password, name });
await auth.signIn({ email, password });

// —— 认证域语义 API ——
await auth.sessions.createSession(userId);            // 会话
await auth.users.updateUser(userId, { active: false }); // 用户管理（禁用即时失效会话）
await auth.oauthServer.createOAuthClient({ clientName }); // OAuth 客户端
await auth.scim.list({ pagination: { startIndex: 1, count: 20 }, filter: null }); // SCIM 目录
```

建表（等价于 `autoSync`，可单独执行）：

```sh
npx omni-auth db:push
```

> 框架无关的底座入口是 `createAuth({ database, baseUrl })`（`omni-auth`），`createQuickAuth`（`omni-auth/nextjs`）是它叠加「连接池注入 + 自动建表 + 构建期跳过」的一站式封装。

---

## 指南

### 渠道模型（全渠道平权）

认证域共五张表（`schema.ts` 单一事实源）：

| 表 | 职责 | 关键约束 |
| --- | --- | --- |
| `user` | 聚合身份 + 共享密码（`password` 可空）+ 元数据列 `active`（0/1，历史 boolean 读取时归一化） | 主键 `id` |
| `socialAccount` | 渠道身份，持有该渠道的 token / 资料 / 能力标记（`valid` / `allowPasswordUpdate` / `allowVerification`） | `unique(provider, providerOpenid)`；`userId` 级联删除 |
| `session` | 宿主会话（`id` / `userId` / `token` / `expiresAt` / `createdAt`） | 主键 `id` |
| `oauthToken` | 授权码 + refresh token 生命周期 | `unique(token, type)` |
| `oauthClient` | OAuth 客户端凭证（`client_secret` 由 Token Authority 证书承载） | `client_id` 唯一 |

- **邮箱是普通渠道**：`(provider="email", providerOpenid=邮箱地址)`，与微信、GitHub 完全同构；
- 任何渠道密码登录都验证同一个 `user.password`（共享密码）；
- OAuth 新用户不再生成随机密码，`password = null`，后续可经渠道验证码从无到有设置。

### 认证入口（signUp / signIn / authenticateChannel）

| 方法 | 场景 | 说明 |
| --- | --- | --- |
| `signUp(input, ctx?)` | email 渠道注册 | 事务创建 `user` + email 渠道（`valid=1`）；邮箱重复抛 `UserExistsError`；按 IP 限流 |
| `signIn(input, ctx?)` | email 渠道登录 | 渠道反查用户 → 验共享密码；统一错误消息防枚举；成功后重置限流计数 |
| `authenticateChannel(input, ctx?)` | **全渠道统一入口** | 渠道不存在则新建用户 + 绑定，已存在则登录；其余渠道一律走此方法 |

**非密码凭证契约**：`authenticateChannel` 对 `smsCode` / `oauthCode` 等凭证**不代为验证**，调用方必须预先验证并显式声明 `credential.verified = true`，否则抛 `CredentialInvalidError`。这是有意设计——库不假装能验证它无法验证的东西。

```ts
await auth.authenticateChannel({
  provider: "wechat",
  providerOpenid: openid,
  credential: { type: "oauthCode", value: code, verified: true }, // 调用方已验证
  profile: { name: nickname },
  channelData: { accessToken, refreshToken, profileData },
});
```

### 认证域语义 API

宿主唯一接口面，四大命名空间（禁止直连认证表）：

| 命名空间 | 职责 |
| --- | --- |
| `auth.sessions.*` | 创建 / 校验 / 吊销会话、销毁用户全部会话、清理过期（`validateSession` 内置账号禁用即时失效） |
| `auth.users.*` | 创建 / 更新 / 查询 / 列表搜索 / 级联删除、改密码（改密即吊销全部会话） |
| `auth.oauthServer.*` | 客户端 CRUD / 续期、授权码、refresh token、access token（委托 `TokenAuthorityClient`）、清理过期令牌 |
| `auth.scim.*` | SCIM 2.0 用户目录：`authenticate` / `list` / `get` / `create` / `update` / `patch` / `remove` |
| `auth.social`（内部） | 渠道绑定 / 解绑 / 查询 / token 刷新 |

`validateSession(token)` 会读 `user.active`，账号禁用后旧会话**立即失效**——宿主无需再 JOIN `user` 表自行判断。

### 外部 OAuth Provider 登录

内置 Google / GitHub / 微信 provider 工厂，注册进实例级注册表后即可发起与回调：

```ts
import { createGitHubProvider } from "omni-auth";

auth.registerOAuthProvider(createGitHubProvider({ clientId, clientSecret }));

// 发起：返回授权 URL，同时给出 state / codeVerifier（调用方写入签名 cookie）
const { authorizationUrl, state, codeVerifier } = await auth.oauth.initiateOAuth("github", redirectUri);

// 回调：对象形式参数强制库内比对 state（防 CSRF）
const result = await auth.handleOAuthCallback("github", code, redirectUri, {
  state: body.state,
  expectedState: cookies.get("oauth_state")?.value,   // 必须来自服务端保存值
  codeVerifier: cookies.get("oauth_code_verifier")?.value,
});
// result.isNewUser 为 true 时，onUserCreated 钩子已在 commit 后触发
```

> 注意区分：`auth.oauth` 是**外部 provider 登录 handler**（Google/GitHub/微信）；`auth.oauthServer` 是**面向宿主应用的 OAuth 2.0 Server**（授权码 / 令牌 / 客户端），二者勿混淆。

### 渠道验证码（委托模式）

验证码的**投递**与**验证**都委托给宿主注册的 sender / verifier，库只负责生成密码学安全的种子码与编排：

```ts
auth.registerVerificationSender("phone", { send: async (openid, code) => smsGateway.send(openid, code) });
auth.registerVerificationVerifier("phone", { verify: async (openid, code) => smsGateway.check(openid, code) });

const code = await auth.requestChannelCode("phone", phone);  // 生成 6 位种子码，注册了 sender 则同步投递
const ok = await auth.verifyChannelCode("phone", phone, userInput); // 委托 verifier 判定，无条件透传结果
```

配置 `rateLimit.verifyCode` 后，`verifyChannelCode` 按 `provider:providerOpenid` 限流（防短验证码爆破），验证成功时重置计数。

### 自动建表 / 迁移（schema 单一事实源）

表结构由包内 `schema.ts` 单一管理，`schema-sync.ts` 负责同步：

- `createQuickAuth({ autoSync: true })` 初始化时自动执行（幂等，可重复运行）；
- `npx omni-auth db:push` CLI 复用同一实现；
- **安全策略**：不删表、不删列、不修改已有列类型；仅 `CREATE TABLE IF NOT EXISTS` / 缺失列 `ADD COLUMN` / 旧版小写折叠列名 `RENAME` 保真；
- 同步结果：`{ synced, missingTables, addedColumns }`；
- **构建期安全**：`autoSync` 在 Next.js 生产构建阶段（`NEXT_PHASE=phase-production-build`）自动跳过，避免构建期触碰数据库；环境变量 `AUTO_SYNC_DB=false` 可整体关闭。

改表结构只改 `schema.ts`，重新 build 包即可；`codegen-ddl` / `codegen-prisma` 自动派生 DDL 与 Prisma schema。从 4.x 升级到 5.x 渠道模型需运行数据迁移：

```sh
pnpm migrate:v5 -- --dry-run    # 先核对 SQL（account.password → user.password、补建 email 渠道、DROP account）
pnpm migrate:v5                 # 执行前请备份（要求 PostgreSQL 13+）
```

### 速率限制与安全加固

默认限流器为**进程内存实现**，仅适用于单进程 / 开发环境。多实例 / serverless 部署请注入共享存储实现（如 Redis）：

```ts
import type { RateLimiter } from "omni-auth";

const redisLimiter: RateLimiter = {
  async check(key, maxAttempts, windowMs) { /* Redis INCR + EXPIRE */ },
  async reset(key) { /* DEL key */ },
};

export const auth = createQuickAuth({
  database: { pool },
  baseUrl,
  rateLimit: {
    limiter: redisLimiter,
    // 可信代理部署：从 x-forwarded-for 右侧数 1 跳，防头部伪造绕过限流
    getClientIp: (ctx) => getClientIp(ctx, { trustedProxyDepth: 1 }),
    verifyCode: { maxAttempts: 5, windowMs: 10 * 60 * 1000 }, // 防短验证码爆破
  },
  passwordPolicy: { minLength: 8 },
});
```

限流键策略：

| 接口 | 键 | 默认策略 |
| --- | --- | --- |
| `signUp` | 客户端 IP | 3 次 / 1 小时 |
| `signIn` | `ip:provider:openid` | 5 次 / 15 分钟（成功后重置计数） |
| `passwordReset` | `ip:provider:openid` | 3 次 / 10 分钟 |
| `verifyChannelCode` | `provider:openid` | 默认关闭，opt-in |

`signUp` 按 IP 而非邮箱限流，防止攻击者消耗受害者邮箱配额、锁死其注册的 DoS。

### 令牌权威委托（TokenAuthorityClient）

access token 的签发 / 校验 / 续期 / 吊销**委托**宿主注入的 `TokenAuthorityClient`（如集群证书服务 `yunzone_auth`），包内不实现令牌加密算法。未注入时，`auth.oauthServer` 的令牌能力给出明确错误（`TOKEN_AUTHORITY_NOT_CONFIGURED`），而非静默失败。

```ts
export const auth = createQuickAuth({
  database: { pool },
  baseUrl,
  tokenAuthority: {
    issueCertificate, introspectCertificate, refreshCertificate, revokeCertificate,
    getDefaultProductId,
  },
});

const { token, expiresAt } = await auth.oauthServer.issueUserAccessToken(userId, ["openid", "profile"]);
const info = await auth.oauthServer.verifyUserAccessToken(token);   // null 表示无效
```

授权码（`createCode` / `consumeCode`，含 PKCE）与 refresh token（`issueRefreshToken` / `consumeRefreshToken`）由包内 `oauthToken` 表本地管理；仅 access token 委托外部权威。

### 在 Next.js 中接入

`omni-auth/nextjs` 提供会话 cookie 辅助与请求上下文构建，宿主用 route handler 薄壳接入即可（认证逻辑仍全在 SDK 内）：

```ts
import { nextjsRequestContext, setSessionCookie, getSessionTokenFromCookies, SESSION_COOKIE } from "omni-auth/nextjs";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

// 登录：把 requestContext 传入以启用按 IP 限流，会话 cookie 写入 Response
const ctx = nextjsRequestContext(await headers());
const { userId } = await auth.signIn({ email, password }, ctx);
const { token } = await auth.sessions.createSession(userId);
const response = NextResponse.json({ ok: true });
setSessionCookie(response, token);   // HttpOnly / SameSite=Lax（生产加 Secure）
return response;

// 鉴权：从 cookie 取 token → validateSession（内置账号禁用即时失效）
const token = await getSessionTokenFromCookies();  // 内部读取 cookies()
const uid = token ? await auth.sessions.validateSession(token) : null;
```

演示 / 开发宿主见 [`apps/demo`](./apps/demo)（Next.js），仅用于手动验证 SDK 行为，非产品、不参与发布；生产集成建议走 HTTP 消费（`/api/auth/*`）而非在多处实例化认证写侧。

---

## 错误码

所有 SDK 错误继承 `OmniAuthError`（带机器可读 `code`），消费方可按 `instanceof` / `code` 做程序化处理：

| 错误类 | code | 触发场景 |
| --- | --- | --- |
| `UnauthorizedError` | 由构造传入 | RBAC 校验失败（`requireRole` / `requireAnyRole`） |
| `InvalidPasswordError` | `INVALID_PASSWORD` | 密码错误（消息统一防枚举） |
| `UserExistsError` | `USER_EXISTS` | 邮箱渠道已注册 |
| `SocialAccountConflictError` | `SOCIAL_ACCOUNT_CONFLICT` | 渠道已被其他用户绑定 |
| `WeakPasswordError` | `WEAK_PASSWORD` | 密码长度不足（默认最短 8） |
| `CredentialInvalidError` | `CREDENTIAL_INVALID` | 非密码凭证未声明 `verified=true` |
| `OAuthStateMismatchError` | `OAUTH_STATE_MISMATCH` | OAuth `state` 缺失或不匹配 |
| `RateLimitedError` | `RATE_LIMITED` | 超过限流（含 `retryAfterSeconds`） |
| `OmniAuthError` | `USER_NOT_FOUND` | 引用的用户记录已不存在 |
| `OmniAuthError` | `TOKEN_AUTHORITY_NOT_CONFIGURED` | 未注入 `TokenAuthorityClient` 却调用令牌能力 |
| `OmniAuthError` | `UNIQUE_VIOLATION` | 数据库唯一约束冲突（pg 23505，由适配器转译） |

> **唯一约束不设专用类**：数据库 23505 由适配器转译为 `code=UNIQUE_VIOLATION` 的 `OmniAuthError`，用守卫 `isUniqueViolation(err)` 判断——避免与宿主基础设施（`yunzone-service-kit`）的同名错误类形成「同名不同类型」陷阱，跨抽象统一按 `err.code` 判断。

OAuth Server 与 SCIM 各有独立错误族：`OAuthError`（`invalidGrant` / `invalidClient` / `invalidRequest` / `unsupportedGrantType` / `invalidScope`）与 `ScimError`（`notFound` / `invalidValue` / `invalidSyntax` / `unauthorized` / `conflict` / `internalError`）。

---

## API 参考

主入口 `omni-auth`：

| 分类 | 导出 |
| --- | --- |
| 工厂 / 主类 | `createAuth`、`OmniAuth` |
| 错误 | `OmniAuthError`、`InvalidPasswordError`、`UserExistsError`、`SocialAccountConflictError`、`WeakPasswordError`、`CredentialInvalidError`、`OAuthStateMismatchError`、`UnauthorizedError`、`RateLimitedError`、`isUniqueViolation` |
| 适配器 | `DatabaseAdapter`、`withTransaction`、`PgAdapter`、`createRequestContext`、`getClientIp` |
| Schema | `schema`、`user`、`socialAccount`、`session`、`oauthToken`、`oauthClient`、`syncSchema`、`generateDDL`、`generatePrismaSchema`、DSL（`table` / `text` / `integer` / `boolean` / `jsonb` / `timestamptz`） |
| OAuth Server | `OAuthError`、`parseScope`、`negotiateScope`、`hasScope`、`verifyPKCE`、`generateCodeChallenge`、`SUPPORTED_SCOPES`、`DEFAULT_SCOPE` |
| 外部 OAuth | `createOAuthHandler`、`createGoogleProvider`、`createGitHubProvider`、`createWechatProvider` |
| SCIM | `createScimUserHandler`、`userSchema`、`allSchemas`、`getSchemaById`、`ScimError`、`parseFilter`、`parsePagination`、`buildListResponse` |
| 会话 / 用户 | `SESSION_TTL_MS`、`normalizeUserFlag`、`normalizeEmail`、`SessionService`、`UserAdminService` |
| 验证码 / 限流 / 审计 | `createMemoryRateLimiter`、`checkRateLimit`、`extractAuditContext`、`isSameOrigin`、`createOriginCheck` |
| RBAC | `hasRole`、`hasAnyRole`、`requireRole`、`requireAnyRole` |

子入口：

| 子入口 | 用途 |
| --- | --- |
| `omni-auth/nextjs` | `createQuickAuth`、`nextjsRequestContext`、会话 cookie 辅助（`setSessionCookie` / `clearSessionCookie` / `getSessionTokenFromCookies` / `SESSION_COOKIE`） |
| `omni-auth/request` | `createRequestContext`、`getClientIp`、`RequestContext` |
| `omni-auth/adapters/pg` | `PgAdapter`、`PgPoolLike` |
| `omni-auth/client` | 浏览器 / 边缘侧轻量客户端 |
| `omni-auth/schema` | schema 定义与派生类型 |
| `omni-auth/codegen-ddl` / `omni-auth/codegen-prisma` | DDL / Prisma schema 生成 |

CLI（`bin/`）：

| 命令 | 说明 |
| --- | --- |
| `npx omni-auth db:push` | 从 `schema.ts` 生成 DDL 并幂等同步（不删表 / 不删列 / 不改类型） |
| `npx omni-auth-codegen` | 输出 Prisma schema（`--out` 写文件） |
| `pnpm migrate:v5` | 4.x → 5.x 渠道模型数据迁移（支持 `--dry-run`） |

`OmniAuth` 实例主要成员：

| 成员 | 说明 |
| --- | --- |
| `signUp` / `signIn` / `authenticateChannel` | 认证入口（见指南） |
| `requestPasswordReset` / `resetPassword` | 密码重置（委托渠道验证码） |
| `requestChannelCode` / `verifyChannelCode` | 渠道验证码（委托 sender / verifier） |
| `registerOAuthProvider` / `oauth` / `handleOAuthCallback` | 外部 OAuth 登录 |
| `registerVerificationSender` / `registerVerificationVerifier` / `registerTokenRefresher` | 实例级注册 |
| `setAuditHandler` | 实例级审计处理器 |
| `sessions` / `users` / `oauthServer` / `scim` / `social` | 认证域语义 API 命名空间 |
| `db` | 类型化数据访问门面（`db.user.*` / `db.socialAccount.*`，认证域内部使用） |
| `OmniAuth.hasRole` 等静态方法 | RBAC 检查 |

---

## 设计原则

- **认证域黑盒**：整个认证域（五表 + 全部逻辑）包内私有，宿主只经语义 API 访问，零 SQL、零表名、零事务编排。
- **全渠道平权**：邮箱是普通渠道，代码只关心抽象「渠道」，从不存在渠道特判——占位邮箱 / 随机密码 / 手机合成邮箱等特化机制全部消亡。
- **schema 单一事实源**：表结构只定义一次，TS 类型 / DDL / Prisma 均派生；改表只改 `schema.ts`，`autoSync` 与 `db:push` 同源。
- **连接池单一来源（宿主注入）**：SDK 不建池、不关池，认证域与业务域共享同一池，类型上以最小结构 `PgPoolLike` 解耦（零依赖 kit）。
- **令牌权威委托**：access token 算法委托外部证书服务，包内不实现加密；未注入即明确报错，绝不静默降级。
- **多表写入原子化**：注册与级联删除包入事务，钩子在 commit 后触发；适配器无事务时回退顺序写入并警告。
- **安全默认**：`signIn` 防枚举、`signUp` 按 IP 限流防 DoS、OAuth `state` 库内强制比对、非密码凭证契约显式化。
- **构建期不碰库**：生产构建阶段自动跳过 `autoSync`，避免构建环境无 DB 凭证时阻断。

---

## 项目结构

```
omni-auth/
├─ packages/omni-auth/          # 唯一产品：SDK 源码 + CLI + 测试 + 发布配置
│  ├─ src/
│  │  ├─ index.ts               公共出口
│  │  ├─ auth.ts                OmniAuth 主类（认证入口 + 语义 API 装配）
│  │  ├─ errors.ts              OmniAuthError 错误族
│  │  ├─ schema.ts              认证表定义（单一事实源）
│  │  ├─ schema-builder.ts      Drizzle 风格轻量 DSL + 类型推导
│  │  ├─ schema-sync.ts         幂等建表 / 迁移（autoSync 与 db:push 同源）
│  │  ├─ codegen-ddl.ts         DDL 生成
│  │  ├─ codegen-prisma.ts      Prisma schema 生成
│  │  ├─ models.ts              类型化数据访问门面（DbFacade）
│  │  ├─ registry.ts            实例级注册表（OmniRegistry）
│  │  ├─ adapters/              DatabaseAdapter SPI + RequestContext
│  │  ├─ builtin/pg/            PgAdapter（注入式连接池）
│  │  ├─ core/                  session / user-admin / password / rateLimit / audit / roles / origin / verification-channel
│  │  ├─ oauth/                 server（OAuth 2.0 Server）+ handler + providers（google/github/wechat）
│  │  ├─ scim/                  SCIM 2.0 handler / schemas / types
│  │  ├─ social/                渠道绑定 / 解绑 / token 刷新
│  │  └─ nextjs/                createQuickAuth + 会话 cookie 辅助
│  ├─ bin/                      db-push.mjs / codegen.mjs / migrate-v5.mjs
│  ├─ CHANGELOG.md              版本与破坏性变更记录
│  └─ README.md                 SDK 使用文档
├─ apps/demo/                   演示 / 开发宿主（Next.js），非产品、不发布
└─ .github/workflows/           发布流水线（只发布 packages/omni-auth 到 npm）
```

---

## 开发

```bash
pnpm install             # 安装 workspace 依赖
pnpm build               # 构建 SDK（tsup → packages/omni-auth/dist，ESM + CJS + 类型 + sourcemap）
pnpm test                # 运行 SDK 测试（vitest）
pnpm typecheck           # SDK 类型检查（tsc --noEmit）
pnpm dev                 # 启动演示宿主（apps/demo，Next.js dev server）
pnpm publish             # 发布 SDK 到 npm（--access public）
```

发布流程由 GitHub Actions（[`.github/workflows/publish.yml`](./.github/workflows/publish.yml)）驱动：手动触发或 GitHub Release 发布时构建并发布 `omni-auth` 包。版本迭代与破坏性变更记录见 [`packages/omni-auth/CHANGELOG.md`](./packages/omni-auth/CHANGELOG.md)；完整边界约定见 [`AGENTS.md`](./AGENTS.md)。

---

## License

MIT（见 [`packages/omni-auth/package.json`](./packages/omni-auth/package.json) 的 `license` 字段）。
