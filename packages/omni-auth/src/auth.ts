// ============================================================
// OmniAuth — SDK 主类
//
// 提供框架无关的认证 API。
// ============================================================

import { randomUUID } from "crypto";
import { hashPassword, verifyPassword } from "@better-auth/utils/password";
import type { DatabaseAdapter } from "./adapters/database";
import type { PublicUser } from "./types";
import type { LifecycleHooks, UserCreatedPayload } from "./core/lifecycle";
import { createSocialService } from "./social/service";
import { registerTokenRefresher, type TokenRefresher, type SocialAccountRef } from "./social/token";
import { registerOAuthProvider } from "./oauth/registry";
import type { OAuthProviderConfig } from "./oauth/types";
import { createOAuthHandler, setOAuthHandler } from "./oauth/handler";
import type { OAuthCallbackResult } from "./oauth/types";
import { createPasswordReset } from "./core/password";
import { hasRole, hasAnyRole, requireRole, requireAnyRole } from "./core/roles";
import { publishAuditEvent } from "./core/audit";
import { createChannelVerification, registerVerificationSender, registerVerificationVerifier } from "./core/verification-channel";
import type { VerificationSender, VerificationVerifier } from "./core/verification-channel";
import {
  phoneToSyntheticEmail,
  generateRandomPassword,
} from "./core/channel-mapping";
import { createMemoryRateLimiter, checkRateLimit } from "./core/rateLimit";

// ----------------------------------------------------------
// SDK 配置
// ----------------------------------------------------------

export interface OmniAuthConfig {
  /** 数据库适配器（必填） */
  database: DatabaseAdapter;
  /** 密钥 */
  secret: string;
  /** 应用基础 URL（用于生成重置链接等） */
  baseUrl: string;
  /** 生命周期钩子 */
  hooks?: LifecycleHooks;
}

// ----------------------------------------------------------
// 用户管理 API 的输入/输出类型
// ----------------------------------------------------------

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
  /**
   * 通道记录（可选）。
   * 提供则直接写入 SocialAccount；未提供则自动从 email 推断。
   */
  channel?: {
    provider: string;
    identifier: string;
  };
}

export interface SignUpResult {
  userId: string;
  /** 创建后的完整用户信息 */
  user: PublicUser;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface SignInResult {
  userId: string;
  /** 登录后的完整用户信息 */
  user: PublicUser;
}

// ----------------------------------------------------------
// 统一通道认证 — ChannelAuthInput / ChannelAuthResult
// ----------------------------------------------------------

export interface ChannelAuthInput {
  /** 通道类型，如 "email" / "phone" / "wechat" */
  provider: string;
  /** 通道标识符（邮箱地址、手机号、openid 等） */
  providerOpenid: string;
  /** 凭证 */
  credential: {
    /** 凭证类型："password" | "oauthCode" | "smsCode" 等 */
    type: string;
    /** 凭证值 */
    value: string;
  };
  /** 用户资料（新用户注册时使用） */
  profile?: {
    name?: string;
    image?: string;
    [key: string]: unknown;
  };
  /** 绑定到通道的额外数据 */
  channelData?: {
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: Date | number;
    profileData?: Record<string, unknown>;
    valid?: number;
    allowPasswordUpdate?: number;
    allowVerification?: number;
  };
}

export interface ChannelAuthResult {
  userId: string;
  isNewUser: boolean;
  /** 登录/注册后的完整用户信息 */
  user: PublicUser;
  channel: {
    id: string;
    provider: string;
    providerOpenid: string;
    valid: number;
    allowPasswordUpdate: number;
    allowVerification: number;
  };
}

export interface SignUpWithSocialInput {
  email: string;
  password: string;
  name: string;
  /** 社交平台绑定信息 */
  social: {
    provider: string;
    providerOpenid: string;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: Date | number;
    profileData?: Record<string, unknown>;
  };
}

// ----------------------------------------------------------
// OmniAuth 主类
// ----------------------------------------------------------

export class OmniAuth {
  private config: OmniAuthConfig;
  private _socialService: ReturnType<typeof createSocialService>;
  private _passwordReset: ReturnType<typeof createPasswordReset> | null = null;
  private _channelVerification: ReturnType<typeof createChannelVerification> | null = null;
  /** 速率限制器（内存实现，各接口独立限流） */
  private _signInRateLimit = createMemoryRateLimiter();
  private _signUpRateLimit = createMemoryRateLimiter();
  private _passwordResetRateLimit = createMemoryRateLimiter();
  /** user.create.after 钩子列表（signUp 内联触发） */
  private _afterUserCreateHooks: Array<(user: { id: string; email?: string; name?: string }) => Promise<void>> = [];

  constructor(config: OmniAuthConfig) {
    this.config = config;

    // 创建社交账户服务
    this._socialService = createSocialService(config.database);

    // 初始化 OAuth handler
    const oauthHandler = createOAuthHandler({
      db: config.database,
      socialService: this._socialService,
    });
    setOAuthHandler(oauthHandler);

    // 初始化密码重置
    this._passwordReset = createPasswordReset({
      db: config.database,
    });

    // 初始化渠道验证码（委托模式，无状态、无 db 依赖）
    this._channelVerification = createChannelVerification();

    // ----------------------------------------------------------
    // 收集 user.create.after hooks（signUp / OAuth 回调内联触发）
    // ----------------------------------------------------------

    // 1. SDK 级别 onUserCreated
    if (config.hooks?.onUserCreated) {
      const onUserCreated = config.hooks.onUserCreated;
      this._afterUserCreateHooks.push(async (user: { id: string; email?: string; name?: string }) => {
        await onUserCreated({ userId: user.id, email: user.email, name: user.name });
      });
    }

  }

  // ----------------------------------------------------------
  // 用户认证
  // ----------------------------------------------------------

  async signUp(input: SignUpInput): Promise<SignUpResult> {
    // 0. 速率限制：3 次/小时
    await checkRateLimit(this._signUpRateLimit, input.email, 3, 60 * 60 * 1000);

    // 1. 验证密码长度
    if (input.password.length < 6) {
      throw new Error("密码长度不能少于 6 位");
    }

    // 2. 检查邮箱是否已注册
    const existingUser = await this.config.database.findOne({
      model: "user",
      where: [{ field: "email", value: input.email }],
    });
    if (existingUser) {
      throw new Error("该邮箱已被注册");
    }

    // 3. 哈希密码
    const hashedPassword = await hashPassword(input.password);

    // 4. 创建 user + account
    const userId = randomUUID();
    const now = new Date();

    await this.config.database.create({
      model: "user",
      data: {
        id: userId,
        name: input.name,
        email: input.email,
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    });

    await this.config.database.create({
      model: "account",
      data: {
        id: randomUUID(),
        accountId: input.email,
        providerId: "credential",
        userId,
        password: hashedPassword,
        createdAt: now,
        updatedAt: now,
      },
    });

    // 5. 触发 user.create.after 钩子
    // ---- 在 BusinessAccount 创建之前触发，避免钩子重复创建导致 @@unique 约束冲突
    for (const hook of this._afterUserCreateHooks) {
      try {
        await hook({ id: userId, email: input.email, name: input.name });
      } catch (err) {
        console.error("[signUp] user.create.after hook 执行失败:", err);
      }
    }

    // 4b. 创建 BusinessAccount
    // ---- 检查是否已存在（onUserCreated 钩子可能已创建）
    const existingBiz = await this.config.database.findOne({
      model: "businessAccount",
      where: [{ field: "authUserId", value: userId }],
    });
    if (!existingBiz) {
      await this.config.database.create({
        model: "businessAccount",
        data: {
          id: randomUUID(),
          authUserId: userId,
          displayName: input.name || input.email,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    // 6. 写入 SocialAccount 通道记录
    const channelProvider = input.channel?.provider ?? "email";
    const channelId = input.channel?.identifier ?? input.email;

    if (channelProvider && channelId) {
      try {
        await this._socialService.bindToUser(userId, {
          provider: channelProvider,
          providerOpenid: channelId,
        });
      } catch (channelErr: unknown) {
        console.warn(
          `[signUp] 通道记录写入失败 (userId=${userId}, provider=${channelProvider}):`,
          channelErr instanceof Error ? channelErr.message : String(channelErr)
        );
      }
    }

    publishAuditEvent({ action: "signUp", userId });

    // 7. 读取完整用户信息并返回
    const user = await this._readPublicUser(userId);

    return {
      userId,
      user,
    };
  }

  async signIn(input: SignInInput): Promise<SignInResult> {
    // 0. 速率限制：5 次/15 分钟
    await checkRateLimit(this._signInRateLimit, input.email, 5, 15 * 60 * 1000);

    // 1. 查找用户
    const user = await this.config.database.findOne({
      model: "user",
      where: [{ field: "email", value: input.email }],
    }) as Record<string, unknown> | null;

    // 2. 查找 credential account
    const account = user
      ? await this.config.database.findOne({
          model: "account",
          where: [
            { field: "userId", value: user.id },
            { field: "providerId", value: "credential" },
          ],
        }) as Record<string, unknown> | null
      : null;

    // 3. 统一错误消息防枚举
    if (!user || !account || !account.password) {
      publishAuditEvent({
        action: "signInFailed",
        metadata: { email: input.email },
      });
      throw new Error("邮箱或密码错误");
    }

    // 4. 校验密码
    const isValid = await verifyPassword(account.password as string, input.password);
    if (!isValid) {
      publishAuditEvent({
        action: "signInFailed",
        metadata: { email: input.email },
      });
      throw new Error("邮箱或密码错误");
    }

    publishAuditEvent({ action: "signIn", userId: user.id as string });

    // 5. 读取完整用户信息并返回
    const fullUser = await this._readPublicUser(user.id as string);

    return {
      userId: user.id as string,
      user: fullUser,
    };
  }

  // ----------------------------------------------------------
  // 统一通道认证
  // ----------------------------------------------------------

  /**
   * 统一通道认证入口。
   * 自动判断注册/登录：渠道不存在则新建用户 + 绑定；已存在则直接登录。
   */
  async authenticateChannel(input: ChannelAuthInput): Promise<ChannelAuthResult> {
    // 1. 检查渠道是否已存在
    const existingChannel = await this._socialService.findByProvider(
      input.provider,
      input.providerOpenid
    );

    if (existingChannel) {
      // 已有绑定 → 登录（凭证校验）
      let result: SignInResult;
      if (input.credential.type === "password") {
        // 通过合成邮箱找回用户并登录
        const syntheticEmail = this._buildChannelEmail(input.provider, input.providerOpenid);
        result = await this.signIn({ email: syntheticEmail, password: input.credential.value });
      } else {
        // 非密码凭证：调用者已自行验证
        const existingUserForSession = await this._readPublicUser(existingChannel.userId);
        result = { userId: existingChannel.userId, user: existingUserForSession };
      }

      publishAuditEvent({ action: "signIn", userId: result.userId });

      const existingUser = await this._readPublicUser(result.userId);

      return {
        userId: result.userId,
        isNewUser: false,
        user: existingUser,
        channel: {
          id: existingChannel.id,
          provider: existingChannel.provider,
          providerOpenid: existingChannel.providerOpenid,
          valid: existingChannel.valid,
          allowPasswordUpdate: existingChannel.allowPasswordUpdate,
          allowVerification: existingChannel.allowVerification,
        },
      };
    }

    // 2. 不存在 → 注册新用户
    const syntheticEmail = this._buildChannelEmail(input.provider, input.providerOpenid);
    const password = input.credential.type === "password"
      ? input.credential.value
      : generateRandomPassword();
    const name = input.profile?.name ?? input.providerOpenid;

    const signUpResult = await this.signUp({
      email: syntheticEmail,
      password,
      name,
      channel: { provider: input.provider, identifier: input.providerOpenid },
    });

    // 3. 更新渠道字段（signUp 已创建基础 SocialAccount，此处追加 valid / extra data）
    //    注意：signUp 内部已调用 bindToUser，不可再调 bindToUser（会抛 SocialAccountConflictError）
    const channelUpdate = {
      accessToken: input.channelData?.accessToken,
      refreshToken: input.channelData?.refreshToken,
      tokenExpiresAt:
        input.channelData?.tokenExpiresAt != null
          ? input.channelData.tokenExpiresAt instanceof Date
            ? input.channelData.tokenExpiresAt
            : new Date(input.channelData.tokenExpiresAt)
          : undefined,
      profileData: input.channelData?.profileData,
      valid: input.channelData?.valid ?? 1,
      allowPasswordUpdate: input.channelData?.allowPasswordUpdate ?? 0,
      allowVerification: input.channelData?.allowVerification ?? 0,
    };

    const updatedRecord = (await this.config.database.updateOne({
      model: "socialAccount",
      where: [
        { field: "provider", value: input.provider },
        { field: "providerOpenid", value: input.providerOpenid },
      ],
      update: channelUpdate,
    })) as Record<string, unknown>;

    publishAuditEvent({ action: "signUp", userId: signUpResult.userId });

    const newUser = await this._readPublicUser(signUpResult.userId);

    return {
      userId: signUpResult.userId,
      isNewUser: true,
      user: newUser,
      channel: {
        id: updatedRecord.id as string,
        provider: input.provider,
        providerOpenid: input.providerOpenid,
        valid: (updatedRecord.valid as number) ?? 1,
        allowPasswordUpdate: (updatedRecord.allowPasswordUpdate as number) ?? 0,
        allowVerification: (updatedRecord.allowVerification as number) ?? 0,
      },
    };
  }

  // ----------------------------------------------------------
  // 内部辅助
  // ----------------------------------------------------------

  /** 为指定渠道构建合成邮箱 */
  private _buildChannelEmail(provider: string, providerOpenid: string): string {
    if (provider === "phone") {
      return phoneToSyntheticEmail(providerOpenid);
    }
    if (provider === "email") {
      return providerOpenid;
    }
    // OAuth 等其他渠道：生成占位邮箱
    return `${provider}_${providerOpenid.substring(0, 12)}@oauth.usercenter`;
  }

  /** 从数据库读取完整用户信息并转为 PublicUser */
  private async _readPublicUser(userId: string): Promise<PublicUser> {
    const record = await this.config.database.findOne({
      model: "user",
      where: [{ field: "id", value: userId }],
    }) as Record<string, unknown> | null;

    if (!record) {
      // 兜底：用 ID 构造最小化对象
      return {
        id: userId,
        name: "",
        email: "",
        emailVerified: false,
        image: null,
        role: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    return {
      id: record.id as string,
      name: (record.name as string) ?? "",
      email: (record.email as string) ?? "",
      emailVerified: (record.emailVerified as boolean) ?? false,
      image: (record.image as string) ?? null,
      role: (record.role as string) ?? null,
      createdAt: record.createdAt as Date,
      updatedAt: record.updatedAt as Date,
    };
  }

  // ----------------------------------------------------------
  // 社交注册
  // ----------------------------------------------------------

  /**
   * 注册新用户并同时绑定社交账户。
   * 原子操作：注册 + 社交绑定要么全部成功，要么全部失败。
   */
  async signUpWithSocial(input: SignUpWithSocialInput): Promise<SignUpResult> {
    // 1. 密码校验
    if (input.password.length < 6) {
      throw new Error("密码长度不能少于 6 位");
    }

    // 2. 防重复：检查社交账户是否已被绑定
    const existingSocial = await this._socialService.findByProvider(
      input.social.provider,
      input.social.providerOpenid
    );
    if (existingSocial) {
      throw new Error("该社交账号已被其他用户绑定");
    }

    // 3. 注册用户
    let result: SignUpResult;
    try {
      result = await this.signUp({
        email: input.email,
        password: input.password,
        name: input.name,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`社交注册失败: ${message}`);
    }

    // 4. 绑定社交账户
    try {
      await this._socialService.bindToUser(result.userId, {
        provider: input.social.provider,
        providerOpenid: input.social.providerOpenid,
        accessToken: input.social.accessToken,
        refreshToken: input.social.refreshToken,
        tokenExpiresAt: input.social.tokenExpiresAt,
        profileData: input.social.profileData,
      });
    } catch (err: unknown) {
      // 绑定失败时记录日志（用户已创建，社交账户绑定失败不影响主流程）
      // 使用者可以通过再次调用 social.bindToUser 重试
      console.error(
        `[signUpWithSocial] 社交账户绑定失败 (userId=${result.userId}):`,
        err
      );
      throw new Error(
        `社交账户绑定失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return result;
  }

  // ----------------------------------------------------------
  // 密码管理（重置 & 修改）
  // ----------------------------------------------------------

  async requestPasswordReset(
    provider: string,
    providerOpenid: string,
  ): Promise<void> {
    if (!this._passwordReset) {
      throw new Error("密码重置不可用");
    }
    // 速率限制：3 次/10 分钟
    await checkRateLimit(
      this._passwordResetRateLimit,
      `${provider}:${providerOpenid}`,
      3,
      10 * 60 * 1000,
    );
    await this._passwordReset.requestReset(provider, providerOpenid);
    publishAuditEvent({
      action: "resetPasswordRequest",
      metadata: { provider, providerOpenid },
    });
  }

  async resetPassword(
    provider: string,
    providerOpenid: string,
    code: string,
    newPassword: string,
  ): Promise<void> {
    if (!this._passwordReset) {
      throw new Error("密码重置不可用");
    }
    await this._passwordReset.reset(provider, providerOpenid, code, newPassword);
    publishAuditEvent({ action: "resetPasswordDone" });
  }

  // ----------------------------------------------------------
  // RBAC 权限检查
  // ----------------------------------------------------------

  /** 检查用户是否拥有指定角色（不抛异常） */
  static hasRole(roles: string[], target: string): boolean {
    return hasRole(roles, target);
  }

  /** 检查用户是否拥有任一指定角色（不抛异常） */
  static hasAnyRole(roles: string[], targets: string[]): boolean {
    return hasAnyRole(roles, targets);
  }

  /** 要求用户拥有指定角色，否则抛 UnauthorizedError */
  static requireRole(roles: string[], target: string): void {
    requireRole(roles, target);
  }

  /** 要求用户拥有任一指定角色，否则抛 UnauthorizedError */
  static requireAnyRole(roles: string[], targets: string[]): void {
    requireAnyRole(roles, targets);
  }

  // ----------------------------------------------------------
  // OAuth
  // ----------------------------------------------------------

  registerOAuthProvider(config: OAuthProviderConfig): void {
    registerOAuthProvider(config);
  }

  async handleOAuthCallback(
    provider: string,
    code: string,
    redirectUri: string,
    state?: string,
    codeVerifier?: string,
  ): Promise<OAuthCallbackResult> {
    const { handleOAuthCallback: handler } = await import("./oauth/handler");
    const result = await handler(provider, code, redirectUri, state, codeVerifier);

    // ---- OAuth 新用户创建后触发 onUserCreated 钩子（与 signUp 保持一致）
    if (result.isNewUser) {
      for (const hook of this._afterUserCreateHooks) {
        try {
          await hook({ id: result.userId });
        } catch (e) {
          console.error("[OAuth] onUserCreated hook error:", e);
        }
      }
    }

    return result;
  }

  // ----------------------------------------------------------
  // 渠道验证码
  // ----------------------------------------------------------

  /**
   * 请求渠道验证码（生成种子码）。
   *
   * 返回密码学安全的 6 位种子码；若已注册 sender 则同步投递，
   * 未注册则仅返回码，由调用方自行投递 / 派生 URL。
   */
  async requestChannelCode(
    provider: string,
    providerOpenid: string,
    channelRef?: SocialAccountRef
  ): Promise<string> {
    if (!this._channelVerification) {
      throw new Error("渠道验证码不可用");
    }
    return this._channelVerification.requestCode(provider, providerOpenid, channelRef);
  }

  /**
   * 委托渠道验证验证码。
   *
   * 将用户提交的验证码交给 provider 注册的 verifier 判定，
   * 库无条件透传验证结果。不要求登录态（注册/绑定场景可能未登录），
   * 调用者自行判断业务上下文。
   */
  async verifyChannelCode(
    provider: string,
    providerOpenid: string,
    code: string,
    channelRef?: SocialAccountRef
  ): Promise<boolean> {
    if (!this._channelVerification) {
      throw new Error("渠道验证码不可用");
    }
    return this._channelVerification.verifyCode(provider, providerOpenid, code, channelRef);
  }

  /**
   * 注册指定 provider 的验证码发送器。
   *
   * 第三方在初始化后调用，为 email/phone/wechat 等渠道注册发码实现。
   */
  registerVerificationSender(provider: string, sender: VerificationSender): void {
    registerVerificationSender(provider, sender);
  }

  /**
   * 注册指定 provider 的验证码验证器。
   *
   * 第三方在初始化后调用，为 email/phone/wechat 等渠道注册验证实现。
   * 验证码的状态管理与验证逻辑完全由实现方负责。
   */
  registerVerificationVerifier(provider: string, verifier: VerificationVerifier): void {
    registerVerificationVerifier(provider, verifier);
  }

  // ----------------------------------------------------------
  // 社交账户
  // ----------------------------------------------------------

  get social() {
    return this._socialService;
  }

  // ----------------------------------------------------------
  // 数据库直通（增删改查）
  // ----------------------------------------------------------

  /** 暴露底层 DatabaseAdapter 的 CRUD 能力，无需额外安装数据库依赖 */
  get db() {
    const adapter = this.config.database;
    return {
      findOne: (params: Parameters<DatabaseAdapter["findOne"]>[0]) =>
        adapter.findOne(params),
      findMany: (params: Parameters<DatabaseAdapter["findMany"]>[0]) =>
        adapter.findMany(params),
      create: (params: Parameters<DatabaseAdapter["create"]>[0]) =>
        adapter.create(params),
      updateOne: (params: Parameters<DatabaseAdapter["updateOne"]>[0]) =>
        adapter.updateOne(params),
      updateMany: (params: Parameters<DatabaseAdapter["updateMany"]>[0]) =>
        adapter.updateMany(params),
      deleteOne: (params: Parameters<DatabaseAdapter["deleteOne"]>[0]) =>
        adapter.deleteOne(params),
      deleteMany: (params: Parameters<DatabaseAdapter["deleteMany"]>[0]) =>
        adapter.deleteMany(params),
      count: (params: Parameters<DatabaseAdapter["count"]>[0]) =>
        adapter.count(params),
    };
  }

  // ----------------------------------------------------------
  // Token 刷新
  // ----------------------------------------------------------

  registerTokenRefresher(provider: string, refresher: TokenRefresher): void {
    registerTokenRefresher(provider, refresher);
  }

}

// ----------------------------------------------------------
// 工厂函数
// ----------------------------------------------------------

export function createAuth(config: OmniAuthConfig): OmniAuth {
  return new OmniAuth(config);
}
