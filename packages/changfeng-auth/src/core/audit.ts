// ============================================================
// 审计日志
//
// 通过 onAuditEvent 钩子暴露关键安全事件。
// 使用者自行决定如何持久化（DB / 文件 / 外部日志服务）。
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
  | "emailVerificationRequest"
  | "emailVerified"
  | "socialBind"
  | "socialUnbind"
  | "oauthLogin"
  | "sessionRevoked"
  | "sessionRevokedAll";

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

// ----------------------------------------------------------
// 全局审计处理器
// ----------------------------------------------------------

let auditHandler: AuditHandler | null = null;

export function setAuditHandler(handler: AuditHandler): void {
  auditHandler = handler;
}

export function getAuditHandler(): AuditHandler | null {
  return auditHandler;
}

/**
 * 发布审计事件（异步、不抛异常）。
 */
export async function publishAuditEvent(event: Omit<AuditEvent, "timestamp">): Promise<void> {
  if (!auditHandler) return;

  const fullEvent: AuditEvent = {
    ...event,
    timestamp: new Date(),
  };

  try {
    await auditHandler(fullEvent);
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
