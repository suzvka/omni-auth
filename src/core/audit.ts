// ============================================================
// 审计日志
//
// 通过 onAuditEvent 钩子暴露关键安全事件。
// 使用者自行决定如何持久化（DB / 文件 / 外部日志服务）。
//
// 3.0.0 起审计处理器收编为 OmniAuth 实例成员（OmniRegistry，
// 经 OmniAuthConfig.audit 或实例方法 setAuditHandler 配置）；
// 8.0.0 移除已弃用的模块级全局函数。
// ============================================================

// ----------------------------------------------------------
// 审计事件类型
// ----------------------------------------------------------

export type AuditAction =
  | "signUp"
  | "signIn"
  | "signInFailed"
  | "signOut"
  | "changePassword"
  | "resetPasswordRequest"
  | "resetPasswordDone"
  | "deleteAccount"
  | "updateProfile"
  | "channelBind"
  | "channelUnbind"
  | "socialBind"
  | "socialUnbind"
  | "oauthLogin"
  | "tokenRevoked"
  | "tokensRevokedAll"
  | "changeName"
  | "channelUpdate"
  | "verificationSent";

export interface AuditEvent {
  /** 事件类型 */
  action: AuditAction;
  /** 操作用户 ID（未登录时为空） */
  userId?: string;
  /** 关联 IP */
  ip?: string;
  /** User-Agent */
  userAgent?: string;
  /** 额外上下文 */
  metadata?: Record<string, unknown>;
  /** 事件时间 */
  timestamp: Date;
}

export type AuditHandler = (event: AuditEvent) => void | Promise<void>;

/** 实例级发布入口：handler 缺省时静默跳过，处理失败不抛异常 */
export async function dispatchAuditEvent(
  handler: AuditHandler | null | undefined,
  event: Omit<AuditEvent, "timestamp">
): Promise<void> {
  if (!handler) return;

  const fullEvent: AuditEvent = {
    ...event,
    timestamp: new Date(),
  };

  try {
    await handler(fullEvent);
  } catch (err) {
    console.error("[Audit] 审计事件处理失败:", err);
  }
}

/**
 * 从 RequestContext 提取常用的审计上下文（IP / UA）。
 */
export function extractAuditContext(ctx: {
  getHeader(name: string): string | null;
}): { ip?: string; userAgent?: string } {
  return {
    ip: ctx.getHeader("x-forwarded-for") ?? ctx.getHeader("x-real-ip") ?? undefined,
    userAgent: ctx.getHeader("user-agent") ?? undefined,
  };
}
