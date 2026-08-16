# omni-auth

OmniAuth — 全渠道认证 SDK，框架无关，一等 Next.js 集成。

## 职责边界（重要）

**本 SDK 只负责凭证校验**：用户是否存在、密码是否正确、渠道凭证
是否有效，并完成用户/渠道记录的持久化。**不维护任何会话状态**
（不签发、不存储、不校验 session token），会话由应用层自行管理。

## 快速开始

```ts
import { createQuickAuth } from "omni-auth/nextjs";

export const auth = createQuickAuth({
  database: { url: process.env.DATABASE_URL! },
  baseUrl: process.env.BETTER_AUTH_URL!,
});

// 注册
await auth.signUp({ email, password, name });
// 登录（统一错误消息防枚举）
await auth.signIn({ email, password });
```

建表：

```sh
npx omni-auth db:push
```

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

存储层为两张表：

- `user`：聚合身份 + 共享密码（`password` 可空，OAuth-only 用户无密码）
- `socialAccount`：渠道身份（`provider + providerOpenid` 唯一），
  持有该渠道的 token / 资料 / 能力标记（valid / allowPasswordUpdate /
  allowVerification）

邮箱是普通渠道：`(provider="email", providerOpenid=邮箱地址)`，与微信、
GitHub 等完全同构。`signUp` / `signIn` 是它的便捷方法；其他渠道一律走
`authenticateChannel`。任何渠道密码登录都验证同一个 `user.password`
（共享密码）。从 4.x 升级需运行迁移脚本（见 CHANGELOG 5.0.0）。

## 设计决策

- **signUp 邮箱重复提示**：返回明文"该邮箱已被注册"。注册场景
  需要即时反馈，此为有意取舍；signIn 则统一错误消息防枚举。
- **OAuth state 校验**：3.0.0 起对象形式回调参数强制库内比对
  `state` 与 `expectedState`（后者必须来自服务端保存的签名 cookie，
  而非回调请求本身）。
- **非密码凭证契约**：`authenticateChannel` 对 smsCode / oauthCode
  等凭证不代为验证，调用方必须预先验证并声明
  `credential.verified = true`。
- **多表写入原子性**：注册流程（user + socialAccount）
  包入 `DatabaseAdapter.transaction`；自定义适配器未实现事务时
  回退为顺序写入（仅警告）。

## 许可

MIT
