// ============================================================
// SCIM User handler — 框架无关的用户目录 CRUD
//
// 迁移自宿主 user_center 的 lib/scim/user.ts 与
// app/api/scim/v2/Users/* route 的业务逻辑。
// 宿主 route 仅负责 HTTP 参数解析与 JSON 响应（薄壳）。
// ============================================================

import type { DatabaseAdapter, WhereCondition } from "../adapters/database";
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
  /** 列表（分页 + userName eq 过滤） */
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
  /** 数据库用户行（user 表）→ SCIM 资源（目录条目：仅身份与状态，无渠道概念） */
  function toScimUser(dbUser: Record<string, unknown>): ScimUser {
    const createdAt = dbUser.createdAt
      ? new Date(String(dbUser.createdAt)).toISOString()
      : new Date().toISOString();
    const updatedAt = dbUser.updatedAt
      ? new Date(String(dbUser.updatedAt)).toISOString()
      : createdAt;

    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: String(dbUser.id),
      // userName 承载唯一键本质（协议要求 required + 全局唯一 + 不可变），恒投影服务端 id；
      // 名字写入诉求由 displayName（name 列）独立满足，二者解耦（对齐 OIDC sub/name 分工）
      userName: String(dbUser.id),
      ...(dbUser.name ? { displayName: String(dbUser.name) } : {}),
      active: normalizeUserFlag(dbUser.active, true),
      meta: {
        resourceType: "User",
        created: createdAt,
        lastModified: updatedAt,
      },
    };
  }

  function fromScimCreateRequest(req: ScimCreateUserRequest): { name: string } {
    // 客户端的写入名字诉求：displayName 优先，缺失时取 userName 兜底（不参与唯一性）
    return {
      name: (req.displayName ?? req.userName ?? "").trim(),
    };
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

      if (filter && filter.field === "userName") {
        // userName 是服务端 id 的投影（唯一键）：精确匹配 id 即完备
        where = [{ field: "id", value: filter.value }];
      }

      const totalResults = await deps.db.count({ model: "user", where });
      const rows = (await deps.db.findMany({
        model: "user",
        where,
        orderBy: { field: "createdAt", direction: "desc" },
        limit: pagination.count,
        offset,
      })) as Array<Record<string, unknown>>;

      const resources = rows.map((row) => toScimUser(row));

      return { resources, totalResults, pagination };
    },

    async get(id) {
      const row = await deps.db.findOne({
        model: "user",
        where: [{ field: "id", value: id }],
      });
      if (!row) throw notFound("User not found");

      return toScimUser(row as Record<string, unknown>);
    },

    async create(body) {
      const { name } = fromScimCreateRequest(body);

      try {
        const result = await deps.users.createUser({
          // SCIM 是目录生命周期入口，不管理登录渠道（渠道绑定走宿主渠道 API）
          name,
          active: typeof body.active === "boolean" ? body.active : true,
          source: "scim",
        });

        const row = await deps.db.findOne({
          model: "user",
          where: [{ field: "id", value: result.userId }],
        });
        return toScimUser(row as Record<string, unknown>);
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

      const row = await deps.db.findOne({
        model: "user",
        where: [{ field: "id", value: id }],
      });
      return toScimUser(row as Record<string, unknown>);
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
        } else {
          // add/remove 无可用路径（schemas 无 emails 等可增删属性）
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
      return toScimUser(row as Record<string, unknown>);
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
