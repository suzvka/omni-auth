// ============================================================
// EmailAdapter — 邮件发送适配器接口
//
// 邮箱验证模块可通过此接口发送验证邮件（可选接入）。
// 不提供此适配器则验证邮件不会发送。
// ============================================================

export interface EmailAdapter {
  /** 发送邮箱验证邮件 */
  sendVerificationEmail(params: {
    /** 收件人邮箱 */
    to: string;
    /** 邮件主题 */
    subject: string;
    /** 验证链接（含 token） */
    url: string;
    /** 纯文本 token（备用方案） */
    token: string;
  }): Promise<void>;

  /** 发送密码重置邮件 */
  sendPasswordResetEmail(params: {
    to: string;
    subject: string;
    url: string;
    token: string;
  }): Promise<void>;
}
