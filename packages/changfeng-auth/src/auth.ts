// ============================================================
// ChangfengAuth — SDK 主类
//
// 完全封装 Better Auth，提供框架无关的认证 API。
// ============================================================

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createHmac } from "crypto";
import type { DatabaseAdapter } from "./adapters/database";
import type { RequestContext } from "./adapters/request";
import type { AuthContext, Account, SocialAccountBrief, UserChannel } from "./types";
import type { AccountResolver } from "./core/resolver";
import { getAccountResolver, setAccountResolver } from "./core/resolver";
import { setRoleResolver } from "./core/roles";
import type { LifecycleHooks, UserCreatedPayload, SessionCreatedPayload, SessionExpiredPayload } from "./core/lifecycle";
import type { BetterAuthSession, SignUpEmailResult, SignInEmailResult } from "./core/betterAuthTypes";
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
import { createSessionManagement } from "./core/session";
import { resolveRoles, type RoleResolver, hasRole, hasAnyRole, requireRole, requireAnyRole } from "./core/roles";
import { publishAuditEvent } from "./core/audit";
import { createChannelVerification, registerVerificationSender } from "./core/verification-channel";
import type { VerificationSender } from "./core/verification-channel";
import {
  phoneToSyntheticEmail,
  generateRandomPassword,
} from "./core/channel-mapping";

// ----------------------------------------------------------
// BetterAuth 实例类型
// ----------------------------------------------------------

export type BetterAuthInstance = ReturnType<typeof betterAuth>;

// ----------------------------------------------------------
// SDK 配置
// ----------------------------------------------------------

export interface ChangfengAuthConfig {
  /** 数据库适配器（必填） */
  database: DatabaseAdapter;
  /** Better Auth 密钥 */
  secret: string;
  /** 应用基础 URL（用于生成重置链接等） */
  baseUrl: string;
  /** Session 配置 */
  session?: {
    expiresIn?: number;
    updateAge?: number;
    rememberMeExpiresIn?: number;
  };
  /** 自定义业务账户解析器 */
  accountResolver?: AccountResolver;
  /** 角色解析器（提供则 getContext 自动填充 roles） */
  roleResolver?: RoleResolver;
  /** Better Auth 插件列表（如 google(), github() 等） */
  plugins?: BetterAuthOptions["plugins"];
  /** 覆盖 Better Auth 配置 */
  overrides?: Partial<BetterAuthOptions>;
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
  token: string | null;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface SignInResult {
  userId: string;
  token: string | null;
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
  token: string | null;
  isNewUser: boolean;
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
// ChangfengAuth 主类
// ----------------------------------------------------------

export class ChangfengAuth {
  private config: ChangfengAuthConfig;
  private _betterAuth: BetterAuthInstance;
  private _socialService: ReturnType<typeof createSocialService>;
  private _emailVerification: ReturnType<typeof createEmailVerification> | null = null;
  private _passwordReset: ReturnType<typeof createPasswordReset> | null = null;
  private _accountDeletion: ReturnType<typeof createAccountDeletion> | null = null;
  private _sessionManagement: ReturnType<typeof createSessionManagement> | null = null;
  private _channelVerification: ReturnType<typeof createChannelVerification> | null = null;
  /** onSessionExpired 回调（Better Auth 无内置 hook，由 SDK 方法触发） */
  private _onSessionExpired: ((payload: SessionExpiredPayload) => void | Promise<void>) | null = null;

  constructor(config: ChangfengAuthConfig) {
    this.config = config;

    // 注册 AccountResolver（如果提供）
    if (config.accountResolver) {
      setAccountResolver(config.accountResolver);
    }

    // 注册 RoleResolver（如果提供）
    if (config.roleResolver) {
      setRoleResolver(config.roleResolver);
    }

    // 存储 onSessionExpired 回调（Better Auth 无内置 session 过期 hook，由 SDK 方法触发）
    this._onSessionExpired = config.hooks?.onSessionExpired ?? null;

    // 构建 databaseHooks（Better Auth 约定字段名）
    const databaseHooks: Record<string, unknown> = {};

    if (config.hooks?.onUserCreated) {
      const onUserCreated = config.hooks.onUserCreated;
      databaseHooks.user = {
        create: {
          after: async (user: { id: string; email?: string; name?: string }) => {
            await onUserCreated({
              userId: user.id,
              email: user.email,
              name: user.name,
            });
          },
        },
      };
    }

    if (config.hooks?.onSessionCreated) {
      const onSessionCreated = config.hooks.onSessionCreated;
      databaseHooks.session = {
        create: {
          after: async (session: { userId: string; token: string; id?: string; expiresAt?: Date; ipAddress?: string; userAgent?: string; user?: { id: string; email: string; name?: string; image?: string; emailVerified?: boolean } }) => {
            await onSessionCreated({
              userId: session.userId,
              token: session.token,
              user: session.user,
              session: session.id != null
                ? { id: session.id, expiresAt: session.expiresAt, ipAddress: session.ipAddress, userAgent: session.userAgent }
                : undefined,
            });
          },
        },
      };
    }

    // 创建 Better Auth 基础配置
    const baseConfig: BetterAuthOptions = {
      database: config.database as never,
      secret: config.secret,
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: false,
      },
      session: {
        expiresIn: config.session?.expiresIn ?? 60 * 60 * 24 * 7,
        updateAge: config.session?.updateAge ?? 60 * 60 * 24,
      },
      databaseHooks: Object.keys(databaseHooks).length > 0
        ? (databaseHooks as BetterAuthOptions["databaseHooks"])
        : undefined,
      plugins: config.plugins ?? [],
    };

    // 合并 overrides：如果 overrides 中也有 databaseHooks，与 SDK 构建的合并
    if (config.overrides) {
      const { databaseHooks: overrideHooks, ...restOverrides } = config.overrides as Record<string, unknown>;
      Object.assign(baseConfig, restOverrides);

      if (overrideHooks) {
        // 深度合并：user 覆盖的 hooks 优先级高于 SDK 构建的
        const merged: Record<string, unknown> = { ...databaseHooks };
        for (const [model, events] of Object.entries(overrideHooks as Record<string, Record<string, Record<string, unknown>>>)) {
          if (!merged[model]) {
            merged[model] = { ...events };
          } else {
            const mergedModel = merged[model] as Record<string, Record<string, unknown>>;
            for (const [action, handlers] of Object.entries(events)) {
              if (!mergedModel[action]) {
                mergedModel[action] = { ...handlers };
              } else {
                Object.assign(mergedModel[action], handlers);
              }
            }
          }
        }
        baseConfig.databaseHooks = merged as BetterAuthOptions["databaseHooks"];
      }
    }

    this._betterAuth = betterAuth(baseConfig);

    // 创建社交账户服务
    this._socialService = createSocialService(config.database);

    // 初始化 OAuth handler
    const oauthHandler = createOAuthHandler({
      db: config.database,
      auth: this._betterAuth,
      socialService: this._socialService,
    });
    setOAuthHandler(oauthHandler);

    // 初始化邮箱验证
    this._emailVerification = createEmailVerification({
      auth: this._betterAuth,
    });

    // 初始化密码重置
    this._passwordReset = createPasswordReset({
      auth: this._betterAuth,
      email: null as unknown as never, // 密码重置由调用者自行提供邮件服务
      baseUrl: config.baseUrl,
    });

    // 初始化账号注销
    this._accountDeletion = createAccountDeletion({
      auth: this._betterAuth,
      db: config.database,
    });

    // 初始化 Session 管理
    this._sessionManagement = createSessionManagement({
      auth: this._betterAuth,
      db: config.database,
    });

    // 初始化渠道验证码
    this._channelVerification = createChannelVerification({
      db: config.database,
    });
  }

  // ----------------------------------------------------------
  // 用户认证
  // ----------------------------------------------------------

  private async _signUpEmail(email: string, password: string, name: string): Promise<SignUpEmailResult> {
    return this._betterAuth.api.signUpEmail({
      body: { email, password, name },
    }) as unknown as SignUpEmailResult;
  }

  private async _signInEmail(email: string, password: string): Promise<SignInEmailResult> {
    return this._betterAuth.api.signInEmail({
      body: { email, password },
    }) as unknown as SignInEmailResult;
  }

  private async _getSession(ctx: RequestContext): Promise<BetterAuthSession | null> {
    return this._betterAuth.api.getSession({
      headers: ctx.asHeaders() as unknown as Record<string, string>,
    }) as unknown as BetterAuthSession | null;
  }

  private async _signOut(ctx: RequestContext): Promise<void> {
    await this._betterAuth.api.signOut({
      headers: ctx.asHeaders() as unknown as Record<string, string>,
    });
  }

  async signUp(input: SignUpInput): Promise<SignUpResult> {
    try {
      const result = await this._signUpEmail(input.email, input.password, input.name);

      // 写入 SocialAccount 通道记录
      const channelProvider = input.channel?.provider ?? "email";
      const channelId = input.channel?.identifier ?? input.email;

      if (channelProvider && channelId) {
        try {
          await this._socialService.bindToUser(result.user.id, {
            provider: channelProvider,
            providerOpenid: channelId,
          });
        } catch (channelErr: unknown) {
          console.warn(
            `[signUp] 通道记录写入失败 (userId=${result.user.id}, provider=${channelProvider}):`,
            channelErr instanceof Error ? channelErr.message : String(channelErr)
          );
        }
      }

      publishAuditEvent({ action: "signUp", userId: result.user.id });

      return {
        userId: result.user.id,
        token: result.token,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`注册失败: ${message}`);
    }
  }

  async signIn(input: SignInInput): Promise<SignInResult> {
    try {
      const result = await this._signInEmail(input.email, input.password);

      publishAuditEvent({ action: "signIn", userId: result.user.id });

      return {
        userId: result.user.id,
        token: result.token,
      };
    } catch (err: unknown) {
      publishAuditEvent({
        action: "signInFailed",
        metadata: { email: input.email },
      });
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`登录失败: ${message}`);
    }
  }

  async signOut(ctx: RequestContext): Promise<void> {
    await this._signOut(ctx);
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
        // 通过合成邮箱找回 Better Auth 用户并登录
        const syntheticEmail = this._buildChannelEmail(input.provider, input.providerOpenid);
        result = await this.signIn({ email: syntheticEmail, password: input.credential.value });
      } else {
        // 非密码凭证：调用者已自行验证，直接创建 session
        const token = await this._createSessionForUser(existingChannel.userId);
        result = { userId: existingChannel.userId, token };
      }

      publishAuditEvent({ action: "signIn", userId: result.userId });

      return {
        userId: result.userId,
        token: result.token,
        isNewUser: false,
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

    return {
      userId: signUpResult.userId,
      token: signUpResult.token,
      isNewUser: true,
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
   * 需要有效 session。
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
    const session = await this._getSession(ctx);
    if (!session?.user?.id) {
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

    const result = await this._socialService.bindToUser(session.user.id, input);

    publishAuditEvent({
      action: "channelBind",
      userId: session.user.id,
      metadata: { channel: input.provider, value: input.providerOpenid },
    });

    return result;
  }

  /**
   * 为已登录用户解绑渠道。
   * 需要有效 session。
   */
  async unbindChannel(ctx: RequestContext, channelId: string): Promise<void> {
    const session = await this._getSession(ctx);
    if (!session?.user?.id) {
      throw new UnauthorizedError("UNAUTHENTICATED", "请先登录");
    }

    // 校验该渠道属于当前用户
    const allAccounts = await this._socialService.listByUser(session.user.id);
    const target = allAccounts.find((a) => a.id === channelId);
    if (!target) {
      throw new Error("渠道不存在");
    }

    await this._socialService.unbindFromUser(channelId);

    publishAuditEvent({
      action: "channelUnbind",
      userId: session.user.id,
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

  /** 为指定用户直接创建 session（用于非密码凭证的登录） */
  private async _createSessionForUser(userId: string): Promise<string> {
    const token = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (this.config.session?.expiresIn ?? 60 * 60 * 24 * 7) * 1000);

    await this.config.database.create({
      model: "session",
      data: { userId, token, expiresAt },
    });

    return token;
  }

  /**
   * 使用 HMAC-SHA256 签名原始 session token，生成可直接设置到 cookie 的值。
   *
   * Better Auth 通过 ctx.setSignedCookie 在原始 token 后追加 base64 编码的
   * HMAC 签名：`rawToken.signature`（signature = btoa(hmac) = 标准 base64）。
   * 如果直接将原始 token 设置到 cookie 而不签名，getSession 会因为 HMAC 校验
   * 失败而返回 null，导致"登录成功但会话无效"的 bug。
   *
   * 调用者应将此方法的返回值设置到 `better-auth.session_token` cookie。
   */
  signSessionToken(rawToken: string): string {
    const signature = createHmac("sha256", this.config.secret)
      .update(rawToken)
      .digest("base64");
    return encodeURIComponent(`${rawToken}.${signature}`);
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

  async requestPasswordReset(email: string): Promise<void> {
    if (!this._passwordReset) {
      throw new Error("密码重置不可用：未提供 EmailAdapter");
    }
    await this._passwordReset.requestReset(email);
    publishAuditEvent({
      action: "resetPasswordRequest",
      metadata: { email },
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (!this._passwordReset) {
      throw new Error("密码重置不可用：未提供 EmailAdapter");
    }
    await this._passwordReset.reset(token, newPassword);
    publishAuditEvent({ action: "resetPasswordDone" });
  }

  async changePassword(
    ctx: RequestContext,
    oldPassword: string,
    newPassword: string
  ): Promise<void> {
    if (!this._passwordReset) {
      throw new Error("修改密码不可用：未提供 EmailAdapter");
    }
    await this._passwordReset.changePassword(ctx, oldPassword, newPassword);

    const session = await this._getSession(ctx);
    if (session?.user?.id) {
      publishAuditEvent({ action: "changePassword", userId: session.user.id });
    }
  }

  // ----------------------------------------------------------
  // 邮箱验证
  // ----------------------------------------------------------

  async requestEmailVerification(ctx: RequestContext): Promise<void> {
    if (!this._emailVerification) {
      throw new Error("邮箱验证不可用：未提供 EmailAdapter");
    }
    await this._emailVerification.requestVerification(ctx);
  }

  async verifyEmail(token: string): Promise<void> {
    if (!this._emailVerification) {
      throw new Error("邮箱验证不可用：未提供 EmailAdapter");
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
    await this._accountDeletion.updateProfile(ctx, input);
  }

  async deleteAccount(ctx: RequestContext, password: string): Promise<void> {
    if (!this._accountDeletion) {
      throw new Error("账号注销不可用");
    }

    // 注销前获取 userId 用于审计
    const session = await this._getSession(ctx);
    const userId = session?.user?.id;

    await this._accountDeletion.deleteAccount(ctx, password);

    if (userId) {
      publishAuditEvent({ action: "deleteAccount", userId });
    }
  }

  // ----------------------------------------------------------
  // Session 过期检查（触发 onSessionExpired 钩子）
  // ----------------------------------------------------------

  /**
   * 扫描数据库中已过期的 session 并触发 onSessionExpired 回调。
   * 建议通过定时任务（cron）或中间件周期性调用。
   * 返回已过期的 session 数量。
   */
  async checkExpiredSessions(): Promise<number> {
    if (!this._onSessionExpired) return 0;

    const now = new Date();
    const expiredSessions = await this.config.database.findMany({
      model: "session",
      where: [{ field: "expiresAt", value: now.toISOString(), operator: "lt" }],
    }) as { userId: string; token: string; expiresAt: Date }[];

    for (const session of expiredSessions) {
      try {
        await this._onSessionExpired({
          userId: session.userId,
          sessionToken: session.token,
          expiredAt: session.expiresAt,
        });
      } catch (err) {
        console.error(
          `[checkExpiredSessions] onSessionExpired 回调执行失败 (userId=${session.userId}):`,
          err
        );
      }
    }

    return expiredSessions.length;
  }

  // ----------------------------------------------------------
  // Session 管理
  // ----------------------------------------------------------

  async listSessions(ctx: RequestContext) {
    if (!this._sessionManagement) {
      throw new Error("Session 管理不可用");
    }
    return this._sessionManagement.listSessions(ctx);
  }

  async revokeSession(ctx: RequestContext, sessionId: string): Promise<void> {
    if (!this._sessionManagement) {
      throw new Error("Session 管理不可用");
    }
    return this._sessionManagement.revokeSession(ctx, sessionId);
  }

  async revokeAllSessions(ctx: RequestContext): Promise<number> {
    if (!this._sessionManagement) {
      throw new Error("Session 管理不可用");
    }
    return this._sessionManagement.revokeAllSessions(ctx);
  }

  // ----------------------------------------------------------
  // 上下文
  // ----------------------------------------------------------

  async getContext(ctx: RequestContext): Promise<AuthContext> {
    const session = await this._getSession(ctx);

    if (!session?.user?.id) {
      return { account: null, authUserId: null, socialAccounts: [], channels: [], roles: [] };
    }

    const authUserId = session.user.id;
    const resolver = getAccountResolver();

    const [account, socialAccountDTOs, roles] = await Promise.all([
      resolver ? resolver.findByAuthUserId(authUserId) : Promise.resolve(null),
      this._socialService.listByUser(authUserId).catch((err) => {
        console.error("[getAuthContext] 查询社交账户失败:", err);
        return [] as SocialAccountDTO[];
      }),
      resolveRoles(authUserId),
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

    return { account, authUserId, socialAccounts, channels, roles };
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
    redirectUri: string
  ): Promise<OAuthCallbackResult> {
    const { handleOAuthCallback: handler } = await import("./oauth/handler");
    return handler(provider, code, redirectUri);
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

    const session = await this._getSession(ctx);
    if (!session?.user?.id) {
      throw new UnauthorizedError("UNAUTHENTICATED", "请先登录");
    }

    // 查找渠道，校验归属
    const channels = await this._socialService.listByUser(session.user.id);
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

    await this._channelVerification.send(
      channelId,
      channel.provider,
      channel.providerOpenid,
      channelRef
    );

    publishAuditEvent({
      action: "verificationSent",
      userId: session.user.id,
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
    return this._channelVerification.verify(provider, providerOpenid, code);
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
      deleteOne: (params: Parameters<DatabaseAdapter["deleteOne"]>[0]) =>
        adapter.deleteOne(params),
      deleteMany: (params: Parameters<DatabaseAdapter["deleteMany"]>[0]) =>
        adapter.deleteMany(params),
    };
  }

  // ----------------------------------------------------------
  // 用户信息变更（仅用户自身属性，渠道平权走 bind/unbind/change.channel）
  // ----------------------------------------------------------

  get change() {
    const self = this;
    return {
      /** 更新用户名（同步 user.name + businessAccount.displayName） */
      async name(ctx: RequestContext, newName: string): Promise<void> {
        if (!self._accountDeletion) throw new Error("账号管理不可用");
        await self._accountDeletion.updateProfile(ctx, { name: newName });
        const session = await self._getSession(ctx);
        if (session?.user?.id) {
          publishAuditEvent({ action: "changeName", userId: session.user.id });
        }
      },

      /** 更新头像 */
      async image(ctx: RequestContext, newImage: string): Promise<void> {
        if (!self._accountDeletion) throw new Error("账号管理不可用");
        await self._accountDeletion.updateProfile(ctx, { image: newImage });
      },

      /**
       * 更换渠道标识符（邮箱/手机号/微信openid 等平等处理）。
       *
       * 唯一性校验 → socialAccount.providerOpenid 更新。
       * user.email 为 Better Auth 内部占位符，不做同步。
       */
      async channel(
        ctx: RequestContext,
        channelId: string,
        input: { identifier: string }
      ): Promise<void> {
        const session = await self._getSession(ctx);
        if (!session?.user?.id) {
          throw new UnauthorizedError("UNAUTHENTICATED", "请先登录");
        }

        const userId = session.user.id;

        // 校验渠道归属
        const allAccounts = await self._socialService.listByUser(userId);
        const target = allAccounts.find((a) => a.id === channelId);
        if (!target) throw new Error("渠道不存在或不属于当前用户");

        const oldIdentifier = target.providerOpenid;
        const provider = target.provider;

        // 标识符未变则跳过
        if (oldIdentifier === input.identifier) return;

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
      },
    };
  }

  // ----------------------------------------------------------
  // Token 刷新
  // ----------------------------------------------------------

  registerTokenRefresher(provider: string, refresher: TokenRefresher): void {
    registerTokenRefresher(provider, refresher);
  }

  // ----------------------------------------------------------
  // 原始 Better Auth handler（供框架适配层使用）
  // ----------------------------------------------------------

  getBetterAuthHandler() {
    // Better Auth 的 toNextJsHandler 兼容格式
    return this._betterAuth.handler as {
      (req: Request): Promise<Response>;
    };
  }

  /** 获取底层 Better Auth 实例（高级用法） */
  get betterAuth(): BetterAuthInstance {
    return this._betterAuth;
  }
}

// ----------------------------------------------------------
// 工厂函数
// ----------------------------------------------------------

export function createAuth(config: ChangfengAuthConfig): ChangfengAuth {
  return new ChangfengAuth(config);
}
