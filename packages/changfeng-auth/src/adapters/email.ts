// ============================================================
// EmailAdapter — 邮件发送适配器接口
//
// SDK 在密码重置 / 邮箱验证时通过此接口发送邮件。
// 不提供此适配器则相关功能不可用。
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
