// ============================================================
// 社交账户 DTO + 渠道绑定数据
// ============================================================

/** 渠道绑定数据（写入侧单一事实源：bindToUser 输入与 ChannelAuthInput.channelData 共用） */
export interface ChannelBindingData {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date | number;
  profileData?: Record<string, unknown>;
  /** 渠道可用性（缺省 true）；DB 存 smallint 0/1，由 adapter 边界映射 */
  valid?: boolean;
  /** 允许密码更新（缺省 false） */
  allowPasswordUpdate?: boolean;
  /** 允许验证码（缺省 false） */
  allowVerification?: boolean;
}

export interface SocialAccountDTO {
  id: string;
  userId: string;
  provider: string;
  /** provider 内唯一身份标识（8.0.0 由 providerOpenid 更名；DB 列仍为 providerOpenid） */
  identifier: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  profileData: Record<string, unknown>;
  /** 以下三枚对外为 boolean，DB 存 smallint 0/1，由 adapter 边界映射 */
  valid: boolean;
  allowPasswordUpdate: boolean;
  allowVerification: boolean;
  createdAt: Date;
  updatedAt: Date;
}
