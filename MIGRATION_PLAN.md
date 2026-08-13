# OmniAuth 解耦迁移计划（API 凭证模式）

> 生成日期：2026-08-12 ｜ 修订日期：2026-08-12 ｜ 状态：已评审通过，待实施 ｜ 目标版本：omni-auth v1.0（major 版本，允许破坏性变更）
>
> 本计划为决策完整文档：实施者无需再向用户确认任何设计决策。每个里程碑的验收标准必须全部通过才算完成。

---

## 0. 修订记录

本版相对初版的主要变更：

1. **删除 productId 体系**：SDK 仅负责凭证发行与校验，产品间隔离由产品层自行管理（删除原 D10/§5.6，简化 D11，删除 `revokeProductTokens`）
2. **删除滑动续期与 get-session 路由**：token 固定过期，产品层通过吊销接口自管会话生命周期；`getContext`/`requireContext` 为唯一校验入口，支持 cookie 与 Authorization header（删除原 D12，不新建 get-session HTTP 路由）
3. **删除 Edge middleware**：hash-based token 无法在 Edge 本地验签，且 get-session 路由已删除，`createEdgeMiddleware` 不再保留
4. **修正 M1 编排**：`getBetterAuthHandler`/`signSessionToken` 的删除从 M1 移至 M2（避免消费者编译断裂）
5. **补充遗漏项**：`authenticateChannel`/`bindChannel`/`unbindChannel`/`change.*` 方法适配说明、`betterAuthTypes.ts` 去向、验证码改用 `crypto.randomInt()`、`createDefaultMiddleware` 去向
6. **补充实施要求**：upsert 必须 DB 级原子操作、OAuth handler 必须发布审计事件、M4 清理 `autoCreateBusinessAccount` 死代码、`@better-auth/core` 版本锁用 `~`
7. **架构定位收敛**：SDK = 凭证发行器 + 凭证校验器；多设备会话、产品级权限映射由产品层实现

---

## 1. 背景与目标

### 1.1 问题

1. **身份模型冲突**：本库核心价值是"所有渠道平权"（身份锚点 = `(provider, providerOpenid)`），而 better-auth 以 email 为中心（user.email 唯一、signInEmail/signUpEmail 硬编码 email 路径、OAuth 按 email 关联账户）。两者在机制层面互斥，为兼容 better-auth 产生了大量 hack：
   - `adapter-bridge.ts`：方法名/运算符/join 翻译 + "必须以函数形式传入否则走 Kysely 路径抛错"
   - `signSessionToken`：复刻 better-auth cookie 签名格式
   - `_createSessionForUser` / OAuth handler 直插 session 表（绕过 better-auth session 机制）
   - `verification-channel.ts` 复用 verification 表但绕过 better-auth 校验逻辑（导致清理脱节、存储泄露）
   - `databaseHooks` 深度合并、`checkExpiredSessions` 补钩子（自带 bug）
2. **存储泄露**：Session 表无定时清理（better-auth 1.6.26 无内置清理任务），过期记录永久累积；渠道验证码过期记录无清理路径。
3. **版本耦合**：peerDependency `^1.6.26` 宽松范围 + 对内部实现的逆向依赖，升级即碎。

### 1.2 决策前提（已确认）

- **无迁移用户**：不做任何兼容迁移，允许破坏性变更（删除 API、改 cookie 格式、删表）。
- **认证模式 = API 凭证（token 有记录，cookie 承载）**：
  - 服务端维护 `AuthToken` 表（token 只存 SHA-256 哈希，明文不落库）
  - token 通过 httpOnly cookie 承载（浏览器场景），登录 API 同时返回明文 token（非浏览器场景）
  - 不使用自包含签名 token、不设 tokenVersion 字段
- **吊销 = 删除 token 记录**：改密/重置密码自动吊销该用户全部 token；提供显式吊销 API（含"登出所有设备"语义）
- **SDK 职责边界 = 凭证发行 + 凭证校验**：SDK 发行固定过期时间的 token、校验 token 有效性、提供吊销接口。多设备会话管理、产品级权限映射、token 续期策略均由产品层自行实现。
- **API 表面积收缩**：优先删除而非保留；仅新增与凭证吊销直接相关的 API
- **保留 better-auth 的安全原语**：`@better-auth/utils/password`（scrypt）与 `@better-auth/core/oauth2`（OAuth 2.0/OIDC 客户端）作为依赖保留，二者均为独立子包、零身份模型耦合。

### 1.3 目标

- 移除 `better-auth` 主包依赖与全部身份模型耦合（hack 清单归零）。
- 认证改为 API 凭证模式：`AuthToken` 表 + 按需吊销（无 Session 表、无浏览器会话语义、无滑动续期）。
- 渠道平权成为一等公民：登录/注册/验证码/密码重置全部以通道（provider+openid）为锚点，且与"验证码访问"统一为同一套原语。
- 公共业务 API 最小化收缩，见 §4。

---

## 2. 核心架构决策（ADR）

| # | 决策 | 理由 |
|---|---|---|
| D1 | token = 32 字节随机值（`crypto.randomBytes(32).toString("base64url")`），**数据库只存 SHA-256 哈希**（`tokenHash` 唯一索引） | 库泄露不暴露可用凭证；无需签名/验签逻辑；可枚举、可吊销 |
| D2 | cookie 名定为 `omni-auth.token`，httpOnly + sameSite=lax + secure(prod) + maxAge=expiresIn | 浏览器场景自动携带；无迁移用户，不必沿用旧名 |
| D3 | 吊销 = 删除 AuthToken 记录。改密/重置密码成功 → 删除该用户全部 token；显式吊销 API 按需删 | 用户确认："改密顺便吊销" + "登出所有设备"同一机制 |
| D4 | 删除 Session 表，新增 AuthToken 表 | 认证凭证从"浏览器会话"改为"API 凭证" |
| D5 | 验证码沿用现有 Verification 表，但生命周期完全自研（不删表、不改结构） | 简化 schema 变更；"复用表+自管逻辑"取代"复用表+绕过逻辑" |
| D6 | 密码哈希用 `@better-auth/utils/password` 的 `hashPassword/verifyPassword` | scrypt N=16384/r=16/p=1/dkLen=64（OWASP 级），纯函数可独立使用 |
| D7 | OAuth 用 `@better-auth/core/oauth2`（`createAuthorizationURL`/`validateAuthorizationCode`/`generateCodeChallenge`）+ 自研 state/PKCE cookie | 补齐当前缺失的 state（CSRF）与 PKCE；协议实现不自研 |
| D8 | 删除 `getBetterAuthHandler()`、`auth.betterAuth` 属性、`/api/auth/[...all]` 路由、`createRouteHandlers`、`createEdgeMiddleware`、`createDefaultMiddleware` | 无 better-auth 内核则无其 HTTP 路由面；hash-based token 无法在 Edge 本地验签，且不新建 get-session 路由，Edge middleware 无存在基础 |
| D9 | 删除 session 管理 API（listSessions 等），**新增** `revokeToken` / `revokeAllTokens` | 凭证吊销是刚需（用户确认）；"登出所有设备"= revokeAllTokens |
| D10 | 同一 userId 只保留一个有效 token：登录时 upsert（旧 token 作废）。**必须使用 DB 级原子 upsert**（PostgreSQL `INSERT ... ON CONFLICT ("userId") DO UPDATE SET ...`） | 表有界、防扩散；多设备需求由产品层在 SDK 凭证之上自建会话体系 |
| D11 | token **固定过期**，不自动续期。`getContext`/`requireContext` 为唯一校验入口，支持从 cookie 或 `Authorization: Bearer <token>` header 读取 token。产品层通过吊销接口自管会话过期策略 | SDK 职责收敛为"凭证发行 + 校验"；滑动续期仅为便利，非必需；无 get-session HTTP 路由（服务端直接调 `requireContext`，无 HTTP 往返） |
| D12 | 限流接入 `createMemoryRateLimiter`：登录 5 次/15min、注册 3 次/1h、验证码发送 3 次/10min、密码重置 3 次/10min | 防刷验证码与暴力破解 |
| D13 | CSRF：cookie sameSite=lax + 所有写操作（POST/DELETE）校验 `Origin`/`Referer` 与 `baseUrl` 同源 | 自研薄中间件，约 30 行 |
| D14 | 认证原语统一："验证码访问"模型——`requestCode`（发码）与 `exchangeCode`（校验一次性消费）作为唯一原语，注册/登录/重置密码/邮箱验证全部复用 | 用户确认：忘记密码与注册/登录本质同构，共用一套机制 |

---

## 3. 目标架构

```
┌────────────────────────────────────────────────────┐
│ 业务 API（收缩后，见 §4）                           │
├────────────────────────────────────────────────────┤
│ 自研内核                                            │
│  AuthToken 凭证（生成/哈希存储/校验/吊销）         │
│  验证码原语（requestCode / exchangeCode + TTL 清理）│
│  OAuth 编排（state/PKCE cookie）                   │
│  CSRF/origin 校验 / 内存限流                        │
│  合成邮箱通道映射（phone+xxx@phone.omni.internal）  │
├────────────────────────────────────────────────────┤
│ 安全原语（依赖保留）                                │
│  @better-auth/utils/password（scrypt）              │
│  @better-auth/core/oauth2（授权码+PKCE+JWKS）       │
└────────────────────────────────────────────────────┘
```

---

## 4. API 表面积（保留 / 删除 / 改造）

### 4.1 保留（签名调整）

`packages/omni-auth/src/auth.ts`（OmniAuth 类）：
- `signUp(input)` / `signIn(input)` / `signOut(ctx)` / `getContext(ctx)` / `requireContext(ctx)`
- `authenticateChannel(input)` / `bindChannel(ctx, input)` / `unbindChannel(ctx, channelId)`
- `signUpWithSocial(input)`
- `sendVerificationCode(ctx, channelId)` / `verifyChannelCode(provider, providerOpenid, code)`
- `requestPasswordReset(渠道)` / `resetPassword(渠道, code, newPassword)`（改为验证码模式，见 4.3）
- `requestEmailVerification(ctx)` / `verifyEmail(token)`
- `updateProfile(ctx, input)` / `deleteAccount(ctx, password)`
- `change.name(ctx, newName)` / `change.image(ctx, newImage)` / `change.channel(ctx, channelId, input)`
- `db` 属性（DBApi）
- RBAC 静态方法：`hasRole` / `hasAnyRole` / `requireRole` / `requireAnyRole`

**入参变更**：`SignInInput`、`SignUpInput`、`ChannelAuthInput`、`SignUpWithSocialInput` 均新增**可选** `metadata?: Record<string, unknown>`（token 附加自定义信息，§5.6）。无 productId。

**新增 API（吊销体系）**：
- `revokeToken(ctx, token: string)`：吊销指定 token（校验归属当前用户）
- `revokeAllTokens(ctx)`：吊销当前用户全部 token（= 登出所有设备）

**保留的导出与工厂函数**：`createQuickAuth`、`createRouteHelpers`、`createRequestContext`、`nextjsRequestContext`、`oauthCookieResponse`（改造）、`createMiddleware`（保留）、全部类型与错误类、`registerVerificationSender`/`registerOAuthProvider`/`registerTokenRefresher`/`setAuditHandler` 等注册函数、`PgAdapter`。

> **注**：`social/service.ts` 与 `social/token.ts` 不受迁移影响——社交 token 刷新（OAuth provider 的 access_token/refresh_token）与 AuthToken 是独立概念，`registerTokenRefresher` 照常保留。

### 4.2 删除（破坏性，直接删）

| 对象 | 位置 |
|---|---|
| `listSessions` / `revokeSession` / `revokeAllSessions` | `src/core/session.ts`（整文件删除）、`auth.ts` 对应方法 |
| `checkExpiredSessions()` | `auth.ts` |
| `getBetterAuthHandler()` | `auth.ts` |
| `auth.betterAuth` 属性 | `auth.ts`（含 `BetterAuthInstance` 类型引用） |
| `signSessionToken()` | `auth.ts` |
| `createRouteHandlers` | `src/nextjs/index.ts` |
| `createEdgeMiddleware` / `createDefaultMiddleware` / `EdgeMiddlewareConfig` | `src/nextjs/middleware.ts`（整段删除）、`src/nextjs/index.ts` 对应导出 |
| `/api/auth/[...all]/route.ts` | app 层（不再新建 get-session 路由替代） |
| `/api/me/sessions/route.ts`、`/api/me/sessions/[id]/route.ts`、`/api/me/sessions/revoke-all/route.ts` | app 层 |
| `Session` model | `prisma/schema.prisma`、`src/modules/db/schema.declarative.json`、`bin/db-push.mjs` 的 TABLES |
| hooks：`onSessionCreated` / `onSessionExpired` | `src/core/lifecycle.ts`（保留 `onUserCreated`） |
| audit action：`sessionRevoked` / `sessionRevokedAll` | `src/core/audit.ts`（新增 `tokenRevoked` / `tokensRevokedAll`） |
| `SessionInfo` 等 session 类型 | `src/core/session.ts` 随文件删除 |
| `betterAuthTypes.ts`（`BetterAuthSession`/`SignUpEmailResult`/`SignInEmailResult`） | `src/core/betterAuthTypes.ts`——M4 删除 better-auth 后这些类型不再需要；M2 起自研路径不再引用 |
| client 的 `_raw`、`createAuthClient` 重新导出、`Session` 类型重导出 | `src/client.ts`（重写，见 4.3） |

### 4.3 改造

| 对象 | 改造内容 |
|---|---|
| `src/core/oauth/handler.ts` 及 `oauth/providers/*` | 改用 `@better-auth/core/oauth2` 做授权 URL 生成与 code 交换；新增 state/PKCE 流程（§5.4）；**不再直接 `db.create` session**，改为创建 AuthToken（§5.1）；**新增 `publishAuditEvent({ action: "oauthLogin", ... })` 调用**（当前 handler.ts 全文无审计事件） |
| `src/core/verification-channel.ts` | 升级为统一验证码原语（D14）：`requestCode(provider, providerOpenid)`（send 前删除同 identifier 过期记录）与 `exchangeCode(provider, providerOpenid, code)`（一次性消费）；identifier 命名空间 `channel:{provider}:{providerOpenid}`；**验证码生成改用 `crypto.randomInt(100000, 1000000)`**（当前 `Math.random()` 非密码学安全） |
| `src/core/password.ts` | `requestPasswordReset(provider, providerOpenid)` = `requestCode`（发到绑定渠道）；`resetPassword(provider, providerOpenid, code, newPassword)` = `exchangeCode` + 更新密码 + **吊销该用户全部 token**（D3）；`changePassword` 校验旧密码（直接调 `verifyPassword`，不再通过假登录 `signInEmail` 验证）+ 更新 + **吊销该用户全部 token** |
| `src/core/verification.ts` | `requestVerification`/`verify` 自研（Verification 表 `verify-email:{email}`，TTL 1 小时）；不再调用 `auth.api.*` |
| `src/nextjs/middleware.ts` | 删除 `createEdgeMiddleware`/`createDefaultMiddleware` 整段及 `EdgeMiddlewareConfig` 类型；`createMiddleware` 改用新 `getContext`；cookie 名改为 `omni-auth.token` |
| `src/nextjs/index.ts` | 删除 `createRouteHandlers`；删除 `createEdgeMiddleware`/`createDefaultMiddleware`/`EdgeMiddlewareConfig` 导出；`oauthCookieResponse` 改为创建 AuthToken 并设置 `omni-auth.token` cookie |
| `src/client.ts` | 重写为纯 fetch 封装（无 better-auth/react 依赖）：`signIn/signUp/signOut/getContext/forgetPassword/resetPassword` 走 app 自有 API 路由；`useSession` 改为基于 `/api/me` 的简单 hook；删除 `createAuthClient` 导出与 `_raw` |
| `src/instrumentation.ts` | 保留定时任务：每 6 小时删除过期 AuthToken（`expiresAt < now`）与过期 Verification |
| `src/lib/auth.ts` | 移除 session 相关配置；`token` 配置仅保留 `expiresIn`（删除 `updateAge`） |
| `src/core/betterAuthTypes.ts` | M2 起自研路径不再引用此文件类型；M4 随 better-auth 删除一并删除 |

---

## 5. AuthToken 凭证设计（规范，按此实现）

### 5.1 token 生成与存储

```
明文 token = crypto.randomBytes(32).toString("base64url")   // 43 字符，256-bit 熵
tokenHash  = sha256(明文 token).toString("hex")              // 仅此值落库（唯一索引）
```

- 登录成功（signIn / authenticateChannel / signUp / OAuth 回调）→ 生成明文 token → 计算哈希 → upsert AuthToken → 返回明文 token 给调用方
- **upsert 语义（D10）**：`userId` 唯一约束，登录时覆盖（旧 token 立即作废），不产生历史记录
- **必须使用 DB 级原子 upsert**：PostgreSQL `INSERT ... ON CONFLICT ("userId") DO UPDATE SET tokenHash=..., expiresAt=..., metadata=..., createdAt=...`。禁止用"读→删→写"三步实现（并发登录会绕过唯一约束或抛 unique violation 暴露给用户）
- 明文 token 只在响应中短暂存在；日志/审计中禁止记录明文

### 5.2 Cookie 规范

- 名称：`omni-auth.token`
- 属性：`httpOnly; path=/; sameSite=lax; secure(生产环境)`；`maxAge = expiresIn`（默认 7 天，沿用 `config.token.expiresIn`）
- 登出：`signOut` 删除该 token 记录 + 清除 cookie
- 非浏览器场景：调用方使用 API 返回值中的明文 token，通过 `Authorization: Bearer <token>` header 携带

### 5.3 校验流程（`getContext`/`requireContext` 内联，无独立 getSession 方法）

1. 从 `Authorization: Bearer <token>` header 读明文 token；缺失则回退到 `omni-auth.token` cookie；两者皆无 → 返回未认证
2. `tokenHash = sha256(token)` → 查 AuthToken 表；无记录 → 返回未认证
3. 校验 `expiresAt > now`；失败 → 删除该记录并返回未认证
4. 查 user 表（`id = userId`）；不存在 → 返回未认证（删号即天然失效）
5. **不执行续期**（D11：固定过期，不滑动延长）
6. 返回 `AuthContext`（含 user 信息、roles、channels 等）

> 本流程为纯查询 + 过期清理，无写入操作（步骤 3 删除过期记录除外），适合高频调用。产品层如需缓存可自行在调用方加短 TTL 内存缓存。

### 5.4 OAuth state / PKCE

- 发起授权时：生成 `state`（32 字节随机）与 `code_verifier`（43 字符）；签名后写入 cookie `omni-auth.oauth_state`（httpOnly、sameSite=lax、maxAge 600s）
- 授权 URL 携带 `state` 与 `code_challenge = S256(code_verifier)`（用 `generateCodeChallenge`）
- 回调时：读 cookie → 验签 → 比对 query `state`（防 CSRF）→ 取 `code_verifier` 换 token（PKCE）→ 创建 AuthToken
- 校验完成后清除 `omni-auth.oauth_state` cookie

### 5.5 吊销矩阵

| 触发点 | 操作 |
|---|---|
| `changePassword` 成功 | 删除该用户全部 AuthToken |
| `resetPassword` 成功 | 删除该用户全部 AuthToken |
| `deleteAccount` | 级联删除（外键） |
| `revokeToken(ctx, token)` | 删除指定记录（仅限当前用户所有） |
| `revokeAllTokens(ctx)` | 删除当前用户全部记录（= 登出所有设备） |
| token 过期 | instrumentation 定时删除（§4.3） |

### 5.6 token 附加元数据（metadata）

- `AuthToken.metadata`（JSONB，默认 `{}`）：申请 token 时由调用方传入的**自定义信息**，验证 token 时随记录一并取回
- 写入：登录类方法入参 `metadata?: Record<string, unknown>`（可选），随 upsert 覆盖；OAuth 场景经 oauth_state cookie 签名传递、回调恢复
- 取回：`getContext` 返回的 `AuthContext` 增加 `tokenMetadata` 字段
- **安全边界（必须遵守）**：
  1. metadata 为**不可信数据**（客户端自由声明），仅用于展示/追踪/审计，**禁止基于它做授权决策**
  2. 序列化后 ≤ 2KB，超限拒绝申请
  3. 禁止存入密码、token 明文、密钥等敏感信息（明文落库）
  4. 不提供已签发 token 的 metadata 更新接口（如后续需要再新增）

---

## 6. 数据模型变更

三处 schema 定义必须**同步修改**（缺一不可）：
1. `prisma/schema.prisma`
2. `src/modules/db/schema.declarative.json`（`version` 3 → 4）
3. `packages/omni-auth/bin/db-push.mjs` 的 `TABLES` 数组

变更内容：
- **删除** `Session` model（三处）
- **新增** `AuthToken` model（三处）：

```prisma
model AuthToken {
  id         String   @id @default(cuid())
  tokenHash  String   @unique
  userId     String
  metadata   Json     @default("{}")   // 自定义信息（§5.6），不可信、≤2KB
  expiresAt  DateTime
  createdAt  DateTime @default(now())

  @@unique([userId])   // D10：单 token 语义（upsert 目标）
}
```

- User 不加 tokenVersion（吊销靠删记录，D3）
- Verification、Account、BusinessAccount、SocialAccount 结构不变

> ⚠️ `db-push.mjs` 与 `sync.ts` 均"不删除表"。实施时需手动执行 `DROP TABLE IF EXISTS "Session";`，并确认 `Session` 无外键依赖（仅 User 级联引用，User 保留不受影响）。

---

## 7. 里程碑（每步结束系统可用）

### M1：拆除 session 管理面（纯删除，零风险）

**步骤**：
1. 删除 `src/core/session.ts`；删除 `auth.ts` 中 `listSessions`/`revokeSession`/`revokeAllSessions`/`checkExpiredSessions` 及 `_sessionManagement` 字段
2. 删除 app 层 `/api/me/sessions/*` 三个路由文件
3. 删除 `src/core/lifecycle.ts` 的 `onSessionCreated`/`onSessionExpired`（含 payload 类型）及 `auth.ts` 中 databaseHooks 的 session 钩子组装
4. `src/core/audit.ts`：删除 `sessionRevoked`/`sessionRevokedAll`，新增 `tokenRevoked`/`tokensRevokedAll` action
5. 删除 `src/core/session.test.ts`；清理引用（`src/index.ts` 导出、`auth.ts` import）
6. **暂不删除** `getBetterAuthHandler`/`signSessionToken`/`/api/auth/[...all]`/`createRouteHandlers`/`createEdgeMiddleware`（依赖认证核心与 cookie 签名，M2 处理）

**验收**：
- `pnpm --filter omni-auth typecheck` 与 `pnpm typecheck` 通过
- `pnpm --filter omni-auth test` 通过（session.test.ts 删除后其余全绿）
- 登录/注册/登出/受保护页面功能不受影响（dev 冒烟）

### M2：AuthToken 凭证引擎（核心工程）

**步骤**：
1. 新建 `src/core/token.ts`：生成/哈希/创建（DB 级原子 upsert，D10）/校验/吊销纯函数（§5.1-5.3、5.5）；单元测试覆盖：生成唯一性、upsert 顶掉旧 token、过期拒绝、吊销、metadata 往返（写入→取回一致）、metadata 超限拒绝、upsert 覆盖 metadata、**并发 upsert 原子性**（模拟两个登录同时发起）
2. `auth.ts` 重写认证路径：
   - `_signUpEmail`/`_signInEmail`/`_createSessionForUser` → 自研：查 `user` + `account`（providerId="credential"）→ `verifyPassword` 校验 → 创建 AuthToken（§5.1，DB 级 upsert）
   - 注册：`hashPassword` → 创建 user + account + BusinessAccount（原 databaseHooks 的 `onUserCreated` hook 逻辑内联到 signUp）
   - `getContext(ctx)` 改为查 AuthToken（§5.3）；支持从 `Authorization: Bearer` header 或 cookie 读取 token；**不执行续期**
   - `signOut` 删除 token 记录 + 清除 `omni-auth.token` cookie
   - `authenticateChannel`/`bindChannel`/`unbindChannel`/`change.*` 方法内部改用新 `getContext`（签名不变，入参新增可选 `metadata`）
   - 新增 `revokeToken` / `revokeAllTokens`（§5.5）
3. **删除** `getBetterAuthHandler()` 方法和 `signSessionToken()` 方法，以及 auth.ts 中与 session 签名相关的辅助代码（从 M1 移入）。**`_betterAuth` 实例本身保留至 M4 删除**——M2-M3 期间 OAuth handler 和 password.ts 仍依赖它
4. `oauthCookieResponse` 改为创建 AuthToken 并设置 `omni-auth.token` cookie（删除 `signSessionToken` 调用）
5. 删除 `/api/auth/[...all]/route.ts`；从 `nextjs/index.ts` 移除 `createRouteHandlers` 导出；删除 `createEdgeMiddleware`/`createDefaultMiddleware`/`EdgeMiddlewareConfig`（从 `middleware.ts` 和 `index.ts` 导出中）
6. `createMiddleware` 改用新 `getContext`；cookie 名改为 `omni-auth.token`
7. 数据模型：三处 schema 删除 Session、新增 AuthToken；手动执行 `DROP TABLE IF EXISTS "Session";`
8. `src/instrumentation.ts`：改为清理过期 AuthToken + 过期 Verification
9. app 层检查：`test/page.tsx`、`protected/page.tsx`、`src/app/actions/profile.ts` 若调用被删 API 则改用 SDK 方法

**验收**：
- 新增 token 引擎测试全绿（含并发 upsert 原子性测试）；原测试中受影响用例已重写
- 冒烟：注册→登录→带 cookie 访问受保护页→同用户二次登录顶掉旧 token→改密→旧 cookie 失效→revokeAllTokens→重新登录→登出
- 冒烟（非浏览器）：登录拿明文 token→带 `Authorization: Bearer` header 调 requireContext→通过
- Session 表已不存在；middleware 验 token 通过（Node.js runtime）

### M3：验证码原语与 OAuth/密码迁移

**步骤**：
1. `verification-channel.ts` 升级为 `requestCode`/`exchangeCode` 原语（§4.3）：send 前清理同 identifier 过期记录；exchange 一次性消费；**验证码生成改用 `crypto.randomInt(100000, 1000000)`**
2. OAuth：`oauth/handler.ts` 与 `oauth/providers/*` 改用 `@better-auth/core/oauth2`（§5.4）；**新增 `publishAuditEvent({ action: "oauthLogin", userId, metadata: { provider, isNewUser } })`**
3. `core/password.ts`：`requestPasswordReset`/`resetPassword` 改为验证码模式（`requestCode`/`exchangeCode` + 更新密码 + 吊销全部 token）；`changePassword` 改用 `verifyPassword`（不再通过假登录验证旧密码）+ 吊销全部 token
4. `core/verification.ts`：`requestVerification`/`verify` 自研（`verify-email:{email}`，TTL 1 小时）
5. 限流接入（D12）：signIn/signUp/requestCode/requestPasswordReset
6. CSRF 中间件（D13）：新建 `src/core/origin.ts`，所有写操作路由调用
7. 新增依赖：`@better-auth/utils`、`@better-auth/core`（仅用 oauth2 子路径）

**验收**：
- 验证码：发送→过期记录在下次 send 时被清理；exchange 成功即删除；instrumentation 清理全部过期 Verification
- 验证码生成使用 `crypto.randomInt`（非 `Math.random`）
- OAuth：回调含 state 校验与 PKCE；伪造 state 被拒；**OAuth 登录/注册发布 `oauthLogin` 审计事件**
- 密码重置：验证码一次性、5 分钟过期；重置成功后全部旧 token 失效（吊销验证）
- 邮箱验证：token 一次性、1 小时过期
- 限流超限被拒；跨源 POST 被拒

### M4：移除 better-auth 内核

**步骤**：
1. `auth.ts`：删除 `_betterAuth` 实例化、`baseConfig` 组装、databaseHooks 合并、`overrides` 合并逻辑；`OmniAuthConfig` 移除 `overrides`/`plugins` 字段；`session` 配置改名为 `token`（仅 `expiresIn`，删除 `updateAge`/`rememberMeExpiresIn`）
2. 删除 `src/nextjs/adapter-bridge.ts` 与 `adapter-bridge.integration.test.ts`；`createQuickAuth` 移除 `betterAuthDatabase`/`overrides`/`autoCreateBusinessAccount` 配置项——**删除 `autoCreateHooks` 组装逻辑**（L264-308，BusinessAccount 创建已在 M2 内联到 `signUp`，此段为死代码）
3. `src/client.ts` 重写为纯 fetch（§4.3）
4. 删除 `src/core/betterAuthTypes.ts`（`BetterAuthSession`/`SignUpEmailResult`/`SignInEmailResult` 不再需要）
5. 依赖变更（§10）；删除 `nextjs/index.test.ts` 中 better-auth 初始化断言用例
6. 全仓 grep 确认无 `better-auth`（主包）引用（仅 `@better-auth/utils`、`@better-auth/core` 保留）

**验收**：
- hack 清单归零：无 adapter 桥接、无 join 翻译、无 Kysely 路径、无 cookie 格式复刻、无 databaseHooks 合并
- `pnpm --filter omni-auth build` + `test` 全绿；app `pnpm build` 通过
- `pnpm -r why better-auth`（主包）无结果

---

## 8. 测试策略

- 保留并适配：`rateLimit.test.ts`、`roles.test.ts`、`audit.test.ts`、`resolver.test.ts`、`social/*.test.ts`、`oauth/registry.test.ts`、`pg/adapter.test.ts`
- 删除：`core/session.test.ts`、`nextjs/adapter-bridge.integration.test.ts`（M4）、`nextjs/index.test.ts` 中 better-auth 初始化断言
- 新增：
  - `core/token.test.ts`：生成唯一性、哈希存储（库中无明文）、upsert 单 token、**并发 upsert 原子性**、过期拒绝、吊销矩阵、metadata 往返（写入→取回一致）、metadata 超限拒绝、upsert 覆盖 metadata
  - `core/origin.test.ts`：同源放行/跨源拒绝/缺失头拒绝
  - `core/verification-channel.test.ts`（扩展）：requestCode 前清理过期记录、exchange 一次性、验证码生成使用 `crypto.randomInt`
  - `oauth/handler.test.ts`（扩展）：state 缺失/伪造拒绝、PKCE 交换、**审计事件发布验证**
  - `core/password.test.ts`（扩展）：验证码模式重置、重置后全部 token 失效、changePassword 不再通过假登录验证旧密码
  - middleware 测试（Node.js 语义）：cookie + Authorization header 两种携带方式均通过

---

## 9. 安全清单（实施时逐项核对）

- [ ] 密码哈希：scrypt N=16384/r=16/p=1/dkLen=64（由 `@better-auth/utils/password` 保证，不得自行实现）
- [ ] token：256-bit 随机、库中仅存 SHA-256 哈希、日志禁止明文
- [ ] cookie：httpOnly + sameSite=lax + secure(prod)
- [ ] OAuth：state 防 CSRF + PKCE S256；回调校验 state 后清除 cookie
- [ ] 统一错误消息防枚举（登录失败不区分"用户不存在/密码错误"）
- [ ] 验证码：5 分钟 TTL、一次性、发送限流 3 次/10min；登录限流 5 次/15min
- [ ] 验证码生成使用 `crypto.randomInt`（非 `Math.random`）
- [ ] 写操作 CSRF：sameSite + Origin/Referer 校验
- [ ] 改密/重置后全部 token 吊销（§5.5）
- [ ] 删号后 AuthToken 级联删除（外键 onDelete: Cascade）
- [ ] 过期 token 定时清理（instrumentation）
- [ ] upsert 使用 DB 级 `ON CONFLICT` 原子操作（禁止读→删→写三步）
- [ ] metadata：不可信数据处理（不参与授权决策）、序列化 ≤ 2KB、敏感信息禁入
- [ ] getContext/requireContext 支持 cookie 与 Authorization header 两种 token 携带方式

---

## 10. 依赖变更

`packages/omni-auth/package.json`：
- **移除**：`better-auth`（dependencies 与 peerDependencies 均移除）
- **新增** dependencies：
  - `@better-auth/utils: ~0.4.2`（password 子路径；用 `~` 锁定 minor 版本，避免 patch 之外的变更）
  - `@better-auth/core: ~1.6.26`（oauth2 子路径；用 `~` 锁定，避免 minor 变更破坏子路径 API）
- peerDependencies 保留：`next >= 16`、`pg`（optional）

根 `package.json`：移除 `better-auth`（若 app 不再直接引用）；`@prisma/client`/`prisma` 保留（app 业务仍使用）

---

## 11. 风险与回退

| 风险 | 等级 | 缓解 |
|---|---|---|
| 单 token per user 下多设备互踢 | 已知（接受） | 用户确认；产品层在 SDK 凭证之上自建会话体系；多设备需求出现后可放开 D10 约束（改为允许多 token） |
| token 固定过期，无自动续期 | 已知（接受） | 用户确认；产品层通过吊销接口自管过期策略；如需无感续期可在过期前重新调 signIn 换新 token |
| 明文 token 在传输/日志中泄露 | 中 | 仅响应中返回一次；HTTPS 前提；日志禁用（§9） |
| `@better-auth/core` 升级破坏 oauth2 子路径 API | 低 | 仅用其导出稳定函数；`~` 锁定 minor 版本 |
| 删除 Edge middleware，产品需改用 Node.js middleware | 低 | 破坏性变更（v1.0 major）；迁移简单：改 import + 加 `export const runtime = "nodejs"` |
| app 层 demo 页面依赖被删路由 | 低 | M2 步骤 9 逐一检查 |
| db-push 不删表，Session 表残留 | 低 | M2 显式 `DROP TABLE IF EXISTS "Session"` |

回退策略：M1-M3 每一步都保持系统可用且可单独回退（git 提交粒度 = 里程碑）；M4 移除 better-auth 后无法回退（依赖已删），故 M4 必须在前三步验收全绿后进行。

---

## 12. 实施总则

1. 严格按 M1 → M2 → M3 → M4 顺序执行，禁止跳步
2. 每个里程碑单独提交并跑全部测试
3. 所有新增代码遵循现有风格（中文注释、模块头注释、`// ----` 分隔）
4. 遇到与本文档冲突的新事实时，记录到文档末尾"实施记录"再决定，不擅自改决策
