// ============================================================
// ChangfengAuth — SDK 主类
//
// 完全封装 Better Auth，提供框架无关的认证 API。
// ============================================================

import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { DatabaseAdapter } from "./adapters/database";
import type { EmailAdapter } from "./adapters/email";
import type { RequestContext } from "./adapters/request";
import type { AuthContext, Account, SocialAccountBrief } from "./types";
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
  /** 邮件适配器（可选，不提供则邮箱验证/密码重置不可用） */
  email?: EmailAdapter;
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
          after: async (session: { userId: string; token: string }) => {
            await onSessionCreated({
              userId: session.userId,
              token: session.token,
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

    // 初始化邮箱验证（如果提供了 EmailAdapter）
    if (config.email) {
      this._emailVerification = createEmailVerification({
        auth: this._betterAuth,
      });
    }

    // 初始化密码重置
    if (config.email) {
      this._passwordReset = createPasswordReset({
        auth: this._betterAuth,
        email: config.email,
        baseUrl: config.baseUrl,
      });
    }

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
      return { account: null, authUserId: null, socialAccounts: [], roles: [] };
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

    const socialAccounts: SocialAccountBrief[] = socialAccountDTOs.map((d) => ({
      id: d.id,
      provider: d.provider,
      providerOpenid: d.providerOpenid,
      profileData: d.profileData,
      createdAt: d.createdAt,
    }));

    return { account, authUserId, socialAccounts, roles };
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
  // 社交账户
  // ----------------------------------------------------------

  get social() {
    return this._socialService;
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
