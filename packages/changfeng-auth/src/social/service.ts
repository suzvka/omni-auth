// ============================================================
// 社交账户服务
//
// 框架无关，封装社交账户的绑定/解绑/查询/Token 刷新逻辑。
// ============================================================

import type { DatabaseAdapter } from "../adapters/database";
import type { SocialAccountDTO } from "./types";
import { getTokenRefresher, type SocialAccountRef } from "./token";
import { SocialAccountConflictError } from "../errors";

// ----------------------------------------------------------
// 将数据库记录转为 DTO
// ----------------------------------------------------------

/**
 * 安全解析 profileData。
 *
 * 某些环境（如 SQLite 非 JSON 模式、原始查询等）可能将 profileData
 * 以 JSON 字符串形式返回，需要运行时防御。
 */
function parseProfileData(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 不是合法 JSON，返回空对象
    }
    return {};
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function toDTO(record: Record<string, unknown>): SocialAccountDTO {
  return {
    id: record.id as string,
    userId: record.userId as string,
    provider: record.provider as string,
    providerOpenid: record.providerOpenid as string,
    accessToken: (record.accessToken as string) ?? null,
    refreshToken: (record.refreshToken as string) ?? null,
    tokenExpiresAt: (record.tokenExpiresAt as Date) ?? null,
    profileData: parseProfileData(record.profileData),
    valid: (record.valid as number) ?? 0,
    allowPasswordUpdate: (record.allowPasswordUpdate as number) ?? 0,
    allowVerification: (record.allowVerification as number) ?? 0,
    createdAt: record.createdAt as Date,
    updatedAt: record.updatedAt as Date,
  };
}

function toSocialAccountRef(dto: SocialAccountDTO): SocialAccountRef {
  return {
    id: dto.id,
    provider: dto.provider,
    providerOpenid: dto.providerOpenid,
    accessToken: dto.accessToken,
    refreshToken: dto.refreshToken,
    tokenExpiresAt: dto.tokenExpiresAt,
    profileData: dto.profileData,
  };
}

// ----------------------------------------------------------
// Token 自动刷新
// ----------------------------------------------------------

async function refreshTokenIfNeeded(
  db: DatabaseAdapter,
  dto: SocialAccountDTO
): Promise<SocialAccountDTO> {
  if (!dto.tokenExpiresAt) return dto;

  const bufferMs = 5 * 60 * 1000;
  if (dto.tokenExpiresAt.getTime() - bufferMs > Date.now()) {
    return dto;
  }

  const refresher = getTokenRefresher(dto.provider);
  if (!refresher) return dto;

  try {
    const result = await refresher(toSocialAccountRef(dto));
    const updated = await db.updateOne({
      model: "socialAccount",
      where: [{ field: "id", value: dto.id }],
      update: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? dto.refreshToken,
        tokenExpiresAt: result.expiresAt ?? dto.tokenExpiresAt,
      },
    });
    return toDTO(updated as Record<string, unknown>);
  } catch (err) {
    console.error(
      `[socialService] Token 刷新失败 (${dto.provider}:${dto.id}):`,
      err
    );
    return dto;
  }
}

// ----------------------------------------------------------
// SocialService 工厂
// ----------------------------------------------------------

export function createSocialService(db: DatabaseAdapter) {
  return {
    async bindToUser(
      userId: string,
      input: {
        provider: string;
        providerOpenid: string;
        accessToken?: string;
        refreshToken?: string;
        tokenExpiresAt?: Date | number;
        profileData?: Record<string, unknown>;
        valid?: number;
        allowPasswordUpdate?: number;
        allowVerification?: number;
      }
    ): Promise<SocialAccountDTO> {
      const existing = (await db.findOne({
        model: "socialAccount",
        where: [
          { field: "provider", value: input.provider },
          { field: "providerOpenid", value: input.providerOpenid },
        ],
      })) as Record<string, unknown> | null;

      if (existing) {
        throw new SocialAccountConflictError(
          input.provider,
          input.providerOpenid
        );
      }

      const record = await db.create({
        model: "socialAccount",
        data: {
          userId,
          provider: input.provider,
          providerOpenid: input.providerOpenid,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          tokenExpiresAt:
            input.tokenExpiresAt != null
              ? input.tokenExpiresAt instanceof Date
                ? input.tokenExpiresAt
                : new Date(input.tokenExpiresAt)
              : undefined,
          profileData: input.profileData ?? {},
          valid: input.valid ?? 0,
          allowPasswordUpdate: input.allowPasswordUpdate ?? 0,
          allowVerification: input.allowVerification ?? 0,
        },
      });
      return toDTO(record as Record<string, unknown>);
    },

    async unbindFromUser(id: string): Promise<void> {
      await db.deleteOne({
        model: "socialAccount",
        where: [{ field: "id", value: id }],
      });
    },

    async listByUser(userId: string): Promise<SocialAccountDTO[]> {
      const records = (await db.findMany({
        model: "socialAccount",
        where: [{ field: "userId", value: userId }],
      })) as Record<string, unknown>[];
      const dtos = records.map(toDTO);
      return Promise.all(dtos.map((d) => refreshTokenIfNeeded(db, d)));
    },

    async findByProvider(
      provider: string,
      providerOpenid: string
    ): Promise<SocialAccountDTO | null> {
      const record = (await db.findOne({
        model: "socialAccount",
        where: [
          { field: "provider", value: provider },
          { field: "providerOpenid", value: providerOpenid },
        ],
      })) as Record<string, unknown> | null;
      if (!record) return null;
      return toDTO(record);
    },
  };
}
