# omni-auth v1.0 迁移指南与接口文档

> 适用版本：omni-auth v1.0.0（major 破坏性更新）
> 目标读者：从 v0.7.x 及更早版本升级的外部用户
> 日期：2026-08-12

---

## 1. v1.0 是什么

v1.0 完成了 OmniAuth 与 better-auth 内核的彻底解耦：

- **认证模式从「浏览器会话」改为「API 凭证」**：服务端维护 `AuthToken` 表（数据库只存 SHA-256 哈希），token 通过 httpOnly cookie 承载（浏览器），登录 API 同时返回明文 token（非浏览器场景）
- **渠道平权为一等公民**：登录/注册/验证码/密码重置全部以通道（`provider` + `providerOpenid`）为锚点
- **SDK 职责收敛**：凭证发行 + 凭证校验 + 凭证吊销。多设备会话、产品级权限映射、token 续期策略由产品层自行实现

**无兼容迁移**：无迁移用户假设下，v1.0 直接删除 API、更换 cookie 格式、变更数据库表结构。

---

## 2. 破坏性变更速览

| 类别 | 变更 |
|---|---|
| 删除依赖 | `better-auth` 主包（dependencies 与 peerDependencies） |
| 保留依赖 | `@better-auth/utils`（scrypt 密码哈希）、`@better-auth/core`（OAuth 2.0/OIDC 客户端），均已 `~` 锁定 |
| 数据表 | 删除 `Session` 表；新增 `AuthToken` 表 |
| Cookie | 旧 cookie 失效，新 cookie 名为 `omni-auth.token` |
| 删除 API | `getBetterAuthHandler` / `auth.betterAuth` / `signSessionToken` / `listSessions` / `revokeSession` / `revokeAllSessions` / `checkExpiredSessions` / `createRouteHandlers` / `createEdgeMiddleware` / `createDefaultMiddleware` / `createAuthClient` |
| 删除路由 | `/api/auth/[...all]`（better-auth 通配路由）、get-session 类路由 |
| Middleware | Edge middleware 全部删除，仅保留 Node.js runtime 的 `createMiddleware` |
| 配置变更 | `session` 配置改为 `token`（仅 `expiresIn`，无 `updateAge`）；`overrides`/`plugins` 配置项删除 |

### 删除 API → 替代方案对照

| 已删除 | 替代方案 |
|---|---|
| `getBetterAuthHandler()` | 无。不再需要第三方 HTTP 路由面，自建路由直调 SDK 方法（见 §8 参考实现） |
| `auth.betterAuth` 属性 | 无 |
| `signSessionToken()` | 登录类方法直接返回明文 token（`result.token`） |
| `listSessions` / `revokeSession` / `revokeAllSessions` | `revokeToken(ctx, token)` / `revokeAllTokens(ctx)` |
| `checkExpiredSessions()` | 无需手动调用；参考实现见 §9.3 定时清理 |
| `createRouteHandlers` | 自建 Next.js Route Handler（见 §8） |
| `createEdgeMiddleware` / `createDefaultMiddleware` | `createMiddleware`（Node.js runtime，见 §7.4） |
| `/api/auth/[...all]` 路由 | 自建独立路由（见 §8） |
| get-session 查询 | `getContext(ctx)` / `requireContext(ctx)`（服务端直接调用，无 HTTP 往返） |
| `createAuthClient` / better-auth client | `createOmniClient`（`omni-auth/client`，见 §7.5） |
| session 滑动续期 | 无。token 固定过期；如需续期，产品层在过期前重新调 `signIn` 换新 token |

---

## 3. 安装与依赖

```bash
pnpm add omni-auth@1.0.0
pnpm remove better-auth   # 若 app 曾直接依赖
```

环境变量（名称沿用，语义不变）：

```bash
DATABASE_URL=postgres://user:pass@host:5432/db
BETTER_AUTH_SECRET=<随机密钥>      # OAuth state 签名等用途
BETTER_AUTH_URL=https://your.app    # 用于 CSRF 同源校验与验证链接生成
```

peerDependencies：`next >= 16`（可选，仅用 `/nextjs`、`/middleware` 子路径时需要）、`pg`（可选）。

---

## 4. 数据库迁移（必做）

三处 schema 定义已在 SDK 侧同步（prisma schema / 声明式 JSON v4 / db-push CLI）。使用方需要：

### 4.1 推送新表结构

```bash
DATABASE_URL=postgres://... npx omni-auth db:push
```

幂等操作：`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`，会创建 `AuthToken` 表并补齐约束。**db-push 不删除任何表。**

### 4.2 手动删除 Session 表

```sql
DROP TABLE IF EXISTS "Session";
```

`Session` 表仅被 User 级联引用，删除不影响其余表。

### 4.3 AuthToken 表结构

```prisma
model AuthToken {
  id         String   @id @default(cuid())
  tokenHash  String   @unique       // SHA-256(明文 token)，明文不落库
  userId     String
  metadata   Json     @default("{}") // 登录时传入的自定义信息（≤2KB，不可信）
  expiresAt  DateTime
  createdAt  DateTime @default(now())

  @@unique([userId])   // 单 token per user：登录时 upsert 覆盖旧 token
}
```

其余表（User、Verification、Account、BusinessAccount、SocialAccount）结构不变。

---

## 5. 凭证模型（必读）

### 5.1 token 生命周期

```
登录成功 → 生成 32 字节随机 token（base64url，43 字符）
        → 数据库仅存 SHA-256 哈希（DB 级原子 upsert，同用户旧 token 立即作废）
        → 明文 token 只在响应中返回一次
```

- **单 token per user**：同一用户再次登录会顶掉旧 token（多设备互踢为已知行为；多设备需求请在 SDK 凭证之上自建会话体系）
- **固定过期**：默认 7 天（`config.token.expiresIn`，单位秒），**不自动续期**
- **吊销 = 删除记录**：改密 / 重置密码成功自动吊销该用户全部 token

### 5.2 token 携带方式（二选一）

| 场景 | 方式 |
|---|---|
| 浏览器 | `omni-auth.token` httpOnly cookie（登录响应自动设置） |
| 非浏览器（App/服务端/脚本） | `Authorization: Bearer <明文 token>` header |

`getContext` / `requireContext` 优先读 Bearer header，缺失时回退 cookie。

### 5.3 Cookie 规范

- 名称：`omni-auth.token`
- 属性：`httpOnly; path=/; sameSite=lax; secure(生产)`；`maxAge = expiresIn`

### 5.4 token metadata

登录类方法（`signIn` / `signUp` / `authenticateChannel` / `signUpWithSocial`）入参均支持可选 `metadata?: Record<string, unknown>`：

- 随 token 落库，`getContext` 返回的 `AuthContext.tokenMetadata` 中取回
- **序列化后 ≤ 2KB**，超限拒绝
- **不可信数据**：仅用于展示/追踪/审计，禁止基于它做授权决策；禁止存入密码、密钥等敏感信息

### 5.5 吊销矩阵

| 触发点 | 行为 |
|---|---|
| `changePassword` 成功 | 自动删除该用户全部 token |
| `resetPassword` 成功 | 自动删除该用户全部 token |
| `deleteAccount` | 级联删除 |
| `revokeToken(ctx, token)` | 删除指定 token（仅限当前用户所有） |
| `revokeAllTokens(ctx)` | 删除当前用户全部 token（= 登出所有设备） |
| 再次登录 | 旧 token 被 upsert 顶掉 |
| token 过期 | 校验时惰性删除 + 定时清理（§9.3） |

---

## 6. 初始化

### 6.1 createQuickAuth（Next.js 推荐）

```ts
// src/lib/auth.ts
import { createQuickAuth, createRouteHelpers } from "omni-auth/nextjs";

export const auth = createQuickAuth({
  // 声明式数据库配置（SDK 内置 pg 驱动，零 ORM 依赖）
  database: {
    url: process.env.DATABASE_URL!,
    // ssl: { ... },          // Neon/Supabase 等云数据库按需开启
    // pool: { max: 10 },     // 可选
  },
  secret: process.env.BETTER_AUTH_SECRET!,
  baseUrl: process.env.BETTER_AUTH_URL!,
  token: { expiresIn: 60 * 60 * 24 * 7 },   // 秒，默认 7 天
  accountResolver: { findByAuthUserId },     // 可选：业务账户解析
  roleResolver: { getRolesForUser },         // 可选：角色解析（填充 roles）
  hooks: { onUserCreated },                  // 可选：生命周期钩子（仅此一个）
});

export const routeHelpers = createRouteHelpers(auth);
```

也可传入任意 `DatabaseAdapter` 实现代替声明式配置。`createAuth(config)` 为框架无关的底层工厂，参数相同（`database` 必须是适配器实例）。

### 6.2 配置项对照（vs v0.7）

| v0.7 配置 | v1.0 |
|---|---|
| `session: { expiresIn, updateAge }` | `token: { expiresIn }`（`updateAge` 删除，无续期） |
| `overrides` / `plugins` | 删除（无 better-auth 内核） |
| `betterAuthDatabase` / `autoCreateBusinessAccount` | 删除（BusinessAccount 创建已内联到 signUp） |

---

## 7. SDK API 参考

### 7.1 OmniAuth 实例方法

**认证**

| 方法 | 签名 | 说明 |
|---|---|---|
| `signUp` | `(input: SignUpInput) => Promise<SignUpResult>` | 邮箱注册，返回 `{ userId, token, user }` |
| `signIn` | `(input: SignInInput) => Promise<SignInResult>` | 邮箱登录，返回 `{ userId, token, user }` |
| `signOut` | `(ctx: RequestContext) => Promise<void>` | 删除当前 token 记录（cookie 由响应层清除） |
| `authenticateChannel` | `(input: ChannelAuthInput) => Promise<ChannelAuthResult>` | 统一通道登录/注册（邮箱/手机/OAuth 平权），返回 `{ userId, token, isNewUser, user, channel }` |
| `signUpWithSocial` | `(input: SignUpWithSocialInput) => Promise<SignUpResult>` | 注册并绑定社交账户（原子） |

**上下文与吊销**

| 方法 | 签名 | 说明 |
|---|---|---|
| `getContext` | `(ctx: RequestContext) => Promise<AuthContext>` | 校验 token 并返回上下文；未登录返回 `authUserId: null`（不抛错） |
| `requireContext` | `(ctx: RequestContext) => Promise<AuthContext>` | 同上，未登录抛 `UnauthorizedError` |
| `revokeToken` | `(ctx, token: string) => Promise<boolean>` | 吊销指定 token（校验归属当前用户） |
| `revokeAllTokens` | `(ctx) => Promise<number>` | 吊销当前用户全部 token，返回删除数量 |

**渠道管理**

| 方法 | 签名 | 说明 |
|---|---|---|
| `bindChannel` | `(ctx, input) => Promise<SocialAccountDTO>` | 为已登录用户绑定新渠道 |
| `unbindChannel` | `(ctx, channelId) => Promise<void>` | 解绑渠道（校验归属） |
| `change.channel` | `(ctx, channelId, { identifier }) => Promise<...>` | 更换渠道标识符（含唯一性校验） |
| `change.name` | `(ctx, newName) => Promise<PublicUser>` | 改名（同步 BusinessAccount.displayName） |
| `change.image` | `(ctx, newImage) => Promise<PublicUser>` | 改头像 |

**验证码（委托模式：库生成种子码 + 渠道权威验证）**

| 方法 | 签名 | 说明 |
|---|---|---|
| `requestChannelCode` | `(provider, providerOpenid, channelRef?) => Promise<string>` | 生成 6 位种子码（`crypto.randomInt`）；已注册 sender 则投递，否则仅返回码由调用方自行投递/派生 URL |
| `verifyChannelCode` | `(provider, providerOpenid, code, channelRef?) => Promise<boolean>` | 委托渠道注册的 verifier 验证，库无条件透传结果（未注册 verifier 抛错） |
| `registerVerificationSender` | `(provider, sender) => void` | 注册投递器（可选） |
| `registerVerificationVerifier` | `(provider, verifier) => void` | 注册验证器（必须，否则 verify 抛错） |

**密码**

| 方法 | 签名 | 说明 |
|---|---|---|
| `requestPasswordReset` | `(provider, providerOpenid) => Promise<void>` | 向绑定渠道发送重置验证码（限流 3 次/10min） |
| `resetPassword` | `(provider, providerOpenid, code, newPassword) => Promise<void>` | 验证码重置密码，成功后**吊销全部 token** |
| `changePassword` | `(ctx, oldPassword, newPassword) => Promise<void>` | 改密（直接校验旧密码），成功后**吊销全部 token** |

**邮箱验证 / 账号**

> 邮箱链接验证已移出 SDK（全渠道平权）：上层用 `requestChannelCode` 的种子码自行派生 URL key、发送链接并验证，成功后直接 `auth.db.updateOne` 置 `emailVerified`，或走 `verifyChannelCode` 委托契约。

| 方法 | 签名 | 说明 |
|---|---|---|
| `updateProfile` | `(ctx, { name?, image? }) => Promise<void>` | 更新个人资料 |
| `deleteAccount` | `(ctx, password) => Promise<void>` | 注销账号（需密码验证，级联删除） |

**OAuth**

| 方法 | 签名 | 说明 |
|---|---|---|
| `registerOAuthProvider` | `(config: OAuthProviderConfig) => void` | 注册 OAuth provider |
| `handleOAuthCallback` | `(provider, code, redirectUri, state?, codeVerifier?) => Promise<OAuthCallbackResult>` | 处理回调（state 校验 + PKCE S256 交换），返回含明文 token 的结果 |

**RBAC 静态方法**：`OmniAuth.hasRole` / `hasAnyRole` / `requireRole` / `requireAnyRole`

**其他属性**：`auth.db`（DatabaseAdapter CRUD 直通）、`auth.social`（社交账户服务）、`registerVerificationSender(provider, sender)`、`registerTokenRefresher(provider, refresher)`（社交 provider token 刷新，与 AuthToken 无关，照常使用）

### 7.2 RequestContext

```ts
import { createRequestContext } from "omni-auth";
import { nextjsRequestContext } from "omni-auth/nextjs";

// Next.js Route Handler 中：
const ctx = nextjsRequestContext(await headers());

// 任意环境：
const ctx = createRequestContext({ cookie: "...", authorization: "Bearer ..." });
```

### 7.3 AuthContext 结构

```ts
interface AuthContext {
  account: Account | null;        // accountResolver 解析的业务账户
  authUserId: string | null;      // null = 未登录
  socialAccounts: SocialAccountBrief[];
  channels: UserChannel[];        // email/phone/wechat 等全部通道
  roles: string[];                // roleResolver 填充
  tokenMetadata?: Record<string, unknown>;  // 登录时传入的 metadata
}
```

### 7.4 Next.js middleware（仅 Node.js runtime）

```ts
// middleware.ts
export const runtime = "nodejs";   // 必须声明

import { createMiddleware } from "omni-auth/nextjs";
import { auth } from "@/lib/auth";

export const middleware = createMiddleware(auth, {
  protectedPaths: ["/dashboard"],
  publicPaths: ["/sign-in", "/api/auth"],
  signInPath: "/sign-in",
  requiredRoles: ["admin"],        // 可选
  onUnauthorized: (req, reason) => {},  // 可选自定义
  onError: (req, error) => {},          // 可选自定义
});

export const config = { matcher: ["/((?!_next|favicon.ico).*)"] };
```

校验通过后注入 `x-auth-user-id` / `x-auth-display-name` / `x-auth-roles` headers 供下游使用。**Edge middleware 已删除**，原用户需加 `export const runtime = "nodejs"` 并改用 `createMiddleware`。

### 7.5 客户端（omni-auth/client）

纯 fetch 封装，无 better-auth/react 依赖：

```ts
import { createOmniClient } from "omni-auth/client";

const client = createOmniClient();   // 可选 baseURL 参数

client.useSession();                 // React hook，基于 GET /api/me
await client.signIn({ email, password });
await client.signUp({ email, password, name });
await client.signOut();
await client.getContext();           // 完整 AuthContext
await client.forgetPassword(provider, providerOpenid);
await client.resetPassword(provider, providerOpenid, code, newPassword);
```

客户端调用的路由需自行实现（见 §8 参考实现）。

---

## 8. 自建路由参考实现

v1.0 删除了 `createRouteHandlers` 与 `/api/auth/[...all]`，路由由使用方自建。以下是生产在用的参考实现要点：

### 8.1 路由清单

| 路由 | 方法 | 请求体 | 响应 |
|---|---|---|---|
| `/api/auth/sign-up` | POST | `{ email, password, name, metadata? }` | `{ success, user }` + token cookie |
| `/api/auth/sign-in` | POST | `{ email, password, metadata? }` | `{ success, user }` + token cookie |
| `/api/auth/sign-out` | POST | — | `{ success }` + 清除 cookie |
| `/api/auth/forget-password` | POST | `{ provider, providerOpenid }` | `{ success }` |
| `/api/auth/reset-password` | POST | `{ provider, providerOpenid, code, newPassword }` | `{ success }` |
| `/api/auth/social-signup` | POST | `{ email, password, name, social: {...} }` | `{ success, userId, isNewUser }` + cookie |
| `/api/auth/social/callback/[provider]` | POST | `{ code, redirectUri }` | `{ success, userId, isNewUser, channel }` + token cookie |
| `/api/auth/social/list` | GET | — | 社交账户列表 |
| `/api/auth/social/bind` | POST | `{ provider, providerOpenid, ... }` | `{ success, channel }` |
| `/api/auth/social/unbind` | DELETE | `{ id }` | `{ success }` |
| `/api/me` | GET | — | 完整 AuthContext |
| `/api/me/profile` | PUT | `{ name?, image? }` | `{ success }` |
| `/api/me/password` | PUT | `{ oldPassword, newPassword }` | `{ success }` |
| `/api/me/account` | DELETE | `{ password }` | `{ success }` + 清除 cookie |

### 8.2 登录路由模板（设置 cookie）

```ts
// POST /api/auth/sign-in
const result = await auth.signIn({ email, password, metadata });

const response = NextResponse.json({ success: true, user: result.user });
response.cookies.set("omni-auth.token", result.token!, {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 7,   // 与 token.expiresIn 一致
  path: "/",
});
return response;
```

登出/注销路由清除 cookie：同名 cookie 设 `maxAge: 0`。OAuth 回调可直接使用 `oauthCookieResponse(auth, result)` 一步完成。

### 8.3 CSRF 同源校验（所有写路由必做）

v1.0 内置 `isSameOrigin` 原语（Origin 优先，Referer 回退，缺失拒绝）。**所有 POST/PUT/DELETE 路由必须在开头校验**，跨源返回 403：

```ts
// src/lib/csrf.ts
import { isSameOrigin, type RequestContext } from "omni-auth";
import { nextjsRequestContext } from "omni-auth/nextjs";
import { headers } from "next/headers";

export const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

export function checkSameOrigin(ctx: RequestContext): boolean {
  return isSameOrigin(ctx, baseUrl);
}
export async function checkSameOriginFromHeaders(): Promise<boolean> {
  return isSameOrigin(nextjsRequestContext(await headers()), baseUrl);
}

// 写路由开头：
if (!(await checkSameOriginFromHeaders())) {
  return NextResponse.json({ error: "拒绝跨源写请求" }, { status: 403 });
}
```

> ⚠️ **非浏览器客户端注意**：写接口要求 Origin/Referer 与 baseUrl 同源，缺失即拒绝。服务端脚本调用写接口时需显式携带 `Origin: <baseUrl>` header。

### 8.4 错误状态码约定

| 状态码 | 场景 |
|---|---|
| 400 | 缺少必填字段 / 验证码错误 / 限流触发 |
| 401 | 未登录（`UnauthorizedError`）/ 密码错误（`InvalidPasswordError`） |
| 403 | 跨源写请求 / 角色不足 |
| 409 | 社交账户冲突（`SocialAccountConflictError`）/ 渠道已被绑定 |
| 500 | 服务器内部错误 |

错误类从 `omni-auth` 或 `omni-auth/nextjs` 导入：`UnauthorizedError`（含 `code` 字段）、`InvalidPasswordError`、`SocialAccountConflictError`。

---

## 9. 运行时要求

### 9.1 限流（SDK 内置，自动生效）

| 操作 | 限制 | 限流键 |
|---|---|---|
| signIn | 5 次 / 15 分钟 | email |
| signUp | 3 次 / 1 小时 | email |
| sendVerificationCode / requestPasswordReset | 3 次 / 10 分钟 | provider:providerOpenid |

内存实现（单进程）。多实例部署请自行替换为 Redis 等外部限流（`createMemoryRateLimiter` 接口可替换）。

### 9.2 审计事件（可选接入）

```ts
import { setAuditHandler } from "omni-auth";

setAuditHandler((event) => { /* event: { action, userId?, metadata?, ... } */ });
```

action 枚举：`signUp` / `signIn` / `signInFailed` / `oauthLogin` / `channelBind` / `channelUnbind` / `channelUpdate` / `changeName` / `changePassword` / `resetPasswordRequest` / `resetPasswordDone` / `deleteAccount` / `verificationSent`。

### 9.3 定时清理（使用方自建）

SDK 不再内置 session 清理任务。参考实现（Next.js `instrumentation.ts`，每 6 小时清理过期 AuthToken 与 Verification）：

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const cleanup = async () => {
    const now = new Date().toISOString();
    await auth.db.deleteMany({ model: "authToken",     where: [{ field: "expiresAt", value: now, operator: "lt" }] });
    await auth.db.deleteMany({ model: "verification",  where: [{ field: "expiresAt", value: now, operator: "lt" }] });
  };
  setInterval(cleanup, 6 * 60 * 60 * 1000).unref();
  void cleanup();
}
```

### 9.4 渠道验证码注册（委托模式）

```ts
// 投递器（可选）：未注册则 requestChannelCode 仅返回种子码
auth.registerVerificationSender("email", {
  async send(channel, code) { /* 调用你的邮件服务 */ },
});
auth.registerVerificationSender("phone", { /* 短信服务 */ });

// 验证器（必须）：渠道权威验证，库无条件透传结果
auth.registerVerificationVerifier("email", {
  async verify(channel, code) {
    // 你自行管理验证码的存储 / TTL / 一次性消费 / 防重放
    return myEmailService.checkCode(channel.providerOpenid, code);
  },
});
```

种子码为 6 位数字（`crypto.randomInt` 密码学安全生成）；验证码的 TTL、一次性消费、防重放全部由渠道实现方负责，库不做任何状态存储。

---

## 10. OAuth 集成变化

- 协议实现改用 `@better-auth/core/oauth2`（`createAuthorizationURL` / `validateAuthorizationCode`）
- **新增 state（防 CSRF）+ PKCE S256**：发起授权时 SDK 生成 `state` 与 `code_verifier`，由调用方写入签名 cookie（如 `omni-auth.oauth_state`，maxAge 600s）；回调时传入 `state` / `codeVerifier` 完成校验与交换，校验后清除 cookie
- 回调成功后创建 AuthToken（不再直插 session 表），并发布 `oauthLogin` 审计事件
- 内置 provider：`createGoogleProvider` / `createGitHubProvider` / `createWechatProvider`（导入自 `omni-auth`）

---

## 11. 迁移检查清单

- [ ] 升级依赖：`omni-auth@1.0.0`，移除 `better-auth`
- [ ] 执行 `npx omni-auth db:push` 创建 AuthToken 表
- [ ] 执行 `DROP TABLE IF EXISTS "Session";`
- [ ] 配置 `session: {...}` 改为 `token: { expiresIn }`；删除 `overrides`/`plugins`
- [ ] 删除对 `getBetterAuthHandler` / `createRouteHandlers` / `/api/auth/[...all]` 的引用，按 §8 自建路由
- [ ] 所有写路由接入 CSRF 同源校验（§8.3）
- [ ] session 管理调用改为 `revokeToken` / `revokeAllTokens`
- [ ] Edge middleware 改为 `createMiddleware` + `export const runtime = "nodejs"`
- [ ] 客户端改为 `createOmniClient`（`omni-auth/client`），`useSession` 基于 `/api/me`
- [ ] 自建过期 token/验证码定时清理（§9.3）
- [ ] 非浏览器客户端为写接口携带 `Origin` header，或改用 Bearer token 直调 SDK
- [ ] 全量回归：注册 → 登录 → 受保护页 → 二次登录顶掉旧 token → 改密后旧凭证失效 → 登出

---

## 12. 常见问题

**Q：升级后所有用户都被登出了？**
预期行为。Session 表已删除且无迁移，所有用户需重新登录换取 AuthToken。

**Q：能否多设备同时在线？**
v1.0 单 token per user，新登录会顶掉旧 token（已知决策）。多设备需求请在 SDK 凭证之上自建会话层（每次会话校验时调用 `requireContext`），或等待后续版本放开多 token 约束。

**Q：token 到期前如何实现无感续期？**
SDK 不做滑动续期。产品层可在过期前引导客户端重新调 `signIn`（或自定续期接口）换取新 token。

**Q：metadata 能用来做权限判断吗？**
不能。metadata 为客户端自由声明的不可信数据，仅用于展示/追踪/审计，授权决策请使用 `roles`（roleResolver）。

**Q：密码哈希算法变了吗？**
不变，仍为 scrypt（N=16384/r=16/p=1/dkLen=64），由 `@better-auth/utils/password` 提供。
