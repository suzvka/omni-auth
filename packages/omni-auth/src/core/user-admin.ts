// ============================================================
// 用户管理 API — 认证域私有（宿主请使用 auth.users.* 语义 API）
//
// 迁移自宿主 user_center 的 user-service.ts / user-lifecycle.ts：
// - 邮箱唯一性 / 规范化 / 渠道更新逻辑收敛到包内
// - active 成为包内用户元数据（API 数据契约）
// - 删除用户的级联规则（session / socialAccount / oauthToken / user）
//   在包内单事务闭环，宿主不再编排
// ============================================================

import { randomUUID } from "crypto";
import { hashPassword } from "@better-auth/utils/password";
import type { DatabaseAdapter } from "../adapters/database";
import { withTransaction } from "../adapters/database";
import { createSocialService } from "../social/service";
import { normalizeUserFlag, type SessionService } from "./session";

export interface CreateUserParams {
  /** 邮箱（可选：提供时绑定 email 渠道；渠道化模型下邮箱无特殊地位） */
  email?: string;
  name: string;
  password?: string;
  active?: boolean;
  source: "self" | "admin" | "scim";
}

export interface UpdateUserParams {
  name?: string;
  email?: string;
  active?: boolean;
}

export interface UserView {
  id: string;
  name: string;
  active: boolean;
  channels: unknown[];
}

export interface UserListItem {
  id: string;
  name: string | null;
  email: string | null;
  active: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date | null;
  _count: { accounts: number; sessions: number };
}

export interface ListUsersParams {
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface UserAdminService {
  createUser(params: CreateUserParams): Promise<{ userId: string; user: unknown }>;
  updateUser(userId: string, params: UpdateUserParams): Promise<void>;
  /** 修改用户密码（哈希后写入，并吊销该用户全部会话） */
  updatePassword(userId: string, newPassword: string): Promise<void>;
  getUser(userId: string): Promise<UserView | null>;
  listUsers(params: ListUsersParams): Promise<{
    users: UserListItem[];
    total: number;
    page: number;
    pageSize: number;
  }>;
  deleteUser(userId: string): Promise<void>;
  deleteUsers(userIds: string[]): Promise<{ deleted: number; failed: number }>;
  getUserEmail(userId: string): Promise<string | null>;
  findUserByEmail(email: string): Promise<string | null>;
}

/** 规范化邮箱地址（lowercase + trim） */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUserAdmin(
  db: DatabaseAdapter,
  sessions: SessionService
): UserAdminService {
  const social = createSocialService(db);

  async function listUserEmails(
    userIds: string[]
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = (await db.findMany({
      model: "socialAccount",
      where: [
        { field: "provider", value: "email" },
        { field: "userId", operator: "in", value: userIds },
      ],
      limit: 10000,
    })) as Array<{ userId: string; providerOpenid: string }>;
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.userId, row.providerOpenid);
    }
    return map;
  }

  return {
    async createUser(params) {
      const hashedPassword = await hashPassword(params.password ?? randomUUID());
      const userId = randomUUID();
      const now = new Date();

      // email 唯一性检查（唯一约束在事务内兜底；未提供时跳过渠道绑定）
      const email = params.email ? normalizeEmail(params.email) : undefined;
      if (email) {
        const existing = await social.findByProvider("email", email);
        if (existing) {
          throw new Error("该邮箱已被注册");
        }
      }

      // 创建 user +（可选）email 渠道（包内事务，与 signUp 同构）
      await withTransaction(db, async (tx) => {
        const dbf = tx;
        await dbf.create({
          model: "user",
          data: {
            id: userId,
            name: params.name,
            password: hashedPassword,
            image: null,
            active: params.active === false ? 0 : 1,
            createdAt: now,
            updatedAt: now,
          },
        });

        if (email) {
          await createSocialService(tx).bindToUser(userId, {
            provider: "email",
            providerOpenid: email,
            valid: 1,
            allowPasswordUpdate: 1,
            allowVerification: 1,
          });
        }
      });

      return { userId, user: { id: userId, name: params.name } };
    },

    async updateUser(userId, params) {
      const updates: Record<string, unknown> = {};

      if (params.name !== undefined) {
        updates.name = params.name.trim();
      }

      // email 更新（含唯一性检查 + 渠道更新）
      if (params.email !== undefined) {
        const normalizedEmail = normalizeEmail(params.email);

        const existing = await social.findByProvider("email", normalizedEmail);
        if (existing && existing.userId !== userId) {
          throw new Error("该邮箱已被其他用户占用");
        }

        const channels = await social.listByUser(userId);
        const emailChannel = channels.find((c) => c.provider === "email");

        if (emailChannel) {
          await db.updateOne({
            model: "socialAccount",
            where: [{ field: "id", value: emailChannel.id }],
            update: { providerOpenid: normalizedEmail },
          });
        } else {
          await social.bindToUser(userId, {
            provider: "email",
            providerOpenid: normalizedEmail,
            valid: 1,
            allowPasswordUpdate: 1,
            allowVerification: 1,
          });
        }
      }

      if (params.active !== undefined) {
        updates.active = params.active ? 1 : 0;
      }

      if (Object.keys(updates).length > 0) {
        await db.updateOne({
          model: "user",
          where: [{ field: "id", value: userId }],
          update: updates,
        });

        // active → false 时级联吊销所有会话（禁用即时生效）
        if (params.active === false) {
          await sessions.destroyUserSessions(userId);
        }
      }
    },

    async updatePassword(userId, newPassword) {
      const hashedPassword = await hashPassword(newPassword);
      await db.updateOne({
        model: "user",
        where: [{ field: "id", value: userId }],
        update: { password: hashedPassword },
      });
      // 密码修改后吊销所有会话（含当前，需重新登录）
      await sessions.destroyUserSessions(userId);
    },

    async getUser(userId) {
      const user = await db.findOne({
        model: "user",
        where: [{ field: "id", value: userId }],
      });
      if (!user) return null;

      const record = user as Record<string, unknown>;
      const channels = await social.listByUser(userId);

      return {
        id: String(record.id),
        name: String(record.name),
        active: normalizeUserFlag(record.active, true),
        channels,
      };
    },

    async listUsers(params) {
      const page = Math.max(1, params.page ?? 1);
      const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
      const offset = (page - 1) * pageSize;
      const search = params.search?.trim() || "";

      let rows: Array<Record<string, unknown>>;
      let total: number;

      if (search) {
        // 搜索匹配 name / id（user 表）∪ email 渠道（socialAccount 表）
        const userHits = (await db.findMany({
          model: "user",
          search: { fields: ["name", "id"], value: search },
          limit: 10000,
        })) as Array<Record<string, unknown>>;

        const emailHits = (await db.findMany({
          model: "socialAccount",
          where: [{ field: "provider", value: "email" }],
          search: { fields: ["providerOpenid"], value: search },
          limit: 10000,
        })) as Array<{ userId: string }>;

        const byId = new Map<string, Record<string, unknown>>();
        for (const row of userHits) {
          byId.set(String(row.id), row);
        }
        for (const hit of emailHits) {
          const row = byId.get(hit.userId);
          if (!row) {
            const found = await db.findOne({
              model: "user",
              where: [{ field: "id", value: hit.userId }],
            });
            if (found) byId.set(hit.userId, found as Record<string, unknown>);
          }
        }

        rows = Array.from(byId.values()).sort((a, b) =>
          String(b.createdAt).localeCompare(String(a.createdAt))
        );
        total = rows.length;
        rows = rows.slice(offset, offset + pageSize);
      } else {
        total = await db.count({ model: "user" });
        rows = (await db.findMany({
          model: "user",
          orderBy: { field: "createdAt", direction: "desc" },
          limit: pageSize,
          offset,
        })) as Array<Record<string, unknown>>;
      }

      const userIds = rows.map((r) => String(r.id));
      const emailMap = await listUserEmails(userIds);

      const users: UserListItem[] = [];
      for (const row of rows) {
        const id = String(row.id);
        const accounts = await db.count({
          model: "socialAccount",
          where: [{ field: "userId", value: id }],
        });
        const sessions = await db.count({
          model: "session",
          where: [{ field: "userId", value: id }],
        });

        users.push({
          id,
          name: row.name ? String(row.name) : null,
          email: emailMap.get(id) ?? null,
          active: normalizeUserFlag(row.active, true),
          image: row.image ? String(row.image) : null,
          createdAt: new Date(String(row.createdAt)),
          updatedAt: row.updatedAt ? new Date(String(row.updatedAt)) : null,
          _count: { accounts, sessions },
        });
      }

      return { users, total, page, pageSize };
    },

    async deleteUser(userId) {
      // 级联删除（session / socialAccount / oauthToken / user）单事务闭环
      await withTransaction(db, async (tx) => {
        await tx.deleteMany({
          model: "session",
          where: [{ field: "userId", value: userId }],
        });
        await tx.deleteMany({
          model: "socialAccount",
          where: [{ field: "userId", value: userId }],
        });
        await tx.deleteMany({
          model: "oauthToken",
          where: [{ field: "user_id", value: userId }],
        });
        await tx.deleteOne({
          model: "user",
          where: [{ field: "id", value: userId }],
        });
      });
    },

    async deleteUsers(userIds) {
      let deleted = 0;
      let failed = 0;
      for (const userId of userIds) {
        try {
          await this.deleteUser(userId);
          deleted++;
        } catch (err) {
          failed++;
          console.error(`[omni-auth] 删除用户 ${userId} 失败:`, err);
        }
      }
      return { deleted, failed };
    },

    async getUserEmail(userId) {
      const channels = await social.listByUser(userId);
      const emailChannel = channels.find((c) => c.provider === "email");
      return emailChannel?.providerOpenid ?? null;
    },

    async findUserByEmail(email) {
      const normalizedEmail = normalizeEmail(email);
      const channel = await social.findByProvider("email", normalizedEmail);
      return channel?.userId ?? null;
    },
  };
}

export type { SessionService };

/** 社交渠道服务形状（包内复用） */
export type SocialService = ReturnType<typeof createSocialService>;
