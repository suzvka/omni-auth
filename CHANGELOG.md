# Changelog

## v0.6.3 — Next.js 16 打包兼容性修复

### 缺陷修复

#### PgAdapter 动态 require 导致 Next.js 16 构建/运行失败

**问题根因**：PgAdapter 源码中通过 `require("pg")` 延迟加载 pg。esbuild（tsup）在 ESM 产物中把 `require` 调用改写为 `__require` shim（`var __require = (x) => typeof require !== "undefined" ? require : ...`）。Next.js 16 的打包器（webpack / Turbopack）无法静态分析 `__require("pg")` 这种动态 require，报 `dynamic usage of require is not supported`，导致所有调用 omni-auth 的 API 路由（注册、登录、用户管理等）返回 500。

**修复方案**：改用动态 ESM import：

```ts
// 修复前（esbuild 转为 __require shim，Next.js 打包器无法分析）
const { Pool: PgPool } = require("pg");

// 修复后（动态 import 是标准语法，打包器可正确 externalize pg）
const pg = await import("pg");
const pool = new pg.Pool(config);
```

效果：
- ESM / CJS 产物均保留标准 `import("pg")`，不再出现 `__require`
- Next.js 16 打包器（webpack 与 Turbopack）均能正确将 pg 作为外部 Node 模块处理
- **无需再配置 `serverExternalPackages`**（omni-auth / omni-auth-nextjs / pg 均不需要）

**影响范围**：`omni-auth` 的 `PgAdapter`（含 `createQuickAuth` 声明式配置路径）。

#### Edge Middleware 打包失败：Can't resolve 'omni-auth-nextjs'

**问题根因**：`omni-auth-nextjs` 的 `middleware.ts` 顶层从 `omni-auth` 主入口导入 `createRequestContext`，依赖链包含 pg（Node 专用模块），Edge Runtime 打包器无法解析。

**修复方案**：
- `omni-auth` 新增轻量子路径 **`omni-auth/request`**（零依赖，仅 RequestContext，Edge 安全）
- `omni-auth-nextjs` 新增子路径 **`omni-auth-nextjs/middleware`**（独立打包入口，不含 omni-auth 主入口依赖链）
- `middleware.ts` 改为从 `omni-auth/request` 导入

**迁移说明**：Edge Middleware 场景请改用子路径导入（主入口 re-export 仍保留，但仅限 Node.js Runtime）：

```ts
// middleware.ts — Edge Runtime
import { createEdgeMiddleware } from "omni-auth-nextjs/middleware";
```

### 新功能

- `omni-auth` 导出子路径 `omni-auth/request`（框架无关的 RequestContext，零依赖，Edge Runtime 安全）
- `omni-auth-nextjs` 导出子路径 `omni-auth-nextjs/middleware`（middleware 专用入口）

### 内部改进

- `PgAdapter` 增加 `_pgPromise` 缓存，重复调用只加载一次 pg 模块
- 新增测试：PgAdapter 延迟加载与连接池配置透传（动态 import 路径）

### 升级说明

1. 更新依赖：`pnpm add omni-auth@0.6.3 omni-auth-nextjs@0.6.3`
2. **移除** `next.config.ts` 中此前为规避问题添加的 `serverExternalPackages`（若存在）
3. Edge Middleware 用户将导入路径改为 `omni-auth-nextjs/middleware`
4. **无其他破坏性变更**；`omni-auth/request` 与 `omni-auth-nextjs/middleware` 为新增导出

---

## v0.6.2 — Better Auth 适配器兼容性修复

### 缺陷修复

#### `createQuickAuth` 初始化崩溃：Failed to initialize database adapter

**问题根因**：better-auth@1.6.26 的 full 模式（`import { betterAuth } from "better-auth"`）中，`getBaseAdapter` 对 `database` 选项的处理分为两条路径——函数形式被直接调用，**对象形式一律走 Kysely 适配器路径**（`createKyselyAdapter`）。omni-auth-nextjs 此前将 `toBetterAuthAdapter()` 的桥接结果（CustomAdapter 形状的**对象**）放入 `overrides.database`，被 Kysely 路径判为 `{ kysely: null }`，抛出 `Failed to initialize database adapter`，导致应用在启动/首次请求时崩溃。

**修复方案**：桥接结果改为以**函数形式**传入（`() => toBetterAuthAdapter(database)`），命中 `getBaseAdapter` 的函数分支被直接调用，跳过 Kysely 路径。

```ts
// 修复前（对象形式 → 必崩）
mergedOverrides.database = toBetterAuthAdapter(database);

// 修复后（函数形式 → 正常）
mergedOverrides.database = () => toBetterAuthAdapter(database);
```

影响范围：`omni-auth-nextjs` 的 `createQuickAuth`（含声明式配置 `database: { url }` 与自定义 `DatabaseAdapter` 两种用法）。

### 新功能

#### PgAdapter 支持 `ssl` 选项

`PgAdapter` 与声明式配置 `database: { url, ssl }` 新增 `ssl` 字段（透传给 `pg` 连接池），兼容两种形式：

```ts
// 形式一：布尔值
database: { url: process.env.DATABASE_URL, ssl: true }

// 形式二：自定义 TLS 配置（如关闭证书校验的云数据库）
database: { url: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
```

Neon、Supabase 等强制 TLS 的云数据库必须配置此选项。

### 内部改进

- 提取 `buildPoolConfig()` 纯函数（pg 连接池参数构造，便于单元测试）
- 新增测试：`omni-auth` PgAdapter 配置测试；`omni-auth-nextjs` `createQuickAuth` 回归测试（断言适配器以函数形式传入且初始化不抛错）
- `omni-auth-nextjs` 补齐 vitest 测试基础设施（`test` 脚本 + vitest devDependency）

### 升级说明

1. 更新依赖：`pnpm add omni-auth@0.6.2 omni-auth-nextjs@0.6.2`
2. **无破坏性变更**。已有代码无需改动；云数据库用户建议补上 `ssl` 配置。

---

## v0.6.0 — 项目更名为 OmniAuth

### 概述

本版本将项目从 `changfeng-user-center` 正式更名为独立的开源项目 **OmniAuth**，不再与公司名绑定。

### 包名变更

| 旧包名 | 新包名 |
| --- | --- |
| `changfeng-auth` | `omni-auth` |
| `changfeng-auth-nextjs` | `omni-auth-nextjs` |
| 根项目 `changfeng-user-center` | `omni-user-center` |

`omni-auth-nextjs` 对 `omni-auth` 的依赖使用 `workspace:*` 协议（新包名未发布前不可用 npm registry 版本号）。

### 公共 API 变更

| 旧名称 | 新名称 | 处理方式 |
| --- | --- | --- |
| `ChangfengAuth` | `OmniAuth` | 旧名以 `@deprecated` alias 保留过渡 |
| `ChangfengAuthConfig` | `OmniAuthConfig` | 旧名以 `@deprecated` alias 保留过渡 |
| `createChangfengClient` | `createOmniClient` | 直接改名，无 alias |
| `ChangfengClient` | `OmniClient` | 直接改名，无 alias |

### 数据层变更

| 项目 | 旧值 | 新值 |
| --- | --- | --- |
| 数据库名 | `changfeng_user_center` | `omni_user_center` |
| 合成邮箱占位域 | `@phone.changfeng.internal` | `@phone.omni.internal` |

### 其他变更

- CLI bin 名：`changfeng-auth-db` → `omni-auth`（`npx omni-auth db:push`）
- 日志前缀：`[changfeng-auth ...]` → `[omni-auth ...]`
- package.json author 改为 `Omni Auth Contributors`，仓库指向 `https://github.com/suzvka/omni-auth`
- better-auth 统一升级至 1.6.26（避免旧 lockfile 中 1.6.14 的 kysely 导入兼容问题）

### 迁移说明

1. 更新依赖：`pnpm add omni-auth omni-auth-nextjs`（或手动改 package.json 后 `pnpm install`）
2. 代码导入：`from "changfeng-auth"` → `from "omni-auth"`，`from "changfeng-auth-nextjs"` → `from "omni-auth-nextjs"`
3. 类名：`new ChangfengAuth(...)` → `new OmniAuth(...)`（过渡期内旧名仍可用，但会触发 deprecation 警告）
4. 数据库：bootstrap 会自动创建 `omni_user_center`；旧库 `changfeng_user_center` 需手动迁移数据
5. 合成邮箱域变化影响存量用户登录，需同步处理 `user.email` 占位值

---

## v0.5.0 — 渠道平权架构升级

### 核心理念变更

本版本确立了**渠道平权（Channel Parity）**设计原则：email / phone / wechat / QQ 等所有渠道在系统中地位平等，不存在任何特权渠道。

- `user.email` 被明确定义为 Better Auth 内部占位符——其值不携带业务含义，仅用于满足 Better Auth 的 unique 约束
- 非 email 渠道的 `user.email` 存储合成占位值（如 `phone_138xxx@phone.internal`），不应被读取或依赖
- 所有渠道操作通过 `SocialAccount` 表完成，email 不再获得额外的字段同步特权

---

### 新功能

#### `auth.db` — 数据库直通 CRUD

无需安装额外数据库依赖，直接通过 SDK 访问底层数据库：

```ts
// 查询
const user = await auth.db.findOne({ model: "user", where: [{ field: "id", value: userId }] });
const sessions = await auth.db.findMany({ model: "session", where: [{ field: "userId", value: userId }] });

// 创建
await auth.db.create({ model: "socialAccount", data: { ... } });

// 更新
await auth.db.updateOne({ model: "user", where: [{ field: "id", value: userId }], update: { name: "新名称" } });

// 删除
await auth.db.deleteOne({ model: "session", where: [{ field: "id", value: sessionId }] });
await auth.db.deleteMany({ model: "session", where: [{ field: "userId", value: userId }] });
```

可用方法：`findOne` / `findMany` / `create` / `updateOne` / `deleteOne` / `deleteMany`

#### `auth.change` — 用户属性变更命名空间

```ts
// 更新用户名（同步 user.name + businessAccount.displayName）
await auth.change.name(ctx, "新昵称");

// 更新头像
await auth.change.image(ctx, "https://cdn.example.com/avatar.png");

// 更换渠道标识符（email/phone/wechat 平等处理）
await auth.change.channel(ctx, channelId, { identifier: "new_email@example.com" });
```

`change.channel()` 特点：
- 校验渠道归属权（必须属于当前用户）
- 校验新标识符唯一性（同 provider 下不可冲突）
- 仅更新 `socialAccount.providerOpenid`，不触碰 `user.email`
- 写入审计日志（action: `channelUpdate`）

#### 渠道验证码系统

三个核心方法 + 一个注册接口，所有渠道平等接入：

```ts
// ① 注册发码器（初始化时调用一次）
auth.registerVerificationSender("email", {
  async send(channel, code) {
    await sendEmail(channel.providerOpenid, `验证码: ${code}`);
  },
});

auth.registerVerificationSender("phone", {
  async send(channel, code) {
    await sendSMS(channel.providerOpenid, `验证码: ${code}`);
  },
});

// ② 发送验证码（需要登录态 + 渠道归属 + allowVerification 标记）
await auth.sendVerificationCode(ctx, channelId);

// ③ 校验验证码（不要求登录态，适用于注册/绑定场景）
const isValid = await auth.verifyChannelCode("email", "user@example.com", "123456");
```

通道配置新增 `allowVerification` 标记：

```ts
// 注册/绑定时声明该渠道是否支持接收验证码
await auth.authenticateChannel({
  provider: "phone",
  providerOpenid: "13800138000",
  credential: { type: "smsCode", value: "123456" },
  channelData: {
    allowVerification: 1,  // 允许该渠道接收验证码
  },
});
```

---

### 缺陷修复

#### `nextjsRequestContext` 无法正确传递 headers → 所有 session 方法返回 500

**问题根因**：Next.js `headers()` 返回 `ReadonlyHeaders`（可迭代对象），旧代码通过 `Object.entries()` 尝试枚举，无法读取到 cookie header → `getSession` 永远返回 null → 所有 session 依赖方法（`bindChannel`、`unbindChannel`、`changePassword` 等）全部 500。

**修复方案**：使用 `ReadonlyHeaders.forEach()` 正确迭代：

```ts
// 修复前（错误）
const raw = hdrs as Record<string, string | string[] | undefined>;
for (const [k, v] of Object.entries(raw)) { ... }  // ReadonlyHeaders 不可枚举

// 修复后（正确）
(hdrs as unknown as { forEach: (fn: (v: string, k: string) => void) => void })
  .forEach((value, key) => { raw[key.toLowerCase()] = value; });
```

---

### 破坏性变更

无。`updateProfile` 仍接受 `{ name, image }`，但不再支持 email 参数——email 变更请使用 `auth.change.channel(ctx, channelId, { identifier })`。

---

### 数据库变更

`SocialAccount` 表新增三个字段：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `valid` | Int | 0 | 0=系统占位，1=用户真实登记 |
| `allowPasswordUpdate` | Int | 0 | 是否允许通过该渠道更新密码 |
| `allowVerification` | Int | 0 | 是否允许通过该渠道接收验证码 |

升级方式：
```bash
# Prisma 迁移
npx prisma migrate dev --name add_channel_fields

# 或通过声明式同步
# schema.declarative.json 已更新至 v3，AUTO_SYNC_DB=true 时自动添加缺失列
```

---

### API 一览

```ts
// ===== 渠道平权认证 =====
auth.authenticateChannel(input)         // 统一通道认证（自动判断注册/登录）
auth.bindChannel(ctx, input)            // 为已登录用户绑定新渠道
auth.unbindChannel(ctx, channelId)      // 解绑渠道

// ===== 用户属性变更 =====
auth.change.name(ctx, newName)          // 更新用户名
auth.change.image(ctx, newImage)        // 更新头像
auth.change.channel(ctx, channelId, { identifier })  // 更换渠道标识符

// ===== 渠道验证码 =====
auth.registerVerificationSender(provider, sender)  // 注册发码器
auth.sendVerificationCode(ctx, channelId)           // 发送验证码
auth.verifyChannelCode(provider, providerOpenid, code)  // 校验验证码

// ===== 数据库直通 =====
auth.db.findOne / findMany / create / updateOne / deleteOne / deleteMany

// ===== 社交账户 =====
auth.social.findByUser / findByProvider / bindToUser / unbindFromUser

// ===== 密码管理 =====
auth.changePassword / requestPasswordReset / resetPassword

// ===== Session =====
auth.listSessions / revokeSession / revokeAllSessions
auth.signSessionToken(rawToken)  // HMAC 签名 session token
```
