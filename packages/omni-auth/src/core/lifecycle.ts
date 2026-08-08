// ============================================================
// 生命周期钩子
// ============================================================

export interface UserCreatedPayload {
  userId: string;
  email?: string;
  name?: string;
}

export interface SessionCreatedPayload {
  userId: string;
  token: string;
  /** better-auth 传入的完整 user 对象 */
  user?: {
    id: string;
    email: string;
    name?: string;
    image?: string;
    emailVerified?: boolean;
  };
  /** better-auth 传入的完整 session 对象 */
  session?: {
    id: string;
    expiresAt?: Date;
    ipAddress?: string;
    userAgent?: string;
  };
}

export interface SessionExpiredPayload {
  userId: string;
  sessionToken?: string;
  expiredAt?: Date;
}

export interface LifecycleHooks {
  /** 用户注册成功后触发 */
  onUserCreated?: (payload: UserCreatedPayload) => void | Promise<void>;
  /** 新 Session 创建后触发（每次登录 / token 刷新时） */
  onSessionCreated?: (payload: SessionCreatedPayload) => void | Promise<void>;
  /** Session 过期时触发（需通过 checkExpiredSessions() 或中间件手动调用） */
  onSessionExpired?: (payload: SessionExpiredPayload) => void | Promise<void>;
}
