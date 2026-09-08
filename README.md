<div align="center">

# omni-auth 应签尽签·全渠道认证工具

**把整个认证域封装成黑盒，装进你的应用就能用。**

邮箱、手机、微信、GitHub 一律平权 —— 零 SQL、零表名、零事务编排。

[![license](https://img.shields.io/badge/license-MIT-blue)](#license)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)]()
[![next](https://img.shields.io/badge/peer-next%20%3E%3D16%20(optional)-000000)]()
[![module](https://img.shields.io/badge/module-ESM%20%2B%20CJS-orange)]()

</div>

---

## 为什么选 omni-auth

自建一套生产级认证，你会反复踩同一批坑：每个渠道的凭证形态都不一样、特判代码越堆越乱；会话、OAuth 2.0 Server、SCIM 每一块都是又深又安全敏感的轮子；认证表散落在宿主库里，业务逻辑和认证逻辑越缠越死。

omni-auth 的答案是：**认证域黑盒 + 全渠道平权 + 语义 API + 单一事实源**。你只调 API，剩下的全部住在包内。

-  **自托管数据库** —— 只需提供一个 PostgreSQL 标准数据库操作对象，即可全自动完成数据库初始化
-  **认证域黑盒** —— 全部认证逻辑包内私有，宿主不碰一行 SQL、不 JOIN 一张认证表、不编排一个事务
-  **全渠道平权** —— 一个入口 `authenticateChannel` + 必填 `intent`，渠道特判从此消亡
-  **安全内建** —— 限流、防枚举统一错误消息、OAuth `state` + PKCE 强制校验、验证码防爆破，默认即开
-  **一等 Next.js 集成** —— `createQuickAuth` 一站式封装：连接池注入、自动建表、会话 cookie、构建期自动跳过数据库

## 🚀 快速开始

```bash
pnpm add omni-auth pg
```

```ts
// lib/auth.ts
import { createQuickAuth } from "omni-auth/nextjs";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const auth = createQuickAuth({
  database: { pool },
  baseUrl: process.env.BETTER_AUTH_URL!,
  autoSync: true, // 仅开发期：幂等建表/迁移，异步执行。生产见下方部署提示
});
```

> **建表时机**：`autoSync: true` 的 schema 同步是**异步**的，适合本地开发；
> 首个请求理论上可能与建表竞争。生产环境应在**部署阶段**显式建表后再放量 ——
> 用 `omni-auth-codegen` 生成 DDL 交迁移工具，或在启动钩子里
> `import { syncSchema } from "omni-auth/schema"` 后 `await syncSchema(pool)` 完成再开始服务，运行期则保持 `autoSync` 关闭。

## 🔁 跑通一次浏览器登录（Email + Password）

一个最小闭环需要：注册 → 登录 → 后续请求读会话 → 登出。下面四个 Route Handler 可直接复制：

```ts
// app/api/auth/register/route.ts
import { NextResponse } from "next/server";
import { auth, OmniAuthError } from "omni-auth/nextjs";

export async function POST(req: Request) {
  const { email, password, name } = await req.json();
  try {
    await auth.authenticateChannel({
      provider: "email", identifier: email, intent: "signUp",
      credential: { type: "password", value: password },
      profile: { name },
      channelData: { allowPasswordUpdate: true, allowVerification: true },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof OmniAuthError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
```

```ts
// app/api/auth/login/route.ts
import { NextResponse } from "next/server";
import { auth, setSessionCookie, OmniAuthError } from "omni-auth/nextjs";

export async function POST(req: Request) {
  const { email, password } = await req.json();
  try {
    const { userId } = await auth.authenticateChannel({
      provider: "email", identifier: email, intent: "signIn",
      credential: { type: "password", value: password },
    });
    const { token } = await auth.sessions.createSession(userId);
    const res = NextResponse.json({ ok: true });
    setSessionCookie(res, token); // HttpOnly / SameSite=Lax / 生产加 Secure
    return res;
  } catch (e) {
    if (e instanceof OmniAuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    throw e;
  }
}
```

```ts
// app/api/auth/me/route.ts
import { NextResponse } from "next/server";
import { auth, getSessionTokenFromCookies } from "omni-auth/nextjs";

export async function GET() {
  const token = await getSessionTokenFromCookies();
  const userId = token ? await auth.sessions.validateSession(token) : null;
  if (!userId) return NextResponse.json({ user: null }, { status: 401 });
  const user = await auth.users.getUser(userId);
  return NextResponse.json({ user });
}
```

```ts
// app/api/auth/logout/route.ts
import { NextResponse } from "next/server";
import { auth, getSessionTokenFromCookies, clearSessionCookie } from "omni-auth/nextjs";

export async function POST() {
  const token = await getSessionTokenFromCookies();
  if (token) await auth.sessions.invalidateSession(token);
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
```

> **关于 `intent`（8.0.0 起必填）**：`signUp` 渠道已存在即报错，`signIn` 渠道不存在即失败（绝不建号），
> 二者边界清晰；`upsert`（不存在则注册）用于 OAuth 回调 / 管理侧建号等场景，需显式声明。

## 🌐 OAuth 等其它渠道

微信、手机号等一律走同一个入口，没有任何特殊分支。**注意：`authenticateChannel` 不代为验证非密码凭证** —— OAuth code / 短信验证码需由调用方先行 exchange / 校验，确认身份后再以 `verified: true` 声明：

```ts
// 你先拿 code 向微信换取 openid，再交给 omni-auth 做身份解析 / 登录
await auth.authenticateChannel({
  provider: "wechat",
  identifier: openid,
  intent: "upsert",
  credential: { type: "oauthCode", value: code, verified: true },
  profile: { name: nickname },
});
```

想要自己的 OAuth 2.0 Server 或 SCIM 目录？命名空间里现成的：

```ts
await auth.oauthServer.createOAuthClient({ clientName: "my-app" });
await auth.scim.list({ pagination: { startIndex: 1, count: 20 }, filter: null });
```

> 框架无关的底座入口是 `createAuth({ database, baseUrl })`；`createQuickAuth` 是它叠加 Next.js 一站式能力的封装。

> **公开面分层（8.0.0）**：root `omni-auth` 只保留 happy-path 装配（`createAuth` / 错误族 / 核心类型）；高级能力走明确子入口 —— `omni-auth/nextjs`、`omni-auth/schema`（`syncSchema` + DSL）、`omni-auth/oauth`（provider 工厂）、`omni-auth/oauth-server`、`omni-auth/scim`、`omni-auth/request`、`omni-auth/adapters/pg`、`omni-auth/codegen-*`。

## 📦 盒子里有什么

| 能力 | 说明 |
| --- | --- |
| 凭证校验 | 密码 / 短信验证码 / OAuth code，全渠道统一入口，事务原子写入 |
| 会话管理 | 创建 / 校验 / 吊销，账号禁用旧会话**立即失效** |
| 用户管理 | 增删改查、级联删除、改密即吊销全部会话 |
| OAuth 2.0 Server | 客户端、授权码、PKCE、refresh token、scope 协商 |
| 外部 OAuth 登录 | Google / GitHub / 微信 provider 工厂，`state` 库内强制比对 |
| SCIM 2.0 | 用户目录管理面：list / get / create / update / patch / remove |
| 验证码委托 | 库生成密码学安全种子码，投递 / 校验委托你的网关；可按 provider 声明禁用（生成 + 校验闭环） |
| 限流与审计 | 可注入 Redis 限流器，审计事件钩子开箱即用 |

## 📚 深入了解

- [CHANGELOG](./CHANGELOG.md) —— 版本迭代与破坏性变更记录（含迁移指南）
- [AGENTS.md](./AGENTS.md) —— 项目边界约定

## 🛠️ 开发

```bash
pnpm install     # 安装依赖
pnpm build       # 构建工具库（ESM + CJS + 类型 + sourcemap）
pnpm test        # 运行测试（vitest）
```

发布由 GitHub Actions 驱动，见 [`.github/workflows/publish.yml`](./.github/workflows/publish.yml)。

## License

[MIT](./packages/omni-auth/package.json)
