// ============================================================
// 公共类型定义
// ============================================================

export interface Account {
  id: string;
  authUserId: string;
  displayName: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 精简版社交账户信息（仅暴露给 AuthContext 消费方） */
export interface SocialAccountBrief {
  id: string;
  provider: string;
  providerOpenid: string;
  profileData: Record<string, unknown>;
  createdAt: Date;
}

export interface AuthContext {
  account: Account | null;
  authUserId: string | null;
  /** 当前用户已绑定的社交账户列表 */
  socialAccounts: SocialAccountBrief[];
  /** 当前用户的角色列表 */
  roles: string[];
}
