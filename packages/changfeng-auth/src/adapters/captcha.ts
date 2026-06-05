// ============================================================
// CaptchaAdapter — 验证码适配器接口
//
// 第三方按此契约实现自己的验证码模块（图形验证码、
// Turnstile、hCaptcha 等），库在需要时调用并等待返回值，
// 不关心验证机制的具体实现方式。
// ============================================================

export interface CaptchaAdapter {
  /**
   * 验证验证码 / 人机验证令牌。
   *
   * @param params.token   - 前端提交的验证码凭证（如 Turnstile token）
   * @param params.action  - 触发场景：signUp / signIn / passwordReset
   * @param params.metadata - 可选上下文信息（如客户端 IP、User-Agent 等）
   * @returns true 表示验证通过，false 表示验证失败
   */
  verify(params: {
    token: string;
    action?: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean>;
}
