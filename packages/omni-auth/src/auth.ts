// ============================================================
// OmniAuth — SDK 主类
//
// 提供框架无关的认证 API。
//
// 3.0.0 起：
// - 多表写入（注册/社交注册/OAuth 新用户）包入事务（适配器支持时）；
// - OAuth provider / 验证码 sender/verifier / token refresher /
//   审计处理器均为实例级注册表（OmniRegistry），多实例互不干扰；
// - SDK 不再写入 app 业务表（businessAccount），由 hooks 自行处理；
// - 限流键引入客户端 IP，支持注入外部限流器（如 Redis）。
// ============================================================

import { randomUUID } from "crypto";
import { hashPassword, verifyPassword } from "@better-auth/utils/password";
import type { DatabaseAdapter } from "./adapters/database";
import { withTransaction } from "./adapters/database";
import type { RequestContext } from "./adapters/request";
import { getClientIp } from "./adapters/request";
import type { PublicUser } from "./types";
import type { LifecycleHooks } from "./core/lifecycle";
import { createSocialService } from "./social/service";
import type { TokenRefresher, SocialAccountRef } from "./social/token";
import type { OAuthProviderConfig } from "./oauth/types";
import { createOAuthHandler, type OAuthHandler, type OAuthCallbackOptions } from "./oauth/handler";
import type { OAuthCallbackResult } from "./oauth/types";
import { createPasswordReset } from "./core/password";
import { hasRole, hasAnyRole, requireRole, requireAnyRole } from "./core/roles";
import { dispatchAuditEvent, type AuditEvent, type AuditHandler } from "./core/audit";
import { createChannelVerification } from "./core/verification-channel";
import type { VerificationSender, VerificationVerifier } from "./core/verification-channel";
import { createDbFacade, type DbFacade } from "./models";
import { createSessionService, type SessionService } from "./core/session";
import { createUserAdmin, type UserAdminService } from "./core/user-admin";
import {
  createOAuthServer,
  type OAuthServerService,
  type TokenAuthorityClient,
} from "./oauth/server";
import { createScimUserHandler, type ScimUserHandler } from "./scim/handler";
import {
  createMemoryRateLimiter,
  checkRateLimit,
  type RateLimiter,
} from "./core/rateLimit";
import {
  OmniAuthError,
  InvalidPasswordError,
  UserExistsError,
  CredentialInvalidError,
  SocialAccountConflictError,
  UniqueViolationError,
  WeakPasswordError,
} from "./errors";
import { createRegistry, type OmniRegistry } from "./registry";

// ----------------------------------------------------------
// SDK 配置
// ----------------------------------------------------------

/** 限流策略配置 */
export interface OmniAuthRateLimitConfig {
  /** 速率限制器实例（不提供则使用进程内存实现，多实例部署请注入 Redis 等共享实现） */
  limiter?: RateLimiter;
  /**
   * 客户端 IP 解析函数（4.1.0）。
   *
   * 默认使用 getClientIp（x-forwarded-for 首段 → x-real-ip）。
   * 可信代理部署请注入自定义实现（如从右侧数 N 跳），
   * 防止攻击者伪造请求头绕过基于 IP 的限流。
   */
  getClientIp?: (ctx?: RequestContext | null) => string;
  /** 登录：默认 5 次 / 15 分钟（键 = ip:email，成功后重置计数） */
  signIn?: { maxAttempts: number; windowMs: number };
  /** 注册：默认 3 次 / 1 小时（键 = ip，防按邮箱锁死注册） */
  signUp?: { maxAttempts: number; windowMs: number };
  /** 密码重置：默认 3 次 / 10 分钟 */
  passwordReset?: { maxAttempts: number; windowMs: number };
  /**
   * 验证码验证尝试限流（4.1.0，默认关闭，opt-in）。
   *
   * 配置后 verifyChannelCode 按 `provider:providerOpenid` 限流，
   * 防短验证码爆破；验证成功时重置计数。
   * 建议：{ maxAttempts: 5, windowMs: 10 * 60 * 1000 }
   */
  verifyCode?: { maxAttempts: number; windowMs: number };
}

/** 密码策略 */
export interface OmniAuthPasswordPolicy {
  /** 密码最小长度（默认 8） */
  minLength?: number;
}

export interface OmniAuthConfig {
  /** 数据库适配器（必填） */
  database: DatabaseAdapter;
  /**
   * 令牌权威服务客户端（可选）。
   * 提供后 auth.oauthServer 的 access token 签发/校验/吊销能力可用
   * （委托外部证书服务，如集群的 yunzone_auth）。
   */
  tokenAuthority?: TokenAuthorityClient;
  /** 密钥（可选）。 */
  secret?: string;
  /** 应用基础 URL（CSRF 同源校验等使用） */
  baseUrl: string;
  /** 生命周期钩子 */
  hooks?: LifecycleHooks;
  /** 审计事件处理器（实例级） */
  audit?: AuditHandler;
  /** 速率限制配置 */
  rateLimit?: OmniAuthRateLimitConfig;
  /** 密码策略 */
  passwordPolicy?: OmniAuthPasswordPolicy;
}

// ----------------------------------------------------------
// 用户管理 API 的输入/输出类型
// ----------------------------------------------------------

export interface SignUpInput {
  /** 邮箱地址（email 渠道标识符） */
  email: string;
  password: string;
  name: string;
  /**
   * email 渠道的通道数据（可选）。
   *
   * signUp 固定创建 email 渠道（provider="email", providerOpenid=邮箱地址）；
   * channel 提供该渠道的 token / 资料 / 能力标记，与 user 同事务原子写入。
   * 其他渠道注册请使用 authenticateChannel（全渠道平权）。
   */
  channel?: {
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: Date | number;
    profileData?: Record<string, unknown>;
    valid?: number;
    allowPasswordUpdate?: number;
    allowVerification?: number;
  };
}

export interface SignUpResult {
  userId: string;
  /** 创建后的完整用户信息 */
  user: PublicUser;
}

export interface SignInInput {
  /** 邮箱地址（email 渠道标识符） */
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
    /**
     * 非密码凭证契约：调用方必须已完成验证并显式声明 verified=true。
     *
     * type !== "password" 且 verified !== true 时抛 CredentialInvalidError。
     * 库不代为验证 smsCode / oauthCode 等凭证，验证责任在调用方。
     */
    verified?: boolean;
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

// ----------------------------------------------------------
// 限流默认策略
// ----------------------------------------------------------

const DEFAULT_SIGN_IN_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000 };
const DEFAULT_SIGN_UP_LIMIT = { maxAttempts: 3, windowMs: 60 * 60 * 1000 };
const DEFAULT_RESET_LIMIT = { maxAttempts: 3, windowMs: 10 * 60 * 1000 };

/** 未注入 TokenAuthorityClient 时的占位实现（access token 能力不可用时给出明确错误） */
function missingTokenAuthority(): TokenAuthorityClient {
  const err = () => {
    throw new OmniAuthError(
      "TOKEN_AUTHORITY_NOT_CONFIGURED",
      "未注入 TokenAuthorityClient：auth.oauthServer 的 access token 签发/校验能力不可用。" +
        "请在 createQuickAuth({ tokenAuthority }) 或 createAuth({ tokenAuthority }) 中注入。"
    );
  };
  return {
    issueCertificate: err,
    introspectCertificate: err,
    refreshCertificate: err,
    revokeCertificate: err,
    getDefaultProductId: () => {
      throw new OmniAuthError(
        "TOKEN_AUTHORITY_NOT_CONFIGURED",
        "未注入 TokenAuthorityClient：无法获取默认产品标识。"
      );
    },
  };
}

// ----------------------------------------------------------
// OmniAuth 主类
// ----------------------------------------------------------

export class OmniAuth {
  private config: OmniAuthConfig;
  /** 实例级注册表（OAuth provider / sender / verifier / refresher / audit） */
  private _registry: OmniRegistry;
  private _socialService: ReturnType<typeof createSocialService>;
  private _oauthHandler: OAuthHandler;
  private _passwordReset: ReturnType<typeof createPasswordReset>;
  private _channelVerification: ReturnType<typeof createChannelVerification>;
  /** 类型化数据访问门面（惰性缓存） */
  private _dbFacade: DbFacade | null = null;
  /** 会话服务（认证域私有表 session） */
  private _sessions: SessionService;
  /** OAuth Server 服务（oauth_token / oauth_client 私有表） */
  private _oauthServer: OAuthServerService;
  /** 用户管理服务 */
  private _userAdmin: UserAdminService;
  /** SCIM 用户目录 handler */
  private _scim: ScimUserHandler;
  /** 速率限制器（默认内存实现，可经 config.rateLimit.limiter 注入） */
  private _rateLimiter: RateLimiter;
  /** 客户端 IP 解析函数（默认 getClientIp，可经 config.rateLimit.getClientIp 注入） */
  private _getClientIp: (ctx?: RequestContext | null) => string;
  private _signInLimit: { maxAttempts: number; windowMs: number };
  private _signUpLimit: { maxAttempts: number; windowMs: number };
  private _passwordResetLimit: { maxAttempts: number; windowMs: number };
  /** 验证码验证尝试限流（默认关闭，opt-in） */
  private _verifyCodeLimit: { maxAttempts: number; windowMs: number } | null;
  /** 密码最小长度 */
  private _passwordMinLength: number;
  /** user.create.after 钩子列表（事务提交后触发） */
  private _afterUserCreateHooks: Array<(user: { id: string; name?: string }) => Promise<void>> = [];

  constructor(config: OmniAuthConfig) {
    this.config = config;

    // 实例级注册表（多实例互不干扰）
    this._registry = createRegistry();
    if (config.audit) {
      this._registry.auditHandler = config.audit;
    }

    // 限流配置
    this._rateLimiter = config.rateLimit?.limiter ?? createMemoryRateLimiter();
    this._getClientIp = config.rateLimit?.getClientIp ?? getClientIp;
    this._signInLimit = config.rateLimit?.signIn ?? DEFAULT_SIGN_IN_LIMIT;
    this._signUpLimit = config.rateLimit?.signUp ?? DEFAULT_SIGN_UP_LIMIT;
    this._passwordResetLimit =
      config.rateLimit?.passwordReset ?? DEFAULT_RESET_LIMIT;
    this._verifyCodeLimit = config.rateLimit?.verifyCode ?? null;

    // 密码策略（默认最短 8 位，与旧版行为一致）
    this._passwordMinLength = config.passwordPolicy?.minLength ?? 8;

    // 社交账户服务（token refresher 经实例注册表查询）
    this._socialService = createSocialService(config.database, {
      getTokenRefresher: (provider) => this._registry.tokenRefreshers.get(provider),
    });

    // OAuth handler（依赖注入：provider 注册表 / 审计发布均走实例）
    this._oauthHandler = createOAuthHandler({
      db: config.database,
      getProvider: (provider) => this._registry.oauthProviders.get(provider),
      socialService: (db) =>
        createSocialService(db, {
          getTokenRefresher: (provider) => this._registry.tokenRefreshers.get(provider),
        }),
      publishAudit: (event) => this._publishAudit(event),
    });

    // 渠道验证码（委托模式，实例注册表）
    this._channelVerification = createChannelVerification(this._registry);

    // 密码重置（依赖实例级渠道验证码服务）
    this._passwordReset = createPasswordReset({
      db: config.database,
      channelVerification: this._channelVerification,
    });

    // ----------------------------------------------------------
    // 认证域服务（会话 / OAuth Server / 用户管理 / SCIM）
    // 表结构由包内 schema 单一管理，宿主仅消费语义 API
    // ----------------------------------------------------------

    this._sessions = createSessionService(config.database);

    this._oauthServer = createOAuthServer(
      config.database,
      config.tokenAuthority ?? missingTokenAuthority()
    );

    this._userAdmin = createUserAdmin(config.database, this._sessions);

    this._scim = createScimUserHandler({
      db: config.database,
      users: this._userAdmin,
      oauth: this._oauthServer,
      sessions: this._sessions,
    });

    // ----------------------------------------------------------
    // 收集 user.create.after hooks（signUp / OAuth 回调，事务提交后触发）
    // ----------------------------------------------------------

    if (config.hooks?.onUserCreated) {
      const onUserCreated = config.hooks.onUserCreated;
      this._afterUserCreateHooks.push(async (user: { id: string; name?: string }) => {
        await onUserCreated({ userId: user.id, name: user.name });
      });
    }
  }

  // ----------------------------------------------------------
  // 内部辅助
  // ----------------------------------------------------------

  /** 实例级审计发布 */
  private async _publishAudit(event: Omit<AuditEvent, "timestamp">): Promise<void> {
    await dispatchAuditEvent(this._registry.auditHandler, event);
  }

  /** 在事务中执行多表写入（适配器不支持事务时回退顺序写入并警告） */
  private async _withTransaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    return withTransaction(this.config.database, fn);
  }

  /** 尽力重置限流计数（外部限流器异常时仅记录，不影响主流程） */
  private async _safeResetRateLimit(key: string): Promise<void> {
    try {
      await this._rateLimiter.reset(key);
    } catch (err) {
      console.error("[OmniAuth] 限流计数重置失败:", err);
    }
  }

  /**
   * 注册核心：user + SocialAccount 通道记录。
   * 由调用方包入事务，保证原子提交。
   *
   * 共享密码语义：密码哈希存 user.password（可空，无密码渠道为 null）。
   */
  private async _createUserWithChannel(
    provider: string,
    providerOpenid: string,
    passwordHash: string | null,
    name: string,
    channelData?: SignUpInput["channel"],
    tx?: DatabaseAdapter
  ): Promise<string> {
    const dbf = createDbFacade(tx ?? this.config.database);
    const userId = randomUUID();
    const now = new Date();

    await dbf.user.create({
      data: {
        id: userId,
        name,
        password: passwordHash,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    });

    // 渠道记录（同事务写入，失败即整体回滚；扩展字段 4.1.0 起一并原子写入）
    await createSocialService(tx ?? this.config.database).bindToUser(userId, {
      provider,
      providerOpenid,
      accessToken: channelData?.accessToken,
      refreshToken: channelData?.refreshToken,
      tokenExpiresAt: channelData?.tokenExpiresAt,
      profileData: channelData?.profileData,
      valid: channelData?.valid,
      allowPasswordUpdate: channelData?.allowPasswordUpdate,
      allowVerification: channelData?.allowVerification,
    });

    return userId;
  }

  /** 事务提交后触发 user.create.after 钩子（失败仅记录，不影响注册结果） */
  private async _fireUserCreatedHooks(user: { id: string; name?: string }): Promise<void> {
    for (const hook of this._afterUserCreateHooks) {
      try {
        await hook(user);
      } catch (err) {
        console.error("[OmniAuth] user.create.after hook 执行失败:", err);
      }
    }
  }

  /** 从数据库读取完整用户信息并转为 PublicUser */
  private async _readPublicUser(userId: string): Promise<PublicUser> {
    const record = await this.db.user.findOne({
      where: [{ field: "id", value: userId }],
    });

    if (!record) {
      // 数据不一致：流程中引用的 user 记录已不存在，抛错而非伪造空用户
      throw new OmniAuthError("USER_NOT_FOUND", `用户记录不存在: ${userId}`);
    }

    return {
      id: record.id,
      name: record.name ?? "",
      image: record.image ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  // ----------------------------------------------------------
  // 用户认证
  // ----------------------------------------------------------

  /**
   * 邮箱渠道注册（便捷方法）。
   *
   * 内部等价于渠道化注册：创建 user（共享密码哈希）+ email 渠道记录
   * (provider="email", providerOpenid=邮箱地址, valid=1)。
   *
   * @param input 注册信息
   * @param requestContext 可选请求上下文（提供时按客户端 IP 限流）
   * @throws UserExistsError 邮箱渠道已注册
   * @throws RateLimitedError 超过限流
   */
  async signUp(input: SignUpInput, requestContext?: RequestContext): Promise<SignUpResult> {
    // 0. 速率限制：键为客户端 IP（防按渠道锁死注册的 DoS）
    const ip = this._getClientIp(requestContext);
    await checkRateLimit(
      this._rateLimiter,
      `signUp:${ip}`,
      this._signUpLimit.maxAttempts,
      this._signUpLimit.windowMs
    );

    // 1. 验证密码长度（策略可经 config.passwordPolicy 收紧）
    if (input.password.length < this._passwordMinLength) {
      throw new WeakPasswordError(`密码长度不能少于 ${this._passwordMinLength} 位`);
    }

    // 2. 检查邮箱渠道是否已注册（友好提示；唯一约束在事务内兜底）
    const existingChannel = await this._socialService.findByProvider("email", input.email);
    if (existingChannel) {
      throw new UserExistsError("该邮箱已被注册");
    }

    // 3. 哈希密码（事务外执行，避免 CPU 密集操作撑开事务）
    const hashedPassword = await hashPassword(input.password);

    // email 渠道的通道数据（扩展字段随注册同事务原子写入；真实登记 valid=1）
    const channelData = {
      accessToken: input.channel?.accessToken,
      refreshToken: input.channel?.refreshToken,
      tokenExpiresAt: input.channel?.tokenExpiresAt,
      profileData: input.channel?.profileData,
      valid: input.channel?.valid ?? 1,
      allowPasswordUpdate: input.channel?.allowPasswordUpdate ?? 1,
      allowVerification: input.channel?.allowVerification ?? 1,
    };

    // 4. 事务创建 user + email 渠道记录
    let userId: string;
    try {
      userId = await this._withTransaction((tx) =>
        this._createUserWithChannel(
          "email",
          input.email,
          hashedPassword,
          input.name,
          channelData,
          tx
        )
      );
    } catch (err) {
      // 并发注册时预检查可能漏判，由唯一约束兜底并转译为友好错误
      if (err instanceof UniqueViolationError) {
        throw new UserExistsError("该邮箱已被注册");
      }
      throw err;
    }

    // 5. 事务提交后触发 user.create.after 钩子
    await this._fireUserCreatedHooks({ id: userId, name: input.name });

    await this._publishAudit({ action: "signUp", userId, ip });

    // 6. 读取完整用户信息并返回
    const user = await this._readPublicUser(userId);

    return {
      userId,
      user,
    };
  }

  /**
   * 邮箱渠道登录（便捷方法）。
   *
   * 内部等价于渠道化登录：email 渠道记录反查用户 → 验证共享密码。
   *
   * @param input 登录信息
   * @param requestContext 可选请求上下文（提供时按 ip:provider:providerOpenid 限流）
   * @throws InvalidPasswordError 邮箱或密码错误（统一消息防枚举）
   * @throws RateLimitedError 超过限流
   */
  async signIn(input: SignInInput, requestContext?: RequestContext): Promise<SignInResult> {
    // 0. 速率限制：键为 ip:provider:providerOpenid 复合
    const ip = this._getClientIp(requestContext);
    const limitKey = `signIn:${ip}:email:${input.email}`;
    await checkRateLimit(
      this._rateLimiter,
      limitKey,
      this._signInLimit.maxAttempts,
      this._signInLimit.windowMs
    );

    // 1. 通过 email 渠道反查用户
    const channel = await this._socialService.findByProvider("email", input.email);
    const user = channel
      ? await this.db.user.findOne({ where: [{ field: "id", value: channel.userId }] })
      : null;

    // 2. 统一错误消息防枚举（无渠道 / 无用户 / 无密码一致）
    if (!user || !user.password) {
      await this._publishAudit({
        action: "signInFailed",
        ip,
        metadata: { provider: "email", providerOpenid: input.email },
      });
      throw new InvalidPasswordError("邮箱或密码错误");
    }

    // 3. 校验共享密码
    const isValid = await verifyPassword(user.password, input.password);
    if (!isValid) {
      await this._publishAudit({
        action: "signInFailed",
        ip,
        metadata: { provider: "email", providerOpenid: input.email },
      });
      throw new InvalidPasswordError("邮箱或密码错误");
    }

    // 登录成功：重置限流计数（历史失败不应锁死合法用户）
    await this._safeResetRateLimit(limitKey);

    await this._publishAudit({ action: "signIn", userId: user.id, ip });

    // 4. 读取完整用户信息并返回
    const fullUser = await this._readPublicUser(user.id);

    return {
      userId: user.id,
      user: fullUser,
    };
  }

  // ----------------------------------------------------------
  // 统一通道认证
  // ----------------------------------------------------------

  /**
   * 统一通道认证入口。
   * 自动判断注册/登录：渠道不存在则新建用户 + 绑定；已存在则直接登录。
   *
   * 非密码凭证契约：调用方必须已完成凭证验证并显式声明
   * credential.verified = true，否则抛 CredentialInvalidError。
   */
  async authenticateChannel(
    input: ChannelAuthInput,
    requestContext?: RequestContext
  ): Promise<ChannelAuthResult> {
    // 0. 非密码凭证契约校验（库不代为验证 smsCode / oauthCode 等）
    if (input.credential.type !== "password" && input.credential.verified !== true) {
      throw new CredentialInvalidError(
        "非密码凭证必须由调用方预先验证：credential.verified 必须为 true"
      );
    }

    // 1. 检查渠道是否已存在
    const existingChannel = await this._socialService.findByProvider(
      input.provider,
      input.providerOpenid
    );

    if (existingChannel) {
      // 已有绑定 → 登录（凭证校验）
      let userId: string;
      let user: PublicUser;

      if (input.credential.type === "password") {
        // 密码凭证：渠道反查用户 → 验证共享密码（限流键 ip:provider:providerOpenid）
        const ip = this._getClientIp(requestContext);
        const limitKey = `signIn:${ip}:${input.provider}:${input.providerOpenid}`;
        await checkRateLimit(
          this._rateLimiter,
          limitKey,
          this._signInLimit.maxAttempts,
          this._signInLimit.windowMs
        );

        const record = await this.db.user.findOne({
          where: [{ field: "id", value: existingChannel.userId }],
        });

        // 统一错误消息防枚举（无用户 / 无密码一致）
        if (!record || !record.password) {
          await this._publishAudit({
            action: "signInFailed",
            ip,
            metadata: { provider: input.provider, providerOpenid: input.providerOpenid },
          });
          throw new InvalidPasswordError("凭证或密码错误");
        }

        const isValid = await verifyPassword(record.password, input.credential.value);
        if (!isValid) {
          await this._publishAudit({
            action: "signInFailed",
            ip,
            metadata: { provider: input.provider, providerOpenid: input.providerOpenid },
          });
          throw new InvalidPasswordError("凭证或密码错误");
        }

        // 验证成功：重置限流计数（历史失败不应锁死合法用户）
        await this._safeResetRateLimit(limitKey);
        userId = record.id;
        user = await this._readPublicUser(userId);
      } else {
        // 非密码凭证：入口契约已保证调用方完成验证
        userId = existingChannel.userId;
        user = await this._readPublicUser(userId);
      }

      await this._publishAudit({ action: "signIn", userId });

      return {
        userId,
        isNewUser: false,
        user,
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

    // 2. 不存在 → 注册新用户（channelData 4.1.0 起随注册同事务原子写入）
    const ip = this._getClientIp(requestContext);

    // 注册限流：键为客户端 IP（防按渠道锁死注册的 DoS）
    await checkRateLimit(
      this._rateLimiter,
      `signUp:${ip}`,
      this._signUpLimit.maxAttempts,
      this._signUpLimit.windowMs
    );

    // 密码凭证校验强度；非密码凭证（OAuth 等）用户无密码（password=null）
    const password =
      input.credential.type === "password" ? input.credential.value : null;
    if (password !== null && password.length < this._passwordMinLength) {
      throw new WeakPasswordError(`密码长度不能少于 ${this._passwordMinLength} 位`);
    }
    const passwordHash = password !== null ? await hashPassword(password) : null;
    const name = input.profile?.name ?? input.providerOpenid;

    let userId: string;
    try {
      userId = await this._withTransaction((tx) =>
        this._createUserWithChannel(
          input.provider,
          input.providerOpenid,
          passwordHash,
          name,
          {
            accessToken: input.channelData?.accessToken,
            refreshToken: input.channelData?.refreshToken,
            tokenExpiresAt: input.channelData?.tokenExpiresAt,
            profileData: input.channelData?.profileData,
            valid: input.channelData?.valid ?? 1,
            allowPasswordUpdate: input.channelData?.allowPasswordUpdate ?? 0,
            allowVerification: input.channelData?.allowVerification ?? 0,
          },
          tx
        )
      );
    } catch (err) {
      // 并发注册时预检查可能漏判，由唯一约束兜底
      if (err instanceof UniqueViolationError) {
        throw new SocialAccountConflictError(input.provider, input.providerOpenid);
      }
      throw err;
    }

    // 3. 事务提交后触发 user.create.after 钩子
    await this._fireUserCreatedHooks({ id: userId, name });

    // 4. 回读渠道记录（已在事务内与 user 原子提交）
    const updatedRecord = await this.db.socialAccount.findOne({
      where: [
        { field: "provider", value: input.provider },
        { field: "providerOpenid", value: input.providerOpenid },
      ],
    });

    if (!updatedRecord) {
      throw new SocialAccountConflictError(input.provider, input.providerOpenid);
    }

    await this._publishAudit({ action: "signUp", userId });

    return {
      userId,
      isNewUser: true,
      user: await this._readPublicUser(userId),
      channel: {
        id: updatedRecord.id,
        provider: input.provider,
        providerOpenid: input.providerOpenid,
        valid: updatedRecord.valid ?? 1,
        allowPasswordUpdate: updatedRecord.allowPasswordUpdate ?? 0,
        allowVerification: updatedRecord.allowVerification ?? 0,
      },
    };
  }

  // ----------------------------------------------------------
  // 密码管理（重置 & 修改）
  // ----------------------------------------------------------

  async requestPasswordReset(
    provider: string,
    providerOpenid: string,
    requestContext?: RequestContext
  ): Promise<void> {
    // 速率限制：3 次/10 分钟
    const ip = this._getClientIp(requestContext);
    await checkRateLimit(
      this._rateLimiter,
      `passwordReset:${ip}:${provider}:${providerOpenid}`,
      this._passwordResetLimit.maxAttempts,
      this._passwordResetLimit.windowMs
    );
    await this._passwordReset.requestReset(provider, providerOpenid);
    await this._publishAudit({
      action: "resetPasswordRequest",
      ip,
      metadata: { provider, providerOpenid },
    });
  }

  async resetPassword(
    provider: string,
    providerOpenid: string,
    code: string,
    newPassword: string
  ): Promise<void> {
    await this._passwordReset.reset(provider, providerOpenid, code, newPassword);
    await this._publishAudit({ action: "resetPasswordDone" });
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

  /** 注册 OAuth provider（实例级注册表） */
  registerOAuthProvider(config: OAuthProviderConfig): void {
    this._registry.oauthProviders.set(config.provider, config);
  }

  /** 获取 OAuth handler（含 initiateOAuth） */
  get oauth(): OAuthHandler {
    return this._oauthHandler;
  }

  /**
   * 处理 OAuth 回调。
   *
   * 推荐使用对象形式参数（库内强制校验 state）：
   * ```ts
   * auth.handleOAuthCallback(provider, code, redirectUri, {
   *   state: body.state,            // 回调携带
   *   expectedState: cookieValue,   // 发起授权时服务端保存
   *   codeVerifier,
   * });
   * ```
   *
   * @deprecated 位置参数签名 (state?, codeVerifier?) 仍可用但不校验 state。
   */
  async handleOAuthCallback(
    provider: string,
    code: string,
    redirectUri: string,
    stateOrOptions?: string | OAuthCallbackOptions,
    codeVerifier?: string
  ): Promise<OAuthCallbackResult> {
    const result = await this._oauthHandler(
      provider,
      code,
      redirectUri,
      stateOrOptions,
      codeVerifier
    );

    // ---- OAuth 新用户创建后触发 onUserCreated 钩子（事务已提交）
    if (result.isNewUser) {
      await this._fireUserCreatedHooks({ id: result.userId });
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
    return this._channelVerification.requestCode(provider, providerOpenid, channelRef);
  }

  /**
   * 委托渠道验证验证码。
   *
   * 将用户提交的验证码交给 provider 注册的 verifier 判定，
   * 库无条件透传验证结果。不要求登录态（注册/绑定场景可能未登录），
   * 调用者自行判断业务上下文。
   *
   * 4.1.0：配置 rateLimit.verifyCode 后按 `provider:providerOpenid`
   * 限制尝试次数（防短验证码爆破），验证成功时重置计数。
   */
  async verifyChannelCode(
    provider: string,
    providerOpenid: string,
    code: string,
    channelRef?: SocialAccountRef
  ): Promise<boolean> {
    // 可选尝试次数限流（opt-in；未配置时行为与旧版一致）
    const limitKey = `verifyCode:${provider}:${providerOpenid}`;
    if (this._verifyCodeLimit) {
      await checkRateLimit(
        this._rateLimiter,
        limitKey,
        this._verifyCodeLimit.maxAttempts,
        this._verifyCodeLimit.windowMs
      );
    }

    const ok = await this._channelVerification.verifyCode(
      provider,
      providerOpenid,
      code,
      channelRef
    );

    // 验证成功：重置计数（后续合法验证不受历史失败影响）
    if (ok && this._verifyCodeLimit) {
      await this._safeResetRateLimit(limitKey);
    }

    return ok;
  }

  /** 注册指定 provider 的验证码发送器（实例级注册表） */
  registerVerificationSender(provider: string, sender: VerificationSender): void {
    this._registry.senders.set(provider, sender);
  }

  /**
   * 注册指定 provider 的验证码验证器（实例级注册表）。
   * 验证码的状态管理与验证逻辑完全由实现方负责。
   */
  registerVerificationVerifier(provider: string, verifier: VerificationVerifier): void {
    this._registry.verifiers.set(provider, verifier);
  }

  // ----------------------------------------------------------
  // 审计
  // ----------------------------------------------------------

  /** 设置实例级审计处理器 */
  setAuditHandler(handler: AuditHandler): void {
    this._registry.auditHandler = handler;
  }

  // ----------------------------------------------------------
  // 社交账户
  // ----------------------------------------------------------

  get social() {
    return this._socialService;
  }

  // ----------------------------------------------------------
  // 会话（认证域私有）
  // ----------------------------------------------------------

  /** 会话管理（创建 / 校验 / 销毁；宿主 cookie 处理见 omni-auth/nextjs） */
  get sessions(): SessionService {
    return this._sessions;
  }

  // ----------------------------------------------------------
  // OAuth Server（认证域私有）
  // ----------------------------------------------------------

  /**
   * OAuth 2.0 Server 能力（授权码 / 令牌 / 客户端凭证管理）。
   *
   * 注意：auth.oauth 是外部 OAuth provider 登录 handler（Google/GitHub/WeChat），
   * 本命名空间是面向宿主应用的 OAuth server，勿混淆。
   */
  get oauthServer(): OAuthServerService {
    return this._oauthServer;
  }

  // ----------------------------------------------------------
  // 用户管理（认证域私有）
  // ----------------------------------------------------------

  /** 用户管理（创建 / 更新 / 查询 / 级联删除；含 emailVerified/active 元数据） */
  get users(): UserAdminService {
    return this._userAdmin;
  }

  // ----------------------------------------------------------
  // SCIM（认证域私有）
  // ----------------------------------------------------------

  /** SCIM 2.0 用户目录（协议翻译 + CRUD，宿主 route 薄壳接入） */
  get scim(): ScimUserHandler {
    return this._scim;
  }

  // ----------------------------------------------------------
  // Token 刷新
  // ----------------------------------------------------------

  /** 注册指定 provider 的 token 刷新器（实例级注册表） */
  registerTokenRefresher(provider: string, refresher: TokenRefresher): void {
    this._registry.tokenRefreshers.set(provider, refresher);
  }

  // ----------------------------------------------------------
  // 数据库直通（增删改查）
  // ----------------------------------------------------------

  /**
   * 数据库直通门面（惰性缓存）：
   * - 类型化表视图（推荐）：db.user.* / db.socialAccount.*
   * - 泛型方法（已弃用）：db.findOne({ model, ... }) 等
   */
  get db(): DbFacade {
    if (!this._dbFacade) {
      this._dbFacade = createDbFacade(this.config.database);
    }
    return this._dbFacade;
  }
}

// ----------------------------------------------------------
// 工厂函数
// ----------------------------------------------------------

export function createAuth(config: OmniAuthConfig): OmniAuth {
  return new OmniAuth(config);
}
