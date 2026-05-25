import { prisma } from "../client";

export const businessAccountRepo = {
  async findByAuthUserId(authUserId: string) {
    return prisma.businessAccount.findUnique({
      where: { authUserId },
    });
  },

  async create(data: {
    authUserId: string;
    displayName: string;
    status: string;
  }) {
    return prisma.businessAccount.create({ data });
  },
};
