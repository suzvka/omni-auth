// ============================================================
// SCIM User handler 单测（mock DatabaseAdapter + 依赖服务）
//
// 覆盖 userName 唯一键纠正后的核心语义：
// - userName 恒投影服务端 id（唯一键本质：唯一 + 不可变）
// - 名字写入诉求与唯一键解耦：displayName 优先，缺失时 userName 兜底落 name 列
// - SCIM 是目录生命周期入口：无 emails/渠道概念，不产生渠道绑定
// - userName filter 精确匹配 id；未声明属性不参与匹配
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { createScimUserHandler } from "./handler";
import { ScimError } from "./types";
import type { DatabaseAdapter } from "../adapters/database";
import type { UserAdminService } from "../core/user-admin";
import type { SessionService } from "../core/session";
import type { OAuthServerService } from "../oauth/server";

function createMockDb() {
  const db = {
    create: vi.fn(async (params: { model: string; data: Record<string, unknown> }) => ({
      id: "id-1",
      ...params.data,
    })),
    findOne: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    updateOne: vi.fn(async () => ({})),
    deleteOne: vi.fn(async () => null),
    deleteMany: vi.fn(async () => 0),
    count: vi.fn(async () => 0),
    transaction: vi.fn(async <T>(fn: (tx: DatabaseAdapter) => Promise<T>) => fn(db)),
  } as unknown as DatabaseAdapter & {
    findOne: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  return db;
}

function createHandler(db: DatabaseAdapter) {
  const users = {
    createUser: vi.fn(async (params: Record<string, unknown>) => ({
      userId: "u-1",
      user: { id: "u-1" },
    })),
    getUserEmail: vi.fn(async () => null),
  } as unknown as UserAdminService;

  const oauth = {
    verifyClientAccessToken: vi.fn(async () => ({ userId: "client-1" })),
    getClientById: vi.fn(async () => ({ id: "client-1", status: "active" })),
  } as unknown as OAuthServerService;

  const sessions = {} as unknown as SessionService;

  const handler = createScimUserHandler({ db, users, oauth, sessions });
  return { handler, users };
}

/** 返回 user 行（findOne 兜底） */
function mockUserRow(db: DatabaseAdapter, overrides: Record<string, unknown> = {}) {
  (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "u-1",
    name: "",
    active: 1,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  });
}

describe("createScimUserHandler.create", () => {
  it("displayName 优先：仅写 name 列，不产生任何渠道绑定，userName 恒为 id", async () => {
    const db = createMockDb();
    const { handler, users } = createHandler(db);
    mockUserRow(db, { name: "张三" });

    const result = await handler.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "zhangsan",
      displayName: "张三",
      active: true,
    });

    const createArgs = (users.createUser as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createArgs).toEqual(
      expect.objectContaining({ name: "张三", source: "scim" })
    );
    // 无 email 渠道概念：不向 createUser 传 email
    expect(createArgs).not.toHaveProperty("email");

    expect(result.userName).toBe("u-1");
    expect(result.displayName).toBe("张三");
    // 响应为纯目录条目：无 emails 等渠道投影字段
    expect(result).not.toHaveProperty("emails");
  });

  it("仅 userName：落入 name 列（名字写入诉求与唯一键解耦）", async () => {
    const db = createMockDb();
    const { handler, users } = createHandler(db);
    mockUserRow(db, { name: "zhangsan" });

    const result = await handler.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "zhangsan",
    });

    const createArgs = (users.createUser as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createArgs).toEqual(expect.objectContaining({ name: "zhangsan" }));
    expect(createArgs).not.toHaveProperty("email");
    expect(result.userName).toBe("u-1");
    expect(result.displayName).toBe("zhangsan");
  });

  it("两者均不提供：name 空串创建成功，userName 仍为服务端 id", async () => {
    const db = createMockDb();
    const { handler, users } = createHandler(db);
    mockUserRow(db);

    const result = await handler.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    });

    const createArgs = (users.createUser as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createArgs).toEqual(expect.objectContaining({ name: "" }));
    expect(result.userName).toBe("u-1");
    expect(result).not.toHaveProperty("displayName");
  });

  it("createUser 抛“已被注册”→ ScimError 409（catch 防御分支）", async () => {
    const db = createMockDb();
    const { handler, users } = createHandler(db);
    (users.createUser as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("该邮箱已被注册"));

    await expect(
      handler.create({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        displayName: "新用户",
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("createUser 抛未知错误 → ScimError 500", async () => {
    const db = createMockDb();
    const { handler, users } = createHandler(db);
    (users.createUser as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));

    await expect(
      handler.create({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        displayName: "新用户",
      })
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe("createScimUserHandler 投影与查询", () => {
  it("get：userName 恒为服务端 id（与名字属性无关）", async () => {
    const db = createMockDb();
    const { handler } = createHandler(db);
    mockUserRow(db, { name: "张三" });

    const result = await handler.get("u-1");
    expect(result.id).toBe("u-1");
    expect(result.userName).toBe("u-1");
    expect(result.displayName).toBe("张三");
    expect(result).not.toHaveProperty("emails");
  });

  it("list：userName eq 精确匹配 id（唯一键语义）", async () => {
    const db = createMockDb();
    const { handler } = createHandler(db);
    (db.findMany as ReturnType<typeof vi.fn>).mockImplementation(async (params: {
      model: string;
    }) => {
      if (params.model === "user") return [{ id: "u-1", name: "张三", active: 1 }];
      return [];
    });
    (db.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await handler.list({
      pagination: { startIndex: 1, count: 20 },
      filter: { field: "userName", value: "u-1" },
    });

    const userQuery = (db.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(userQuery.where).toEqual([{ field: "id", value: "u-1" }]);
    expect(result.totalResults).toBe(1);
    expect(result.resources[0].userName).toBe("u-1");
  });

  it("list：未声明属性（emails 等）的 filter 不参与匹配，返回全量", async () => {
    const db = createMockDb();
    const { handler } = createHandler(db);
    (db.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "u-1", name: "张三", active: 1 },
      { id: "u-2", name: "李四", active: 1 },
    ]);
    (db.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);

    const result = await handler.list({
      pagination: { startIndex: 1, count: 20 },
      filter: { field: "emails", value: "x@example.com" },
    });

    const userQuery = (db.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(userQuery.where).toBeUndefined();
    expect(result.totalResults).toBe(2);
  });

  it("ScimError 可序列化（409 冲突响应形状）", () => {
    const err = new ScimError("该邮箱已被注册", 409);
    expect(err.toJSON()).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail: "该邮箱已被注册",
      status: 409,
    });
  });
});
