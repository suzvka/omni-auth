// ============================================================
// SCIM User handler — 框架无关的用户目录 CRUD
//
// 迁移自宿主 user_center 的 lib/scim/user.ts 与
// app/api/scim/v2/Users/* route 的业务逻辑。
// 宿主 route 仅负责 HTTP 参数解析与 JSON 响应（薄壳）。
// ============================================================

import type { DatabaseAdapter, WhereCondition } from "../adapters/database";
import { createSocialService } from "../social/service";
import type { UserAdminService } from "../core/user-admin";
import type { SessionService } from "../core/session";
import type { OAuthServerService } from "../oauth/server";
import { normalizeUserFlag } from "../core/session";
import {
  ScimError,
  notFound,
  invalidValue,
  invalidSyntax,
  conflict,
  unauthorized,
  type ScimUser,
  type ScimCreateUserRequest,
  type ScimPatchRequest,
  type PaginationParams,
} from "./types";

export interface ScimUserHandler {
  /** 校验 Bearer token（client_credentials），返回 client_id */
  authenticate(request: Request): Promise<string>;
  /** 列表（分页 + userName/emails eq 过滤） */
  list(params: {
    pagination: PaginationParams;
    filter: { field: string; value: string } | null;
  }): Promise<{ resources: ScimUser[]; totalResults: number; pagination: PaginationParams }>;
  /** 按 id 查询 */
  get(id: string): Promise<ScimUser>;
  /** 创建用户 */
  create(body: ScimCreateUserRequest): Promise<ScimUser>;
  /** 全量替换（PUT 语义） */
  update(id: string, body: Record<string, unknown>): Promise<ScimUser>;
  /** 部分更新（PATCH 语义） */
  patch(id: string, body: ScimPatchRequest): Promise<ScimUser>;
  /** 删除用户（级联清理，包内事务） */
  remove(id: string): Promise<void>;
}

export function createScimUserHandler(deps: {
  db: DatabaseAdapter;
  users: UserAdminService;
  oauth: OAuthServerService;
  sessions: SessionService;
}): ScimUserHandler {
  const social = createSocialService(deps.db);

  /** 数据库用户行（user 表）+ email → SCIM 资源 */
  function toScimUser(
    dbUser: Record<string, unknown>,
    email: string | null
  ): ScimUser {
    const createdAt = dbUser.createdAt
      ? new Date(String(dbUser.createdAt)).toISOString()
      : new Date().toISOString();
    const updatedAt = dbUser.updatedAt
      ? new Date(String(dbUser.updatedAt)).toISOString()
      : createdAt;

    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: String(dbUser.id),
      userName: email ?? String(dbUser.id),
      ...(dbUser.name ? { displayName: String(dbUser.name) } : {}),
      ...(email ? { emails: [{ value: email, primary: true }] } : {}),
      active: normalizeUserFlag(dbUser.active, true),
      meta: {
        resourceType: "User",
        created: createdAt,
        lastModified: updatedAt,
      },
    };
  }

  function fromScimCreateRequest(req: ScimCreateUserRequest): {
    name: string | null;
    email: string | null;
  } {
    return {
      name: req.displayName ?? null,
      email: req.emails?.[0]?.value ?? req.userName ?? null,
    };
  }

  /** 更新 email 渠道（显式提供时更新，缺失时保留） */
  async function upsertEmailChannel(
    userId: string,
    email: string | undefined
  ): Promise<void> {
    if (email === undefined) return;
    const normalized = email.toLowerCase().trim();

    const channels = await social.listByUser(userId);
    const emailChannel = channels.find((c) => c.provider === "email");
    if (emailChannel) {
      await deps.db.updateOne({
        model: "socialAccount",
        where: [{ field: "id", value: emailChannel.id }],
        update: { providerOpenid: normalized },
      });
    } else {
      await social.bindToUser(userId, {
        provider: "email",
        providerOpenid: normalized,
        valid: 1,
        allowPasswordUpdate: 1,
        allowVerification: 1,
      });
    }
  }

  /** 按 email 过滤时反查 userId 集合（含 id 直配的兼容语义） */
  async function findUserIdsByEmail(email: string): Promise<string[]> {
    const rows = (await deps.db.findMany({
      model: "socialAccount",
      where: [{ field: "provider", value: "email" }],
      search: { fields: ["providerOpenid"], value: email },
      limit: 10000,
    })) as Array<{ userId: string }>;
    return rows.map((r) => r.userId);
  }

  return {
    async authenticate(request) {
      const authHeader = request.headers.get("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        throw unauthorized("Missing or invalid Authorization header");
      }

      const token = authHeader.slice(7);
      const result = await deps.oauth.verifyClientAccessToken(token);
      if (!result) {
        throw unauthorized("Token expired or revoked");
      }

      // 回查 client.status（result.userId 实际是 client_id）
      const client = await deps.oauth.getClientById(result.userId);
      if (!client || client.status !== "active") {
        throw unauthorized("Client is not active");
      }

      return result.userId;
    },

    async list({ pagination, filter }) {
      const offset = pagination.startIndex - 1;
      let where: WhereCondition[] | undefined;

      if (filter && (filter.field === "userName" || filter.field === "emails" || filter.field === "emails.value")) {
        const ids = await findUserIdsByEmail(filter.value);
        // userName 语义 = email 渠道标识；命中集合为空时返回空列表
        where = [{ field: "id", operator: "in", value: ids }];
      }

      const totalResults = await deps.db.count({ model: "user", where });
      const rows = (await deps.db.findMany({
        model: "user",
        where,
        orderBy: { field: "createdAt", direction: "desc" },
        limit: pagination.count,
        offset,
      })) as Array<Record<string, unknown>>;

      // 批量取 email（消除 N+1）
      const userIds = rows.map((r) => String(r.id));
      const emailMap = new Map<string, string | null>();
      if (userIds.length > 0) {
        const emailRows = (await deps.db.findMany({
          model: "socialAccount",
          where: [
            { field: "provider", value: "email" },
            { field: "userId", operator: "in", value: userIds },
          ],
          limit: 10000,
        })) as Array<{ userId: string; providerOpenid: string }>;
        for (const row of emailRows) {
          emailMap.set(row.userId, row.providerOpenid);
        }
      }

      const resources = rows.map((row) =>
        toScimUser(row, emailMap.get(String(row.id)) ?? null)
      );

      return { resources, totalResults, pagination };
    },

    async get(id) {
      const row = await deps.db.findOne({
        model: "user",
        where: [{ field: "id", value: id }],
      });
      if (!row) throw notFound("User not found");

      const email = await deps.users.getUserEmail(id);
      return toScimUser(row as Record<string, unknown>, email);
    },

    async create(body) {
      const { name, email } = fromScimCreateRequest(body);

      try {
        const result = await deps.users.createUser({
          email: email ?? `${body.userName}@scim.local`,
          name: name ?? body.userName,
          active: typeof body.active === "boolean" ? body.active : true,
          source: "scim",
        });

        const row = await deps.db.findOne({
          model: "user",
          where: [{ field: "id", value: result.userId }],
        });
        return toScimUser(row as Record<string, unknown>, email);
      } catch (err) {
        if (err instanceof ScimError) throw err;
        const message = err instanceof Error ? err.message : "Internal server error";
        if (message.includes("已被注册")) {
          throw conflict(message);
        }
        throw new ScimError(message, 500);
      }
    },

    async update(id, body) {
      const displayName = body.displayName as string | undefined;
      const emails = body.emails as Array<{ value: string }> | undefined;
      const email = emails?.[0]?.value as string | undefined;
      const active = body.active as boolean | undefined;

      const existing = await deps.db.findOne({
        model: "user",
        where: [{ field: "id", value: id }],
      });
      if (!existing) throw notFound("User not found");

      // 全量替换：缺失的可写字段重置为默认值（displayName → null，active → true）
      await deps.db.updateOne({
        model: "user",
        where: [{ field: "id", value: id }],
        update: {
          name: displayName ?? null,
          active: typeof active === "boolean" ? (active ? 1 : 0) : 1,
        },
      });

      if (active === false) {
        await deps.sessions.destroyUserSessions(id);
      }

      // emails 为受保护字段：显式提供时更新，缺失时保留（登录标识）
      await upsertEmailChannel(id, email);

      const row = await deps.db.findOne({
        model: "user",
        where: [{ field: "id", value: id }],
      });
      const updatedEmail = await deps.users.getUserEmail(id);
      return toScimUser(row as Record<string, unknown>, updatedEmail);
    },

    async patch(id, body) {
      if (!body.Operations?.length) {
        throw invalidValue("At least one operation is required");
      }

      const existing = await deps.db.findOne({
        model: "user",
        where: [{ field: "id", value: id }],
      });
      if (!existing) throw notFound("User not found");

      const updates: Record<string, unknown> = {};
      let deactivated = false;

      for (const op of body.Operations) {
        if (op.op === "replace") {
          if (op.path === "active") {
            updates.active = op.value === false ? 0 : 1;
            if (op.value === false) deactivated = true;
          } else if (op.path === "displayName") {
            updates.name = op.value;
          } else if (op.path === undefined && typeof op.value === "object" && op.value !== null) {
            const val = op.value as Record<string, unknown>;
            if (val.displayName !== undefined) {
              updates.name = val.displayName;
            }
            if (val.active !== undefined) {
              updates.active = val.active === false ? 0 : 1;
              if (val.active === false) deactivated = true;
            }
          }
        } else if (op.op === "add" && op.path === "emails") {
          const newEmail = (op.value as { value?: string })?.value;
          if (newEmail) {
            await upsertEmailChannel(id, newEmail);
          }
        } else if (op.op === "remove") {
          if (op.path === "emails" || op.path === "emails.value") {
            const channels = await social.listByUser(id);
            const emailChannel = channels.find((c) => c.provider === "email");
            if (emailChannel) {
              await social.unbindFromUser(emailChannel.id);
            }
          }
        } else {
          throw invalidSyntax(`Unsupported operation: ${op.op}`);
        }
      }

      if (Object.keys(updates).length > 0) {
        await deps.db.updateOne({
          model: "user",
          where: [{ field: "id", value: id }],
          update: updates,
        });
      }

      if (deactivated) {
        await deps.sessions.destroyUserSessions(id);
      }

      const row = await deps.db.findOne({
        model: "user",
        where: [{ field: "id", value: id }],
      });
      const email = await deps.users.getUserEmail(id);
      return toScimUser(row as Record<string, unknown>, email);
    },

    async remove(id) {
      const existing = await deps.db.findOne({
        model: "user",
        where: [{ field: "id", value: id }],
      });
      if (!existing) throw notFound("User not found");

      await deps.users.deleteUser(id);
    },
  };
}
