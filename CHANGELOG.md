# Changelog

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
