# omni-auth

OmniAuth — 全渠道认证 SDK（omnichannel authentication），框架无关，一等 Next.js 集成。

**本仓库的定位：SDK 仓库。** 唯一的产品是 `packages/omni-auth`（npm 包 `omni-auth`）；
`apps/demo` 只是用于开发调试 / 手动验证 SDK 行为的演示宿主，不是产品、不参与发布。

## 仓库结构

```
onmi-auth/
├── packages/omni-auth/   # 唯一产品：SDK 源码、CLI（bin/）、测试、发布配置
│   ├── src/              # 认证域实现（schema / adapters / core / oauth / scim / nextjs）
│   ├── bin/              # CLI：omni-auth db:push / codegen / migrate-v5
│   ├── CHANGELOG.md      # 版本与破坏性变更记录
│   └── README.md         # SDK 使用文档（快速开始、API、设计决策）
├── apps/demo/            # 演示/开发宿主（Next.js），仅用于手动测试 SDK，非产品
└── .github/workflows/    # 发布流水线（只发布 packages/omni-auth 到 npm）
```

## 快速开始

使用 SDK 请阅读 [packages/omni-auth/README.md](packages/omni-auth/README.md)：

```ts
import { createQuickAuth } from "omni-auth/nextjs";

export const auth = createQuickAuth({
  database: { pool },                    // 连接池由宿主注入
  baseUrl: process.env.BETTER_AUTH_URL!,
  autoSync: true,                        // 幂等建表/迁移（schema.ts 单一事实源）
});
```

```sh
npx omni-auth db:push                    # 或单独执行建表
```

## 开发命令

```sh
pnpm install             # 安装 workspace 依赖
pnpm build               # 构建 SDK（packages/omni-auth → dist/）
pnpm test                # 运行 SDK 测试（vitest）
pnpm typecheck           # SDK 类型检查
pnpm dev                 # 启动演示宿主（apps/demo，Next.js dev server）
pnpm publish             # 发布 SDK 到 npm（--access public）
```

发布流程由 GitHub Actions（`.github/workflows/publish.yml`）驱动：手动触发或
GitHub Release 发布时构建并发布 `omni-auth` 包。SDK 的版本迭代记录见
[packages/omni-auth/CHANGELOG.md](packages/omni-auth/CHANGELOG.md)。

## 架构约束

- 认证域（user / socialAccount / session / oauthToken / oauthClient 表与全部逻辑）
  是 SDK 的黑盒：只经 `omni-auth` 公开 API 访问，宿主零 SQL、零表名、零事务编排。
- 连接池由宿主注入（`PgPoolLike` 最小结构接口），SDK 不建池、不关池。
- SDK 零依赖 `yunzone-service-kit`；接线只发生在宿主应用层（见 `apps/demo`）。
- 自动建表/迁移由 `schema.ts` 单一管理，`autoSync` 与 CLI `db:push` 复用同一实现。

详见 [AGENTS.md](AGENTS.md) 的完整边界约定。

## 许可

MIT
