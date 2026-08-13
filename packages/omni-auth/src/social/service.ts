// ============================================================
// 社交账户服务
//
// 框架无关，封装社交账户的绑定/解绑/查询/Token 刷新逻辑。
// 3.0.0 起数据访问走类型化门面；token refresher 经依赖注入
// （实例注册表），不再读取模块级全局表。
// ============================================================

import type { DatabaseAdapter } from "../adapters/database";
import type { SocialAccountDTO } from "./types";
import type { TokenRefresher, SocialAccountRef } from "./token";
import { SocialAccountConflictError, UniqueViolationError } from "../errors";
import { createDbFacade } from "../models";
import type { SocialAccountRow } from "../schema";

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

function toDTO(record: SocialAccountRow): SocialAccountDTO {
  return {
    id: record.id,
    userId: record.userId,
    provider: record.provider,
    providerOpenid: record.providerOpenid,
    accessToken: record.accessToken ?? null,
    refreshToken: record.refreshToken ?? null,
    tokenExpiresAt: record.tokenExpiresAt ?? null,
    profileData: parseProfileData(record.profileData),
    valid: record.valid ?? 0,
    allowPasswordUpdate: record.allowPasswordUpdate ?? 0,
    allowVerification: record.allowVerification ?? 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
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
  dto: SocialAccountDTO,
  getTokenRefresher?: (provider: string) => TokenRefresher | undefined
): Promise<SocialAccountDTO> {
  if (!dto.tokenExpiresAt) return dto;

  const bufferMs = 5 * 60 * 1000;
  if (dto.tokenExpiresAt.getTime() - bufferMs > Date.now()) {
    return dto;
  }

  const refresher = getTokenRefresher?.(dto.provider);
  if (!refresher) return dto;

  try {
    const result = await refresher(toSocialAccountRef(dto));
    const updated = await createDbFacade(db).socialAccount.updateOne({
      where: [{ field: "id", value: dto.id }],
      update: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? dto.refreshToken,
        tokenExpiresAt: result.expiresAt ?? dto.tokenExpiresAt,
      },
    });
    return updated ? toDTO(updated) : dto;
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

export interface SocialServiceOptions {
  /** token 刷新器查询（通常为实例注册表的闭包） */
  getTokenRefresher?: (provider: string) => TokenRefresher | undefined;
}

export function createSocialService(
  db: DatabaseAdapter,
  opts?: SocialServiceOptions
) {
  const dbf = createDbFacade(db);

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
      const existing = await dbf.socialAccount.findOne({
        where: [
          { field: "provider", value: input.provider },
          { field: "providerOpenid", value: input.providerOpenid },
        ],
      });

      if (existing) {
        throw new SocialAccountConflictError(
          input.provider,
          input.providerOpenid
        );
      }

      try {
        const record = await dbf.socialAccount.create({
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
                : null,
            profileData: input.profileData ?? {},
            valid: input.valid ?? 0,
            allowPasswordUpdate: input.allowPasswordUpdate ?? 0,
            allowVerification: input.allowVerification ?? 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        return toDTO(record);
      } catch (err) {
        // 并发绑定时预检查可能漏判，由唯一约束兜底并转译为冲突错误
        if (err instanceof UniqueViolationError) {
          throw new SocialAccountConflictError(
            input.provider,
            input.providerOpenid
          );
        }
        throw err;
      }
    },

    async unbindFromUser(id: string): Promise<void> {
      await dbf.socialAccount.deleteOne({
        where: [{ field: "id", value: id }],
      });
    },

    async listByUser(userId: string): Promise<SocialAccountDTO[]> {
      const records = await dbf.socialAccount.findMany({
        where: [{ field: "userId", value: userId }],
      });
      const dtos = records.map(toDTO);
      return Promise.all(
        dtos.map((d) => refreshTokenIfNeeded(db, d, opts?.getTokenRefresher))
      );
    },

    async findByProvider(
      provider: string,
      providerOpenid: string
    ): Promise<SocialAccountDTO | null> {
      const record = await dbf.socialAccount.findOne({
        where: [
          { field: "provider", value: provider },
          { field: "providerOpenid", value: providerOpenid },
        ],
      });
      if (!record) return null;
      return toDTO(record);
    },
  };
}
