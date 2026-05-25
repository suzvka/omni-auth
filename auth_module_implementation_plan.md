# 账户认证服务模块 — 技术实现计划

## 环境要求

| 依赖 | 版本 |
|------|------|
| Node.js | >= 20 |
| PostgreSQL | >= 15 |
| pnpm（推荐） | >= 9 |

---

## Phase 0：项目脚手架与基础设施

### 0.1 创建 Next.js 项目

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm
```

### 0.2 安装依赖

```bash
pnpm add better-auth@^1
pnpm add @prisma/client
pnpm add -D prisma
```

> 锁定 Better Auth 主版本号，避免后续 breaking change 影响。

### 0.3 初始化 Prisma

```bash
npx prisma init
```

### 0.4 环境变量

创建 `.env.local`：

```env
DATABASE_URL=postgresql://user:password@localhost:5432/changfeng_user_center
BETTER_AUTH_SECRET=your-secret-key-change-in-production
BETTER_AUTH_URL=http://localhost:3000
```

> **生成 BETTER_AUTH_SECRET**：执行 `openssl rand -base64 32` 并将输出填入 `.env.local`。

### 0.5 Prisma Schema

编辑 `prisma/schema.prisma`：

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ============ Better Auth 认证表 ============

model User {
  id            String    @id @default(cuid())
  name          String
  email         String    @unique
  emailVerified Boolean   @default(false)
  image         String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  sessions      Session[]
  accounts      Account[]
  businessAccount BusinessAccount?
}

model Session {
  id        String   @id @default(cuid())
  expiresAt DateTime
  token     String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  userId String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  ipAddress String?
  userAgent String?
}

model Account {
  id        String   @id @default(cuid())
  accountId String
  providerId String
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  accessToken  String?
  refreshToken String?
  idToken      String?
  accessTokenExpiresAt DateTime?
  refreshTokenExpiresAt DateTime?
  scope        String?
  password     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Verification {
  id        String   @id @default(cuid())
  identifier String
  value     String
  expiresAt DateTime
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// ============ 业务表 ============

model BusinessAccount {
  id          String   @id @default(cuid())
  authUserId  String   @unique
  user        User     @relation(fields: [authUserId], references: [id], onDelete: Cascade)
  displayName String
  status      String   @default("active")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

### 0.6 数据库迁移

```bash
npx prisma migrate dev --name init
```

### 0.7 Prisma Client 单例

创建 `src/lib/prisma.ts`：

```ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

### Phase 0 验收

- [ ] `pnpm dev` 可启动
- [ ] `npx prisma studio` 可连接数据库
- [ ] 所有表已创建
- [ ] `.env.local` 已配置

---

## Phase 1：Better Auth 集成

### 1.1 创建 Auth Module 目录结构

```
src/
└── modules/
    └── auth/
        ├── index.ts          # 公共导出
        ├── config.ts         # Better Auth 实例化
        ├── context.ts        # getAuthContext / requireAuthContext
        ├── resolver.ts       # accountResolver 全局注册
        ├── errors.ts         # UnauthorizedError
        ├── types.ts          # AuthContext / Account 类型
        └── route.ts          # auth route handler
```

### 1.2 类型定义

创建 `src/modules/auth/types.ts`：

```ts
export interface Account {
  id: string;
  authUserId: string;
  displayName: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthContext {
  account: Account | null;
  authUserId: string | null;
}
```

### 1.3 错误类型

创建 `src/modules/auth/errors.ts`：

```ts
export class UnauthorizedError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
```

### 1.4 accountResolver 全局注册

创建 `src/modules/auth/resolver.ts`：

```ts
import type { Account } from "./types";

export type AccountResolver = {
  findByAuthUserId(authUserId: string): Promise<Account | null>;
};

let registeredResolver: AccountResolver | null = null;

export function setAccountResolver(resolver: AccountResolver): void {
  registeredResolver = resolver;
}

export function getAccountResolver(): AccountResolver | null {
  return registeredResolver;
}
```

### 1.5 Better Auth 实例化

创建 `src/modules/auth/config.ts`：

```ts
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@/lib/prisma";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    // 密码策略：使用 Better Auth 默认规则（首版不做特殊要求）
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 天
    updateAge: 60 * 60 * 24,     // 每天刷新一次
    rememberMe: {
      expiresIn: 60 * 60 * 24 * 30, // 记住我：30 天
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // 注册回调失败会向上抛错，Better Auth 会回滚注册
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

### 1.6 Auth Route Handler

创建 `src/app/api/auth/[...all]/route.ts`：

```ts
import { auth } from "@/modules/auth/config";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
```

### 1.7 测试 Better Auth 自身可用性

1. 访问 `http://localhost:3000/api/auth/sign-up/email` — 用 POST 创建用户
2. 访问 `http://localhost:3000/api/auth/sign-in/email` — 用 POST 登录
3. 检查数据库 `User` 表是否有记录
4. 检查数据库 `Session` 表是否有记录
5. 检查数据库 `BusinessAccount` 表是否通过回调自动创建了记录

### Phase 1 验收

- [ ] `POST /api/auth/sign-up/email` 返回成功
- [ ] `POST /api/auth/sign-in/email` 返回成功
- [ ] `User` 表有记录
- [ ] `Session` 表有记录
- [ ] `BusinessAccount` 表有对应的自动生成记录

---

## Phase 2：AuthContext 实现

### 2.1 实现 getAuthContext

编辑 `src/modules/auth/context.ts`：

```ts
import { headers } from "next/headers";
import { auth } from "./config";
import { getAccountResolver } from "./resolver";
import { UnauthorizedError } from "./errors";
import type { AuthContext } from "./types";

export async function getAuthContext(): Promise<AuthContext> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user?.id) {
    return { account: null, authUserId: null };
  }

  const authUserId = session.user.id;
  const resolver = getAccountResolver();

  if (!resolver) {
    return { account: null, authUserId };
  }

  const account = await resolver.findByAuthUserId(authUserId);
  return { account, authUserId };
}

export async function requireAuthContext(): Promise<AuthContext> {
  const ctx = await getAuthContext();

  if (ctx.authUserId === null) {
    throw new UnauthorizedError(
      "UNAUTHENTICATED",
      "Authentication required. Please sign in."
    );
  }

  return ctx;
}
```

### 2.2 注册 accountResolver

创建 `src/modules/auth/init.ts`：

```ts
import { setAccountResolver } from "./resolver";
import { prisma } from "@/lib/prisma";
import type { Account } from "./types";

export function initAuthModule(): void {
  setAccountResolver({
    async findByAuthUserId(authUserId: string): Promise<Account | null> {
      const record = await prisma.businessAccount.findUnique({
        where: { authUserId },
      });
      if (!record) return null;
      return {
        id: record.id,
        authUserId: record.authUserId,
        displayName: record.displayName,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    },
  });
}
```

### 2.3 在应用入口调用初始化

编辑 `src/app/layout.tsx`，在服务端组件中调用 `initAuthModule()`：

```tsx
import { initAuthModule } from "@/modules/auth/init";

// 确保模块级初始化（Next.js 服务端组件在首次渲染时执行）
initAuthModule();

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // ...
}
```

### 2.4 公共导出

编辑 `src/modules/auth/index.ts`：

```ts
export { getAuthContext, requireAuthContext } from "./context";
export { setAccountResolver } from "./resolver";
export { UnauthorizedError } from "./errors";
export { initAuthModule } from "./init";
export type { AuthContext, Account } from "./types";
export type { AccountResolver } from "./resolver";
```

### Phase 2 验收

- [ ] 登录后调用 `getAuthContext()` 返回 `{ account: {...}, authUserId: "..." }`
- [ ] 未登录调用 `getAuthContext()` 返回 `{ account: null, authUserId: null }`
- [ ] 未登录调用 `requireAuthContext()` 抛出 `UnauthorizedError`
- [ ] 手动删除 `BusinessAccount` 后，已登录用户调用返回 `{ account: null, authUserId: "..." }`

---

## Phase 3：业务模块接入验证

### 3.1 Server Component 接入（重定向模式）

创建 `src/app/protected/page.tsx`：

```tsx
import { getAuthContext } from "@/modules/auth";
import { redirect } from "next/navigation";

export default async function ProtectedPage() {
  const { account, authUserId } = await getAuthContext();

  if (!authUserId) {
    redirect("/login");
  }

  return (
    <div>
      <h1>受保护页面</h1>
      {account ? (
        <p>欢迎，{account.displayName}</p>
      ) : (
        <p>账户信息缺失</p>
      )}
    </div>
  );
}
```

> **设计说明**：Server Component 中使用 `getAuthContext()` + `redirect()` 而非 `requireAuthContext()`，因为后者抛出的异常不适合直接做页面跳转。`requireAuthContext()` 更适合 API Route / Server Action 场景（返回 401 或抛给调用方）。

### 3.2 Route Handler 接入

创建 `src/app/api/me/route.ts`：

```ts
import { NextResponse } from "next/server";
import { getAuthContext } from "@/modules/auth";

export async function GET() {
  const ctx = await getAuthContext();
  return NextResponse.json(ctx);
}
```

### 3.3 Server Action 接入

创建 `src/app/actions/profile.ts`：

```ts
"use server";

import { requireAuthContext } from "@/modules/auth";

export async function getProfile() {
  const { account } = await requireAuthContext();
  return { displayName: account?.displayName ?? "未关联账户" };
}
```

### 3.4 接入便捷 Hook（可选）

创建 `src/modules/auth/client.ts`：

```ts
"use client";

export { useSession } from "better-auth/react";
```

### Phase 3 验收

- [ ] 未登录访问 `/protected` → 重定向到 `/login`
- [ ] 登录后访问 `/protected` → 显示欢迎信息
- [ ] 未登录访问 `GET /api/me` → 返回 `{ account: null, authUserId: null }`
- [ ] 登录后访问 `GET /api/me` → 返回含 `account` 的完整上下文
- [ ] Server Action `getProfile()` 在未登录时抛错，登录后返回 `displayName`
- [ ] 业务模块完全不引入 Better Auth 类型

---

## Phase 4：测试与稳定化

### 4.1 安装测试依赖

```bash
pnpm add -D vitest @vitejs/plugin-react
```

### 4.2 单元测试 accountResolver

创建 `src/modules/auth/__tests__/resolver.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setAccountResolver, getAccountResolver } from "../resolver";

describe("accountResolver", () => {
  beforeEach(() => {
    // reset：再次 set 会覆盖
  });

  it("初始状态返回 null", () => {
    // getAccountResolver 在 set 之前返回 null
    // 注：由于全局单例，需在隔离环境中测试
  });

  it("注册后可通过 getAccountResolver 获取", () => {
    const mockResolver = {
      findByAuthUserId: async () => null,
    };
    setAccountResolver(mockResolver);
    expect(getAccountResolver()).toBe(mockResolver);
  });

  it("未注册时 getAuthContext 应返回 account: null", async () => {
    // 验证 resolver 为空时的降级行为
  });
});
```

### 4.3 单元测试 getAuthContext / requireAuthContext

创建 `src/modules/auth/__tests__/context.test.ts`：

```ts
import { describe, it, expect } from "vitest";

describe("getAuthContext", () => {
  it("未登录返回 null context");
  it("已登录且 resolver 未注册返回 account: null");
  it("已登录且 resolver 已注册返回完整 context");
  it("已登录但 businessAccount 不存在返回 account: null");
});

describe("requireAuthContext", () => {
  it("未登录抛出 UnauthorizedError");
  it("已登录但无 businessAccount 不抛错，返回 account: null");
  it("已登录且有 businessAccount 返回完整 context");
});
```

### 4.4 错误路径验证清单

| 场景 | 预期行为 |
|------|---------|
| 未登录 → `requireAuthContext()` | 抛出 `UnauthorizedError("UNAUTHENTICATED", ...)` |
| 未登录 → `getAuthContext()` | `{ account: null, authUserId: null }` |
| 未登录访问受保护页面 | `getAuthContext()` + `redirect("/login")` 重定向 |
| Session 过期 | 同「未登录」 |
| 已登录，手动删除 `BusinessAccount` | `{ account: null, authUserId: "xxx" }` |
| `accountResolver` 未注册 | `{ account: null, authUserId: "xxx" }` |
| 数据库连接失败 | 向上抛出原始错误（不吞没） |
| 注册回调中 `businessAccount` 创建失败 | 抛错回滚，注册失败 |

### Phase 4 验收

- [ ] 全部单元测试通过
- [ ] 错误路径的表单行为与预期一致

---

## 交付物总清单

| # | 文件 | 说明 |
|---|------|------|
| 1 | `src/lib/prisma.ts` | Prisma Client 单例 |
| 2 | `prisma/schema.prisma` | 完整数据库 schema |
| 3 | `src/modules/auth/types.ts` | AuthContext / Account 类型 |
| 4 | `src/modules/auth/errors.ts` | UnauthorizedError |
| 5 | `src/modules/auth/resolver.ts` | accountResolver 全局注册 |
| 6 | `src/modules/auth/config.ts` | Better Auth 实例化 |
| 7 | `src/modules/auth/context.ts` | getAuthContext / requireAuthContext |
| 8 | `src/modules/auth/init.ts` | 模块初始化 |
| 9 | `src/modules/auth/index.ts` | 公共导出 |
| 10 | `src/modules/auth/client.ts` | 客户端 hook（可选） |
| 11 | `src/app/api/auth/[...all]/route.ts` | Auth route handler |
| 12 | `src/app/layout.tsx` | 注入 initAuthModule() |
| 13 | `src/app/protected/page.tsx` | Server Component 接入验证 |
| 14 | `src/app/api/me/route.ts` | Route Handler 接入验证 |
| 15 | `src/app/actions/profile.ts` | Server Action 接入验证 |
| 16 | `.env.local` | 环境变量 |
