# 提示词：将 Changfeng User Center 重命名为 OmniAuth（omni-auth）

> 使用方式：在新会话中粘贴本文件全部内容（或要求 agent 阅读本文件后执行）。
> 前置条件：仓库已同步到最新（本地 HEAD 应为 origin/main，即 0.6.1 代码，含 pg 原生适配器、db-push CLI、adapter-bridge）。

## 任务

将本仓库从 `changfeng-user-center` 全量改名为独立的开源项目 **OmniAuth**，不再与公司名绑定。

已确认决策（无需再问）：
- 主包 `omni-auth`，Next.js 集成包 `omni-auth-nextjs`，根项目 `omni-user-center`
- 公共 API 类名 `ChangfengAuth` → `OmniAuth`、`ChangfengAuthConfig` → `OmniAuthConfig`，旧名以 `@deprecated` alias 保留过渡
- 数据层字符串全部更换：数据库名 → `omni_user_center`、合成邮箱占位域 → `@phone.omni.internal`
- package.json author 改为 `Omni Auth Contributors`
- GitHub 新仓库：`suzvka/omni-auth`（private）；npm 发布新包名后对旧包 `npm deprecate`
- 保留 CHANGELOG 历史记录，追加 v0.6.0 迁移条目

## 执行清单

### 1. 目录物理重命名（保留 git 历史）
```bash
git mv packages/changfeng-auth packages/omni-auth
git mv packages/changfeng-auth-nextjs packages/omni-auth-nextjs
```

### 2. package.json 元数据
- 根：name → `omni-user-center`；scripts 中 `--filter changfeng-auth*` → `--filter omni-auth*`；dependencies 中 workspace 引用同步换名
- `packages/omni-auth/package.json`：name → `omni-auth`；description 去公司化（如 "OmniAuth — omnichannel authentication SDK, framework-agnostic, built on Better Auth"）；author → `Omni Auth Contributors`；bin 名换为 `omni-auth`（注意 0.6.1 的 bin 是 db-push 脚本，先读 package.json 确认 bin 字段）；repository/bugs/homepage 指向 `https://github.com/suzvka/omni-auth`；keywords 补 `omnichannel`、`channel-parity`
- `packages/omni-auth-nextjs/package.json`：同步换名；**关键坑**：dependencies 和 peerDependencies 中对 omni-auth 的引用必须用 `"workspace:*"`（若用 `^0.5.0` 会去 npm registry 404，因为新包名尚未发布）

### 3. 公共 API 类名
- `packages/omni-auth/src/auth.ts`：`ChangfengAuth` → `OmniAuth`、`ChangfengAuthConfig` → `OmniAuthConfig`（`ChangfengAuthConfig` 含 `ChangfengAuth` 子串，replace_all 一次即可，注意顺序）
- `packages/omni-auth/src/index.ts`：导出新名 + 追加过渡 alias（`export { OmniAuth as ChangfengAuth }`、`export type { OmniAuthConfig as ChangfengAuthConfig }`，标注 `@deprecated`）
- `packages/omni-auth/src/client.ts`：`createChangfengClient`/`ChangfengClient` → `createOmniClient`/`OmniClient`（直接改名，不加 alias）
- `packages/omni-auth-nextjs/src/index.ts`、`src/middleware.ts`：`ChangfengAuth` 类型导入 → `OmniAuth`

### 4. import 与字符串全量替换（用 grep 定位，别硬编码清单）
```bash
grep -ri changfeng --include=*.{ts,tsx,mjs,json,md,prisma,yaml} -l 排除 node_modules、dist、CHANGELOG 历史
```
- 所有 `changfeng-auth` → `omni-auth`、`changfeng-auth-nextjs` → `omni-auth-nextjs`（子串替换天然覆盖 `-nextjs` 后缀）
- 日志前缀 `[changfeng-auth ...]` → `[omni-auth ...]`
- 注释/文档示例中的旧包名
- **0.6.1 新文件必须覆盖**：`packages/omni-auth/bin/db-push.mjs`（banner/npx 用法）、`packages/omni-auth-nextjs/src/adapter-bridge.ts`（import）、`packages/omni-auth/src/builtin/pg/adapter.ts`（若有引用）
- `packages/omni-auth-nextjs/tsup.config.ts` 的 external 列表
- `src/lib/auth.ts` 与 `src/app/api/**` 的 import（0.6.1 已重构 lib/auth.ts，以实际 grep 结果为准）

### 5. 数据层字符串
- `src/modules/db/schema.declarative.json`：`"database": "changfeng_user_center"` → `"omni_user_center"`
- `packages/omni-auth/src/core/channel-mapping.ts`：`SYNTHETIC_EMAIL_DOMAIN = "@phone.changfeng.internal"` → `"@phone.omni.internal"`

### 6. lockfile
- 改完后 `pnpm install` 重新生成 pnpm-lock.yaml（workspace link 自动更新）

### 7. 文档
- `CHANGELOG.md`：保留历史，顶部追加 v0.6.0 条目（包名/API/数据层变更表 + 迁移说明）

### 8. eslint 配置
- `eslint.config.mjs` 的 globalIgnores 补充 `"**/dist/**"`（否则构建产物被 lint）

## 已验证的坑（前次执行记录）

1. **workspace 协议 404**：`omni-auth-nextjs` 依赖未发布的 `omni-auth` 时，dependencies 必须 `workspace:*`，否则 pnpm install 报 `ERR_PNPM_FETCH_404`
2. **better-auth 版本陷阱**：lockfile 若锁定 1.6.14，next build 会因 `@better-auth/kysely-adapter` 从 kysely 主入口导入 `DEFAULT_MIGRATION_LOCK_TABLE`（kysely 0.29 已移除该导出）而失败。解决方案：better-auth 统一升级到 **1.6.26**（根项目 + omni-auth 的 dependencies 声明 + omni-auth-nextjs 的 `@better-auth/prisma-adapter@^1.6.26` 配套升级），然后 pnpm install 重新解析（注意检查 `pnpm why better-auth`，确保全树只有一个版本，否则类型分裂报 TS2322）
3. **typecheck 顺序**：omni-auth-nextjs 的 tsc 解析 `omni-auth` 的 dist 类型声明，必须先 `pnpm --filter omni-auth build` 再 typecheck
4. **lint 预存错误**：`packages/omni-auth/src` 下有约 18 个改名前的 lint error（测试文件 no-explicit-any、adapter.ts Function 类型、auth.ts no-this-alias 等），与改名无关，不要顺手修
5. **next build 字体**：`src/app/layout.tsx` 用 `next/font/google`，离线环境会因无法访问 Google Fonts 失败，与改名无关，勿改代码
6. **em dash 编码**：package.json description 含 `—`（em dash），终端 cat 会显示乱码，用编辑器/Read 读取原文后再做 SearchReplace

## 验证清单

1. `pnpm install` 成功，lockfile 无 changfeng 残留
2. `pnpm --filter omni-auth build` → `pnpm -r --filter omni-auth --filter omni-auth-nextjs typecheck` 通过
3. `pnpm --filter omni-auth test`（101 个用例）通过
4. `pnpm -r --filter omni-auth --filter omni-auth-nextjs build` 通过
5. `grep -ri changfeng` 残留仅限：CHANGELOG v0.6.0 迁移记录 + index.ts 两处 deprecated alias
6. `pnpm lint` 只剩预存 src 错误（无 dist/新增错误）

## GitHub / npm 迁移（改名完成后，另行执行）

1. 创建新仓库 `suzvka/omni-auth`（private）：
   ```bash
   git remote set-url origin https://github.com/suzvka/omni-auth.git
   git push -u origin main
   ```
2. 归档旧仓库 `suzvka/ChangfengUserCenter`（GitHub API `PATCH /repos/suzvka/ChangfengUserCenter {"archived": true}`，或网页操作），描述注明已迁移
3. npm 发布：`pnpm build:packages` + `pnpm publish:packages`；随后 `npm deprecate changfeng-auth "已迁移至 omni-auth"`、`npm deprecate changfeng-auth-nextjs "已迁移至 omni-auth-nextjs"`
4. 旧数据库 `changfeng_user_center` 手动处理（bootstrap 会自动创建 `omni_user_center`）
