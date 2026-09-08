// ============================================================
// 社交账户 DTO
// ============================================================

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
