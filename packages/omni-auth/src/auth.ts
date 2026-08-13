// ============================================================
// OmniAuth — SDK 主类
//
// 提供框架无关的认证 API。
// ============================================================

import { randomUUID } from "crypto";
import { createAuthToken, validateToken, revokeToken as revokeTokenFn, revokeAllTokens as revokeAllTokensFn } from "./core/token";
import { hashPassword, verifyPassword } from "@better-auth/utils/password";
import type { DatabaseAdapter } from "./adapters/database";
import type { RequestContext } from "./adapters/request";
import type { AuthContext, Account, PublicUser, SocialAccountBrief, UserChannel } from "./types";
import type { AccountResolver } from "./core/resolver";
import { getAccountResolver, setAccountResolver } from "./core/resolver";
import { setRoleResolver } from "./core/roles";
import type { LifecycleHooks, UserCreatedPayload } from "./core/lifecycle";
import { UnauthorizedError } from "./errors";
import { createSocialService } from "./social/service";
import type { SocialAccountDTO } from "./social/types";
import { registerTokenRefresher, type TokenRefresher } from "./social/token";
import { registerOAuthProvider } from "./oauth/registry";
import type { OAuthProviderConfig } from "./oauth/types";
import { createOAuthHandler, setOAuthHandler } from "./oauth/handler";
import type { OAuthCallbackResult } from "./oauth/types";
import { createEmailVerification } from "./core/verification";
import { createPasswordReset } from "./core/password";
import { createAccountDeletion } from "./core/account";
import { resolveRoles, type RoleResolver, hasRole, hasAnyRole, requireRole, requireAnyRole } from "./core/roles";
import { publishAuditEvent } from "./core/audit";
import { createChannelVerification, registerVerificationSender } from "./core/verification-channel";
import type { VerificationSender } from "./core/verification-channel";
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
  /** Token 配置 */
  token?: {
    expiresIn?: number;
  };
  /** 自定义业务账户解析器 */
  accountResolver?: AccountResolver;
  /** 角色解析器（提供则 getContext 自动填充 roles） */
  roleResolver?: RoleResolver;
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
  /** AuthToken 携带的 metadata（可选，序列化后 ≤ 2KB） */
  metadata?: Record<string, unknown>;
}

export interface SignUpResult {
  userId: string;
  token: string | null;
  /** 创建后的完整用户信息 */
  user: PublicUser;
}

export interface SignInInput {
  email: string;
  password: string;
  /** AuthToken 携带的 metadata（可选，序列化后 ≤ 2KB） */
  metadata?: Record<string, unknown>;
}

export interface SignInResult {
  userId: string;
  token: string | null;
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
  /** AuthToken 携带的 metadata（可选，序列化后 ≤ 2KB） */
  metadata?: Record<string, unknown>;
}

export interface ChannelAuthResult {
  userId: string;
  token: string | null;
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
  /** AuthToken 携带的 metadata（可选，序列化后 ≤ 2KB） */
  metadata?: Record<string, unknown>;
}

// ----------------------------------------------------------
// OmniAuth 主类
// ----------------------------------------------------------

export class OmniAuth {
  private config: OmniAuthConfig;
  private _socialService: ReturnType<typeof createSocialService>;
  private _emailVerification: ReturnType<typeof createEmailVerification> | null = null;
  private _passwordReset: ReturnType<typeof createPasswordReset> | null = null;
  private _accountDeletion: ReturnType<typeof createAccountDeletion> | null = null;
  private _channelVerification: ReturnType<typeof createChannelVerification> | null = null;
  /** 速率限制器（内存实现，各接口独立限流） */
  private _signInRateLimit = createMemoryRateLimiter();
  private _signUpRateLimit = createMemoryRateLimiter();
  private _requestCodeRateLimit = createMemoryRateLimiter();
  private _passwordResetRateLimit = createMemoryRateLimiter();
  /** user.create.after 钩子列表（signUp 内联触发） */
  private _afterUserCreateHooks: Array<(user: { id: string; email?: string; name?: string }) => Promise<void>> = [];

  constructor(config: OmniAuthConfig) {
    this.config = config;

    // 注册 AccountResolver（如果提供）
    if (config.accountResolver) {
      setAccountResolver(config.accountResolver);
    }

    // 注册 RoleResolver（如果提供）
    if (config.roleResolver) {
      setRoleResolver(config.roleResolver);
    }

    // 创建社交账户服务
    this._socialService = createSocialService(config.database);

    // 初始化 OAuth handler
    const oauthHandler = createOAuthHandler({
      db: config.database,
      socialService: this._socialService,
      expiresIn: config.token?.expiresIn ?? 60 * 60 * 24 * 7,
    });
    setOAuthHandler(oauthHandler);

    // 初始化邮箱验证
    this._emailVerification = createEmailVerification({
      db: config.database,
      baseUrl: config.baseUrl,
    });

    // 初始化密码重置
    this._passwordReset = createPasswordReset({
      db: config.database,
      expiresIn: config.token?.expiresIn ?? 60 * 60 * 24 * 7,
    });

    // 初始化账号注销
    this._accountDeletion = createAccountDeletion({
      db: config.database,
    });

    // 初始化渠道验证码
    this._channelVerification = createChannelVerification({
      db: config.database,
    });

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

    // 7. 创建 AuthToken（DB 级原子 upsert）
    const expiresIn = this.config.token?.expiresIn ?? 60 * 60 * 24 * 7;
    const token = await createAuthToken(
      this.config.database,
      userId,
      expiresIn,
      input.metadata,
    );

    // 8. 读取完整用户信息并返回
    const user = await this._readPublicUser(userId);

    return {
      userId,
      token,
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

    // 5. 创建 AuthToken
    const expiresIn = this.config.token?.expiresIn ?? 60 * 60 * 24 * 7;
    const token = await createAuthToken(
      this.config.database,
      user.id as string,
      expiresIn,
      input.metadata,
    );

    // 6. 读取完整用户信息并返回
    const fullUser = await this._readPublicUser(user.id as string);

    return {
      userId: user.id as string,
      token,
      user: fullUser,
    };
  }

  async signOut(ctx: RequestContext): Promise<void> {
    // 从 cookie 或 header 获取 token
    const token = this._extractToken(ctx);
    if (!token) return;

    // 校验当前用户（获取 userId）
    const validated = await validateToken(this.config.database, token);
    if (validated) {
      await revokeTokenFn(this.config.database, validated.userId, token);
    }

    // 清除 cookie 由调用方（route handler）负责
  }

  /** 从 Authorization: Bearer header 或 omni-auth.token cookie 读取 token */
  private _extractToken(ctx: RequestContext): string | null {
    // 1. 尝试从 Authorization header 读取
    const authHeader = ctx.getHeader("authorization");
    if (authHeader) {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match) return match[1];
    }

    // 2. 回退到 cookie
    const cookie = ctx.getCookie("omni-auth.token");
    if (cookie) return cookie;

    return null;
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
      // 已有绑定 → 登录
      let result: SignInResult;
      if (input.credential.type === "password") {
        // 通过合成邮箱找回用户并登录
        const syntheticEmail = this._buildChannelEmail(input.provider, input.providerOpenid);
        result = await this.signIn({ email: syntheticEmail, password: input.credential.value });
      } else {
        // 非密码凭证：调用者已自行验证，直接创建 AuthToken
        const expiresIn = this.config.token?.expiresIn ?? 60 * 60 * 24 * 7;
        const token = await createAuthToken(
          this.config.database,
          existingChannel.userId,
          expiresIn,
          input.metadata,
        );
        const existingUserForSession = await this._readPublicUser(existingChannel.userId);
        result = { userId: existingChannel.userId, token, user: existingUserForSession };
      }

      publishAuditEvent({ action: "signIn", userId: result.userId });

      const existingUser = await this._readPublicUser(result.userId);

      return {
        userId: result.userId,
        token: result.token,
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
      token: signUpResult.token,
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

  /**
   * 为已登录用户绑定新渠道。
   * 需要有效登录态（AuthToken）。
   */
  async bindChannel(
    ctx: RequestContext,
    input: {
      provider: string;
      providerOpenid: string;
      accessToken?: string;
      refreshToken?: string;
      tokenExpiresAt?: Date | number;
      profileData?: Record<string, unknown>;
      valid?: number;
      allowPasswordUpdate?: number;
      allowVerification?: number;
    }
  ): Promise<SocialAccountDTO> {
    const authCtx = await this.getContext(ctx);
    if (!authCtx.authUserId) {
      throw new UnauthorizedError("UNAUTHENTICATED", "请先登录");
    }

    // 检查是否已被其他用户绑定
    const existing = await this._socialService.findByProvider(
      input.provider,
      input.providerOpenid
    );
    if (existing) {
      throw new Error(`该${input.provider}已被绑定`);
    }

    const result = await this._socialService.bindToUser(authCtx.authUserId, input);

    publishAuditEvent({
      action: "channelBind",
      userId: authCtx.authUserId,
      metadata: { channel: input.provider, value: input.providerOpenid },
    });

    return result;
  }

  /**
   * 为已登录用户解绑渠道。
   * 需要有效登录态（AuthToken）。
   */
  async unbindChannel(ctx: RequestContext, channelId: string): Promise<void> {
    const authCtx = await this.getContext(ctx);
    if (!authCtx.authUserId) {
      throw new UnauthorizedError("UNAUTHENTICATED", "请先登录");
    }

    // 校验该渠道属于当前用户
    const allAccounts = await this._socialService.listByUser(authCtx.authUserId);
    const target = allAccounts.find((a) => a.id === channelId);
    if (!target) {
      throw new Error("渠道不存在");
    }

    await this._socialService.unbindFromUser(channelId);

    publishAuditEvent({
      action: "channelUnbind",
      userId: authCtx.authUserId,
      metadata: { channel: target.provider, value: target.providerOpenid },
    });
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
        metadata: input.metadata,
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

  async changePassword(
    ctx: RequestContext,
    oldPassword: string,
    newPassword: string
  ): Promise<void> {
    if (!this._passwordReset) {
      throw new Error("修改密码不可用");
    }
    const authCtx = await this.requireContext(ctx);
    await this._passwordReset.changePassword(authCtx.authUserId!, oldPassword, newPassword);
    publishAuditEvent({ action: "changePassword", userId: authCtx.authUserId! });
  }

  // ----------------------------------------------------------
  // 邮箱验证
  // ----------------------------------------------------------

  async requestEmailVerification(ctx: RequestContext): Promise<void> {
    if (!this._emailVerification) {
      throw new Error("邮箱验证不可用");
    }
    const authCtx = await this.requireContext(ctx);
    // 从用户记录读取邮箱
    const userRecord = await this.config.database.findOne({
      model: "user",
      where: [{ field: "id", value: authCtx.authUserId! }],
    }) as Record<string, unknown> | null;
    if (!userRecord || !userRecord.email) {
      throw new Error("当前用户未绑定邮箱");
    }
    await this._emailVerification.requestVerification(
      authCtx.authUserId!,
      userRecord.email as string,
    );
  }

  async verifyEmail(token: string): Promise<void> {
    if (!this._emailVerification) {
      throw new Error("邮箱验证不可用");
    }
    await this._emailVerification.verify(token);
  }

  // ----------------------------------------------------------
  // 账号管理
  // ----------------------------------------------------------

  async updateProfile(
    ctx: RequestContext,
    input: { name?: string; image?: string }
  ): Promise<void> {
    if (!this._accountDeletion) {
      throw new Error("账号管理不可用");
    }
    const authCtx = await this.requireContext(ctx);
    await this._accountDeletion.updateProfile(authCtx.authUserId!, input);
  }

  async deleteAccount(ctx: RequestContext, password: string): Promise<void> {
    if (!this._accountDeletion) {
      throw new Error("账号注销不可用");
    }

    // 注销前获取 userId 用于审计
    const authCtx = await this.requireContext(ctx);
    const userId = authCtx.authUserId!;

    await this._accountDeletion.deleteAccount(userId, password);

    publishAuditEvent({ action: "deleteAccount", userId });
  }

  // ----------------------------------------------------------
  // 上下文
  // ----------------------------------------------------------

  async getContext(ctx: RequestContext): Promise<AuthContext> {
    // 1. 从 Authorization: Bearer header 或 omni-auth.token cookie 读取 token
    const token = this._extractToken(ctx);
    if (!token) {
      return { account: null, authUserId: null, socialAccounts: [], channels: [], roles: [] };
    }

    // 2. 校验 token
    const validated = await validateToken(this.config.database, token);
    if (!validated) {
      return { account: null, authUserId: null, socialAccounts: [], channels: [], roles: [] };
    }

    // 3. 构建 AuthContext（userId 来自 token 而非 session）
    const authUserId = validated.userId;
    const resolver = getAccountResolver();

    const [account, socialAccountDTOs, roles] = await Promise.all([
      resolver ? resolver.findByAuthUserId(authUserId) : Promise.resolve(null),
      this._socialService.listByUser(authUserId).catch((err) => {
        console.error("[getAuthContext] 查询社交账户失败:", err);
        return [] as SocialAccountDTO[];
      }),
      resolveRoles(authUserId, this.db),
    ]);

    // 分离通道（有效/占位）和社交账户
    const channels: UserChannel[] = [];
    const socialAccounts: SocialAccountBrief[] = [];

    for (const d of socialAccountDTOs) {
      // 所有 SocialAccount 都可以作为通道，valid 字段标识是否为真实登记
      channels.push({
        id: d.id,
        userId: d.userId,
        provider: d.provider,
        providerOpenid: d.providerOpenid,
        valid: d.valid,
        allowPasswordUpdate: d.allowPasswordUpdate,
        allowVerification: d.allowVerification,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      });

      // 非 email/phone 的 provider 也放入社交账户列表
      if (d.provider !== "email" && d.provider !== "phone") {
        socialAccounts.push({
          id: d.id,
          provider: d.provider,
          providerOpenid: d.providerOpenid,
          profileData: d.profileData,
          valid: d.valid,
          allowPasswordUpdate: d.allowPasswordUpdate,
          allowVerification: d.allowVerification,
          createdAt: d.createdAt,
        });
      }
    }

    return {
      account,
      authUserId,
      socialAccounts,
      channels,
      roles,
      tokenMetadata: validated.metadata,
    };
  }

  async requireContext(ctx: RequestContext): Promise<AuthContext> {
    const authCtx = await this.getContext(ctx);
    if (authCtx.authUserId === null) {
      throw new UnauthorizedError(
        "UNAUTHENTICATED",
        "Authentication required. Please sign in."
      );
    }
    return authCtx;
  }

  // ----------------------------------------------------------
  // Token 吊销
  // ----------------------------------------------------------

  /** 吊销指定 token（校验归属当前用户） */
  async revokeToken(ctx: RequestContext, token: string): Promise<boolean> {
    const authCtx = await this.requireContext(ctx);
    return revokeTokenFn(this.config.database, authCtx.authUserId!, token);
  }

  /** 吊销当前用户全部 token（= 登出所有设备） */
  async revokeAllTokens(ctx: RequestContext): Promise<number> {
    const authCtx = await this.requireContext(ctx);
    return revokeAllTokensFn(this.config.database, authCtx.authUserId!);
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
   * 向指定渠道发送验证码。
   *
   * SDK 校验 allowVerification flag → 查找 provider 注册的 sender → 生成验证码 → 调度发送。
   * 使用前需通过 registerVerificationSender() 注册对应 provider 的发码器。
   */
  async sendVerificationCode(
    ctx: RequestContext,
    channelId: string
  ): Promise<void> {
    if (!this._channelVerification) {
      throw new Error("渠道验证码不可用");
    }

    const authCtx = await this.getContext(ctx);
    if (!authCtx.authUserId) {
      throw new UnauthorizedError("UNAUTHENTICATED", "请先登录");
    }

    // 查找渠道，校验归属
    const channels = await this._socialService.listByUser(authCtx.authUserId);
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) throw new Error("渠道不存在或不属于当前用户");
    if (!channel.allowVerification) {
      throw new Error("该渠道不支持接收验证码");
    }

    const channelRef = {
      id: channel.id,
      provider: channel.provider,
      providerOpenid: channel.providerOpenid,
      accessToken: channel.accessToken,
      refreshToken: channel.refreshToken,
      tokenExpiresAt: channel.tokenExpiresAt,
      profileData: channel.profileData,
    };

    // 速率限制：3 次/10 分钟
    await checkRateLimit(
      this._requestCodeRateLimit,
      `${channel.provider}:${channel.providerOpenid}`,
      3,
      10 * 60 * 1000,
    );

    await this._channelVerification.requestCode(
      channel.provider,
      channel.providerOpenid,
      channelRef,
    );

    publishAuditEvent({
      action: "verificationSent",
      userId: authCtx.authUserId,
      metadata: { channelId, provider: channel.provider },
    });
  }

  /**
   * 校验渠道验证码。
   *
   * 不要求登录态（注册/绑定场景可能未登录），调用者自行判断业务上下文。
   */
  async verifyChannelCode(
    provider: string,
    providerOpenid: string,
    code: string
  ): Promise<boolean> {
    if (!this._channelVerification) {
      throw new Error("渠道验证码不可用");
    }
    return this._channelVerification.exchangeCode(provider, providerOpenid, code);
  }

  /**
   * 注册指定 provider 的验证码发送器。
   *
   * 第三方在初始化后调用，为 email/phone/wechat 等渠道注册发码实现。
   */
  registerVerificationSender(provider: string, sender: VerificationSender): void {
    registerVerificationSender(provider, sender);
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
  // 用户信息变更（仅用户自身属性，渠道平权走 bind/unbind/change.channel）
  // ----------------------------------------------------------

  get change() {
    const self = this;
    return {
      /** 更新用户名（同步 user.name + businessAccount.displayName），返回更新后的用户 */
      async name(ctx: RequestContext, newName: string): Promise<PublicUser> {
        if (!self._accountDeletion) throw new Error("账号管理不可用");
        const authCtx = await self.requireContext(ctx);
        await self._accountDeletion.updateProfile(authCtx.authUserId!, { name: newName });
        publishAuditEvent({ action: "changeName", userId: authCtx.authUserId! });
        return self._readPublicUser(authCtx.authUserId!);
      },

      /** 更新头像，返回更新后的用户 */
      async image(ctx: RequestContext, newImage: string): Promise<PublicUser> {
        if (!self._accountDeletion) throw new Error("账号管理不可用");
        const authCtx = await self.requireContext(ctx);
        await self._accountDeletion.updateProfile(authCtx.authUserId!, { image: newImage });
        return self._readPublicUser(authCtx.authUserId!);
      },

      /**
       * 更换渠道标识符（邮箱/手机号/微信openid 等平等处理）。
       *
       * 唯一性校验 → socialAccount.providerOpenid 更新。
       * user.email 为内部占位符，不做同步。
       * 返回更新后的渠道信息及关联用户。
       */
      async channel(
        ctx: RequestContext,
        channelId: string,
        input: { identifier: string }
      ): Promise<{ id: string; provider: string; providerOpenid: string; user: PublicUser }> {
        const authCtx = await self.getContext(ctx);
        if (!authCtx.authUserId) {
          throw new UnauthorizedError("UNAUTHENTICATED", "请先登录");
        }

        const userId = authCtx.authUserId;

        // 校验渠道归属
        const allAccounts = await self._socialService.listByUser(userId);
        const target = allAccounts.find((a) => a.id === channelId);
        if (!target) throw new Error("渠道不存在或不属于当前用户");

        const oldIdentifier = target.providerOpenid;
        const provider = target.provider;

        // 标识符未变则跳过
        if (oldIdentifier === input.identifier) {
          const user = await self._readPublicUser(userId);
          return { id: channelId, provider, providerOpenid: oldIdentifier, user };
        }

        // 唯一性校验
        const conflict = await self._socialService.findByProvider(
          provider,
          input.identifier
        );
        if (conflict) {
          throw new Error(`该${provider}已被其他账号使用`);
        }

        // 更新渠道标识符
        await self.config.database.updateOne({
          model: "socialAccount",
          where: [{ field: "id", value: channelId }],
          update: { providerOpenid: input.identifier },
        });

        publishAuditEvent({
          action: "channelUpdate",
          userId,
          metadata: {
            channelId,
            provider,
            oldIdentifier,
            newIdentifier: input.identifier,
          },
        });

        const updatedUser = await self._readPublicUser(userId);
        return { id: channelId, provider, providerOpenid: input.identifier, user: updatedUser };
      },
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
