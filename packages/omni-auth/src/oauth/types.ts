// ============================================================
// OAuth 回调抽象
// ============================================================

export interface OAuthProviderConfig {
  /** 平台标识，如 "wechat", "google" */
  provider: string;

  /**
   * 用 OAuth code 换取 access_token + openid + 用户信息。
   * 完全由使用者实现，对接具体平台 API。
   */
  exchangeCode(code: string, redirectUri: string): Promise<{
    openid: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
    profileData?: Record<string, unknown>;
    email?: string;
    name?: string;
  }>;
}

export interface OAuthCallbackResult {
  /** Session token（用于设置 cookie） */
  token: string;
  /** 用户的 authUserId */
  userId: string;
  /** 是否为新注册用户 */
  isNewUser: boolean;
  /** 绑定的渠道信息 */
  channel: {
    id: string;
    provider: string;
    providerOpenid: string;
    valid: number;
    allowPasswordUpdate: number;
  };
}
