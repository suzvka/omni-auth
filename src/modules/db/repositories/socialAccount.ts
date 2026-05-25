import { prisma } from "../client";

export type CreateSocialAccountInput = {
  userId: string;
  provider: string;
  providerOpenid: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date | number;
  profileData?: Record<string, unknown>;
};

export const socialAccountRepo = {
  /** 根据 provider + openid 查找（用于防重复注册） */
  async findByProvider(provider: string, providerOpenid: string) {
    return prisma.socialAccount.findUnique({
      where: {
        provider_providerOpenid: {
          provider,
          providerOpenid,
        },
      },
    });
  },

  /** 根据 userId 查找该用户绑定的所有社交账户 */
  async findByUserId(userId: string) {
    return prisma.socialAccount.findMany({
      where: { userId },
    });
  },

  /** 创建社交账户绑定 */
  async create(data: CreateSocialAccountInput) {
    const tokenExpiresAt =
      data.tokenExpiresAt != null
        ? data.tokenExpiresAt instanceof Date
          ? data.tokenExpiresAt
          : new Date(data.tokenExpiresAt)
        : undefined;

    return prisma.socialAccount.create({
      data: {
        userId: data.userId,
        provider: data.provider,
        providerOpenid: data.providerOpenid,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiresAt,
        profileData: (data.profileData ?? {}) as never,
      },
    });
  },

  /** 更新 token（适用于 token 刷新场景） */
  async updateTokens(
    id: string,
    tokens: {
      accessToken?: string;
      refreshToken?: string;
      tokenExpiresAt?: Date | number;
    }
  ) {
    const tokenExpiresAt =
      tokens.tokenExpiresAt != null
        ? tokens.tokenExpiresAt instanceof Date
          ? tokens.tokenExpiresAt
          : new Date(tokens.tokenExpiresAt)
        : undefined;

    return prisma.socialAccount.update({
      where: { id },
      data: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt,
      },
    });
  },

  /** 删除社交账户绑定 */
  async delete(id: string) {
    return prisma.socialAccount.delete({
      where: { id },
    });
  },
};
