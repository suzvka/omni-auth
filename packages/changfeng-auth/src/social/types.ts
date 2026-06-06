// ============================================================
// 社交账户 DTO
// ============================================================

export interface SocialAccountDTO {
  id: string;
  userId: string;
  provider: string;
  providerOpenid: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  profileData: Record<string, unknown>;
  valid: number;
  allowPasswordUpdate: number;
  createdAt: Date;
  updatedAt: Date;
}
