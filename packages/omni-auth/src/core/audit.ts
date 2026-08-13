// ============================================================
// 审计日志
//
// 通过 onAuditEvent 钩子暴露关键安全事件。
// 使用者自行决定如何持久化（DB / 文件 / 外部日志服务）。
//
// 3.0.0 起审计处理器收编为 OmniAuth 实例成员（OmniRegistry，
// 经 OmniAuthConfig.audit 或实例方法 setAuditHandler 配置），
// 模块级全局函数已弃用，仅转发到最近创建的实例。
// ============================================================

import { getActiveRegistry, requireActiveRegistry } from "../registry";

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

// ----------------------------------------------------------
// 全局审计处理器（已弃用 — 转发到最近创建的实例注册表）
// ----------------------------------------------------------

/** @deprecated 使用 OmniAuthConfig.audit 或实例方法 setAuditHandler 替代 */
export function setAuditHandler(handler: AuditHandler): void {
  requireActiveRegistry("setAuditHandler").auditHandler = handler;
}

/** @deprecated 使用 OmniAuth 实例注册表替代 */
export function getAuditHandler(): AuditHandler | null {
  return getActiveRegistry()?.auditHandler ?? null;
}

/**
 * 发布审计事件（异步、不抛异常）。
 *
 * @deprecated 全局函数仅作过渡兼容；SDK 内部经实例注册表发布事件。
 */
export async function publishAuditEvent(event: Omit<AuditEvent, "timestamp">): Promise<void> {
  const handler = getActiveRegistry()?.auditHandler;
  await dispatchAuditEvent(handler, event);
}

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
