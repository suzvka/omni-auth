# 账户认证服务模块启动开发文档

## 背景与目标

本项目实现一个用于 Next.js 上级项目的账户认证服务模块。该模块作为同进程内部模块交付，由其它业务模块调用，不作为独立 SaaS 或独立认证微服务。
技术选型：

```txt
Next.js App Router
Better Auth
PostgreSQL
TypeScript
```

核心原则：

```txt
Better Auth 负责认证系统。
业务数据库访问层负责读取业务账户。
Auth Module 负责把两者组合成稳定的内部 API。
业务模块只消费 AuthContext。
```

## 首版范围

首版交付一个同进程 Auth Module，范围包括：

* 初始化 Better Auth。
* 挂载 Next.js auth route handler。
* 读取当前请求的认证 session。
* 根据 `session.user.id` 解析业务账户。
* 提供 `getAuthContext()` 和 `requireAuthContext()`。
* 保持业务模块接入方式简单、稳定、可替换。
---

## 架构决策摘要

```txt
Next.js + Better Auth + 父项目现有数据库访问层
```

模块主路径：

```txt
当前请求
  ↓
Better Auth session
  ↓
session.user.id
  ↓
accountResolver.findByAuthUserId(authUserId)
  ↓
业务账户 Account
  ↓
AuthContext
```

关键决策：

1. 认证能力由 Better Auth 提供。
2. 业务账户独立于 Better Auth 认证表。
3. Auth Module 是业务模块访问认证上下文的唯一入口。
4. `accountResolver` 是首版唯一业务扩展点。
5. 认证库细节集中在 Auth Module 内部，便于未来替换。

首版补充决议：

6. 首版认证方式：email/password，不做邮箱有效性验证（测试用途）。
7. 用户注册时通过 Better Auth 注册回调自动创建 `business_account`。
8. 缺失业务账户时 `getAuthContext()` / `requireAuthContext()` 返回 `null`（而非抛错）。
9. `accountResolver` 通过全局注册注入，使用函数类型契约。
10. 登录/登出后跳转回触发来源页面（父页面）。
11. 首版暂不做请求级 AuthContext 缓存。

## 模块边界

### Better Auth

Better Auth 负责认证系统自身能力：

* 登录。
* 登出。
* Session 管理。
* Cookie 处理。
* 用户认证状态识别。
* 认证相关表，例如 `user`、`session`、`account`、`verification`。
* OAuth、email/password、插件等认证能力。

Better Auth 的数据库层只服务于认证系统。

### Auth Module

Auth Module 负责组合认证信息和业务账户：

* 创建 Better Auth 实例。
* 挂载 Next.js auth route handler。
* 提供 `getAuthContext()`。
* 提供 `requireAuthContext()`。
* 调用 `accountResolver` 读取业务账户。
* 对外返回稳定的 `AuthContext`。

### 业务模块

业务模块通过 Auth Module 获取当前账户：

```ts
import { requireAuthContext } from "@/modules/auth";

const { account } = await requireAuthContext();
```

业务模块只依赖 `AuthContext`，不感知 Better Auth 的 session、user、account、verification 等内部模型。

### accountResolver 契约

`accountResolver` 是 Auth Module 与业务层的唯一扩展点，通过全局注册注入：

```ts
// Auth Module 内部维护的全局引用
type AccountResolver = {
  findByAuthUserId(authUserId: string): Promise<Account | null>;
};

// 业务侧注册
import { setAccountResolver } from "@/modules/auth";

setAccountResolver({
  async findByAuthUserId(authUserId: string) {
    // 查询业务数据库
    return db.businessAccount.findUnique({ where: { authUserId } });
  },
});
```

约束：

- `setAccountResolver()` 必须在 Better Auth 初始化之前调用。
- 未注册 `accountResolver` 时，所有认证上下文查询将始终返回 `null`。

## AuthContext 类型

```ts
interface AuthContext {
  account: Account | null;
  authUserId: string | null;
}

interface Account {
  id: string;
  authUserId: string;
  displayName: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}
```

约定：

- `authUserId` 为 `null` 表示当前请求无认证 session。
- `account` 为 `null` 表示已认证但未关联业务账户。
- `AuthContext` 不暴露 Better Auth 的 session / user / account 等内部模型。

## 错误处理规范

```ts
// Auth Module 内部定义
class UnauthorizedError extends Error {
  code: string;
  message: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.message = message;
  }
}
```

使用场景：

| 函数 | 未认证 | 已认证但无业务账户 |
|------|--------|---------------------|
| `getAuthContext()` | 返回 `{ account: null, authUserId: null }` | 返回 `{ account: null, authUserId: "xxx" }` |
| `requireAuthContext()` | 抛出 `UnauthorizedError("UNAUTHENTICATED", ...)` | 返回 `{ account: null, authUserId: "xxx" }` |

`requireAuthContext()` 仅在无 session 时抛错。已认证但缺失业务账户时不会抛错，由调用方按 `account === null` 判断处理。

## 核心数据流

```txt
HTTP Request
   ↓
Next.js route / server action / RSC / API route
   ↓
业务模块调用 requireAuthContext()
   ↓
Auth Module 调用 Better Auth getSession()
   ↓
获得 authUserId
   ↓
accountResolver.findByAuthUserId(authUserId)
   ↓
从业务数据库读取 Account
   ↓
返回 AuthContext
```

## 数据模型建议

Better Auth 管理认证系统表，例如：

```txt
user
session
account
verification
```

业务侧维护独立业务账户表，例如：

```txt
business_account
```

示例字段：

```txt
id
auth_user_id
display_name
status
created_at
updated_at
```

建议约束：

```txt
auth_user_id UNIQUE NOT NULL
status NOT NULL
```

认证用户和业务账户之间通过 `auth_user_id` 关联。

注册回调自动创建业务账户：

```ts
// Better Auth 初始化时注册 databaseHooks
{
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // 认证用户创建后，自动创建关联业务账户
          await db.businessAccount.create({
            data: {
              authUserId: user.id,
              displayName: user.email ?? user.id,
              status: "active",
            },
          });
        },
      },
    },
  },
}
```

约束：

- 注册回调中创建 `business_account` 失败应阻断注册（抛错回滚）。
- 默认 `displayName` 使用邮箱地址，`status` 默认 `"active"`。

设计理由：

* 认证用户模型和业务账户模型生命周期不同。
* 业务字段增长时不会污染认证层。
* 未来替换认证库时，业务账户模型保持稳定。

---

## 数据库与持久化策略

认证数据和业务账户数据均由 Prisma 管理：

- Better Auth 使用 Prisma adapter 连接 PostgreSQL。
- 业务账户表加入同一 Prisma schema，统一迁移管理。
- Prisma Client 作为唯一数据库访问层。

业务账户数据由父项目业务数据库管理，通过 `accountResolver` 读取：

```ts
accountResolver.findByAuthUserId(authUserId)
```
## 配置管理

Auth Module 配置通过服务端配置文件集中管理：

```ts
// src/modules/auth/config.ts
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@/lib/prisma";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // 首版不做邮箱验证
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await prisma.businessAccount.create({
            data: {
              authUserId: user.id,
              displayName: user.email ?? user.id,
              status: "active",
            },
          });
        },
      },
    },
  },
});
```

环境变量清单：

```txt
DATABASE_URL          PostgreSQL 连接串
BETTER_AUTH_SECRET    认证签名密钥
BETTER_AUTH_URL       认证服务基础 URL
```

## 路由保护策略

首版推荐页面内部保护：

```ts
await requireAuthContext();
```

这种方式适合首版，因为：

* 接入简单。
* 行为明确。
* Server Component、Server Action、Route Handler 都可使用同一套上下文函数。

登录/登出后跳转策略：

- 完成后跳转回触发来源页面（父页面），不做固定跳转路径。
- 首版不做请求级 AuthContext 缓存，每次调用独立查询 session 和业务账户。性能优化留待后续。

当受保护页面明显增多后，可以再引入 middleware/proxy 做统一保护。

引入 middleware/proxy 时需要同时设计：

* 页面 redirect。
* API JSON 错误响应。
* 静态资源放行。
* 公开页面白名单。
* 登录页与回跳路径。
---

## 开发任务拆分

### Phase 1：基础模块搭建

任务：

* 安装 Better Auth。
* 创建 `src/modules/auth`。
* 创建 `auth.ts`。
* 挂载 `/api/auth/[...all]/route.ts`。
* 配置数据库连接。
* 跑通 Better Auth schema / migration。

验收：

```txt
登录/登出接口可用。
session 可被服务端读取。
认证表创建成功。
```

---

### Phase 2：业务账户解析

任务：

* 创建业务账户表。
* 建立 `auth_user_id` 唯一索引。
* 实现 `accountResolver.findByAuthUserId()`。
* 实现 `getAuthContext()`。
* 实现 `requireAuthContext()`。

验收：

```txt
登录用户能解析出业务账户。
未登录用户：`getAuthContext()` 返回 null，`requireAuthContext()` 抛出 UnauthorizedError。
缺失业务账户时：两者均返回 null（不抛错）。
```

---

### Phase 3：业务模块接入

任务：

* 在一个 Server Component 中接入 `requireAuthContext()`。
* 在一个 Route Handler 中接入 `requireAuthContext()`。
* 在一个 Server Action 中接入 `requireAuthContext()`。

验收：

```txt
业务模块通过 AuthContext 获取当前账户。
业务模块无需理解 Better Auth 内部模型。
业务账户查询逻辑集中在 accountResolver。
```

---

### Phase 4：测试与稳定化

任务：

* 单测 `accountResolver`。
* 单测 `getAuthContext()`。
* 单测 `requireAuthContext()`。
* 集成测试登录态。
* 验证未登录、session 过期、账户缺失等场景。

验收：

```txt
核心认证路径可测试。
错误路径行为稳定。
模块出口保持简单。
```

## 推荐交付标准

首版完成时应满足：

```txt
1. 可以登录。
2. 可以登出。
3. 服务端可以读取 session。
4. 可以根据 session.user.id 查到一条业务账户数据。
5. 其它模块可以通过 requireAuthContext() 获取 account。
6. 业务账户查询逻辑集中在 accountResolver。
7. 未登录和账户缺失有明确错误行为。
8. Auth Module 对外契约保持简单。
```

Auth Module 的价值是把认证系统和业务账户解析组合成一个稳定、简单、可替换的内部 API。
