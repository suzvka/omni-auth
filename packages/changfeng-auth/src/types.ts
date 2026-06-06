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
  valid: number;
  allowPasswordUpdate: number;
  allowVerification: number;
  createdAt: Date;
}

/** 用户通道（邮箱 / 手机 / 等，复用 SocialAccount 存储） */
export interface UserChannel {
  id: string;
  userId: string;
  /** 通道类型，如 "email" / "phone" / "wechat" 等 */
  provider: string;
  /** 通道标识符（邮箱地址、手机号、openid 等） */
  providerOpenid: string;
  /** 0=系统占位（如 OAuth 自动生成），1=用户真实登记 */
  valid: number;
  /** 是否允许通过该渠道的凭证更新密码 */
  allowPasswordUpdate: number;
  /** 是否允许通过该渠道接收验证码 */
  allowVerification: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthContext {
  account: Account | null;
  authUserId: string | null;
  /** 当前用户已绑定的社交账户列表 */
  socialAccounts: SocialAccountBrief[];
  /** 当前用户的通信通道列表（邮箱 + 手机） */
  channels: UserChannel[];
  /** 当前用户的角色列表 */
  roles: string[];
}
