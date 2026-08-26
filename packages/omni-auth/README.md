# omni-auth

OmniAuth — 全渠道认证 SDK，框架无关，一等 Next.js 集成。

## 职责边界（认证域黑盒）

**本 SDK 持有整个认证域**：凭证校验、用户/渠道记录持久化、会话管理、
OAuth 2.0 server、SCIM 管理面。认证域表（`user`/`socialAccount`/`session`/
`oauthToken`/`oauthClient`）全部为包内私有：**宿主零 SQL、零表名、
零事务编排**——除运维在数据库 GUI 中可见外，宿主无需感知这些表的存在。

## 快速开始

```ts
import { createQuickAuth } from "omni-auth/nextjs";
import type { Pool } from "pg";

// 连接池由宿主注入（包不自行建池/关池）；autoSync 自动执行幂等建表/迁移
export const auth = createQuickAuth({
  database: { pool },
  baseUrl: process.env.BETTER_AUTH_URL!,
  autoSync: true,
});

// 注册 / 登录（凭证校验）
await auth.signUp({ email, password, name });
await auth.signIn({ email, password });

// 认证域语义 API
await auth.sessions.createSession(userId);        // 会话
await auth.oauthServer.createOAuthClient({...});  // OAuth 客户端
await auth.users.updateUser(userId, { active: false }); // 用户管理
await auth.scim.listUsers({...});                 // SCIM
```

建表（等价于 `autoSync`，可单独执行）：

```sh
npx omni-auth db:push
```

## 自动建表 / 迁移（包内单一实现）

表结构由包内 `schema.ts` 单一管理，`schema-sync.ts` 负责同步：

- `createQuickAuth({ autoSync: true })` 初始化时自动执行（幂等，可重复运行）
- `npx omni-auth db:push` CLI 复用同一实现
- 安全策略：**不删表、不删列、不修改已有列类型**；仅
  CREATE TABLE IF NOT EXISTS / 缺失列 ADD COLUMN / 旧版小写折叠列名 RENAME 保真
- 同步结果：`{ synced, missingTables, addedColumns }`

## 速率限制与生产建议

默认限流器为**进程内存实现**，仅适用于单进程/开发环境。
多实例 / serverless 部署请注入共享存储实现（如 Redis）：

```ts
import { createQuickAuth } from "omni-auth/nextjs";
import type { RateLimiter } from "omni-auth";

const redisLimiter: RateLimiter = {
  async check(key, maxAttempts, windowMs) {
    // 基于 Redis INCR + EXPIRE 实现
    // 返回 { allowed, remaining, resetAt }
  },
  async reset(key) { /* DEL key */ },
};

export const auth = createQuickAuth({
  database: { url: process.env.DATABASE_URL! },
  baseUrl: process.env.BETTER_AUTH_URL!,
  rateLimit: { limiter: redisLimiter },
});
```

限流键策略（2.1.0 起）：

| 接口 | 键 | 默认策略 |
|---|---|---|
| signUp | 客户端 IP | 3 次 / 1 小时 |
| signIn | `ip:provider:openid` | 5 次 / 15 分钟（成功后重置计数） |
| passwordReset | `ip:provider:openid` | 3 次 / 10 分钟 |
| verifyChannelCode | `provider:openid` | 默认关闭，opt-in |

signUp 按 IP 而非邮箱限流，防止攻击者消耗受害者邮箱配额、
锁死其注册的 DoS。

安全加固（4.1.0 起）：

```ts
export const auth = createQuickAuth({
  database: { url: process.env.DATABASE_URL! },
  baseUrl: process.env.BETTER_AUTH_URL!,
  rateLimit: {
    // 可信代理部署：从 x-forwarded-for 右侧数 1 跳，防头部伪造绕过限流
    getClientIp: (ctx) => getClientIp(ctx, { trustedProxyDepth: 1 }),
    // 防短验证码爆破（建议开启）
    verifyCode: { maxAttempts: 5, windowMs: 10 * 60 * 1000 },
  },
  // 收紧密码策略（默认最短 8 位）
  passwordPolicy: { minLength: 8 },
});
```

## 渠道模型（5.0.0）

认证域共五张表（schema.ts 单一事实源）：

- `user`：聚合身份 + 共享密码（`password` 可空，OAuth-only 用户无密码）
  + 元数据列 `active`（0/1，历史库可能为 boolean，读取时归一化）
- `socialAccount`：渠道身份（`provider + providerOpenid` 唯一），
  持有该渠道的 token / 资料 / 能力标记（valid / allowPasswordUpdate /
  allowVerification）
- `session`：宿主会话（`id`/`userId`/`token`/`expiresAt`/`createdAt`）
- `oauthToken`：授权码 + refresh token 生命周期（`(token, type)` 复合唯一）
- `oauthClient`：OAuth 客户端凭证（`client_secret` 由 Token Authority 证书承载）

邮箱是普通渠道：`(provider="email", providerOpenid=邮箱地址)`，与微信、
GitHub 等完全同构。`signUp` / `signIn` 是它的便捷方法；其他渠道一律走
`authenticateChannel`。任何渠道密码登录都验证同一个 `user.password`
（共享密码）。从 4.x 升级需运行迁移脚本（见 CHANGELOG 5.0.0）。

## 认证域语义 API（宿主接口面）

| 域 | 入口 | 职责 |
|---|---|---|
| 会话 | `auth.sessions.*` | 创建/校验/吊销会话、清理过期（内置账号禁用即时失效） |
| OAuth server | `auth.oauthServer.*` | 客户端 CRUD/续期、授权码、refresh token、access token（委托 TokenAuthorityClient） |
| 用户管理 | `auth.users.*` | 创建/更新/删除（包内单事务级联）、密码重置、列表搜索 |
| SCIM | `auth.scim.*` | SCIM 2.0 用户/组管理面 |
| 社交渠道 | `auth.socialAccounts`（内部） | 渠道绑定/解绑 |

## 设计决策

- **signUp 邮箱重复提示**：返回明文"该邮箱已被注册"。注册场景
  需要即时反馈，此为有意取舍；signIn 则统一错误消息防枚举。
- **OAuth state 校验**：3.0.0 起对象形式回调参数强制库内比对
  `state` 与 `expectedState`（后者必须来自服务端保存的签名 cookie，
  而非回调请求本身）。
- **非密码凭证契约**：`authenticateChannel` 对 smsCode / oauthCode
  等凭证不代为验证，调用方必须预先验证并声明
  `credential.verified = true`。
- **多表写入原子性**：注册流程（user + socialAccount）与删用户级联
  （session / socialAccount / oauthToken / user）包入
  `DatabaseAdapter.transaction`；自定义适配器未实现事务时
  回退为顺序写入（仅警告）。
- **令牌权威委托**：access token 签发/校验/续期/吊销委托宿主的
  `TokenAuthorityClient`（如集群证书服务 yunzone_auth），包内不实现
  令牌加密算法。
- **构建期安全**：`createQuickAuth` 的 autoSync 在 Next.js 生产构建
  阶段（NEXT_PHASE=phase-production-build）自动跳过，避免构建期
  触碰数据库。

## 许可

MIT
