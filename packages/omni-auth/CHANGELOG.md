# Changelog

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
