import { describe, it, expect, vi, beforeEach } from "vitest";
import { createUserAdmin } from "./user-admin";
import type { DatabaseAdapter } from "../adapters/database";
import type { SessionService } from "./session";

// ------------------------------------------------------------
// 用户管理模块单测（mock DatabaseAdapter + SessionService）
// ------------------------------------------------------------

/** 可编程 mock 适配器：按调用记录返回，便于断言事务内级联顺序 */
function createMockAdapter() {
  const calls: Array<{ method: string; params: unknown }> = [];

  const db = {
    create: vi.fn(async (params: { model: string; data: Record<string, unknown> }) => {
      calls.push({ method: "create", params });
      return { id: `id-${calls.length}`, ...params.data };
    }),
    findOne: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    updateOne: vi.fn(async (params: unknown) => {
      calls.push({ method: "updateOne", params });
      return {};
    }),
    count: vi.fn(async () => 0),
    deleteOne: vi.fn(async () => null),
    deleteMany: vi.fn(async () => 0),
    transaction: vi.fn(async <T>(fn: (tx: DatabaseAdapter) => Promise<T>) => fn(db)),
  } as unknown as DatabaseAdapter & { calls: never };

  return { db, calls };
}

function createMockSessions() {
  const sessions = {
    createSession: vi.fn(),
    validateSession: vi.fn(),
    invalidateSession: vi.fn(),
    destroyUserSessions: vi.fn(async () => {}),
    cleanupExpiredSessions: vi.fn(),
  } as unknown as SessionService;
  return sessions;
}

describe("createUserAdmin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("createUser：邮箱规范化 + 唯一性检查 + 包内事务创建 user+email 渠道", async () => {
    const { db, calls } = createMockAdapter();
    const sessions = createMockSessions();
    const admin = createUserAdmin(db, sessions);

    // 邮箱唯一性检查：findOne(socialAccount) 返回 null（未注册）
    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await admin.createUser({
      email: "  Foo@Example.COM ",
      name: "Foo",
      password: "secret-123",
      source: "admin",
    });

    expect(result.userId).toBeTruthy();
    // 事务内两次 create：user + socialAccount(email 渠道)
    const creates = calls.filter((c) => c.method === "create");
    expect(creates.length).toBe(2);
    const userCreate = creates[0].params as { model: string; data: Record<string, unknown> };
    expect(userCreate.model).toBe("user");
    expect(userCreate.data.emailVerified).toBe(0);
    expect(userCreate.data.active).toBe(1);
    const channelCreate = creates[1].params as { model: string; data: Record<string, unknown> };
    expect(channelCreate.model).toBe("socialAccount");
    // 邮箱已规范化（小写去空格）
    expect(channelCreate.data.providerOpenid).toBe("foo@example.com");
  });

  it("createUser：邮箱已注册时抛错且不落库", async () => {
    const { db } = createMockAdapter();
    const sessions = createMockSessions();
    const admin = createUserAdmin(db, sessions);

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: "other-user",
    });

    await expect(
      admin.createUser({ email: "taken@example.com", name: "T", password: "x", source: "admin" })
    ).rejects.toThrow("该邮箱已被注册");
    expect(db.create).not.toHaveBeenCalled();
  });

  it("updateUser：更新 name/emailVerified/active 并写入 user 表", async () => {
    const { db } = createMockAdapter();
    const sessions = createMockSessions();
    const admin = createUserAdmin(db, sessions);

    await admin.updateUser("u-1", { name: "NewName", emailVerified: true, active: false });

    const updateCall = (db.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      model: string;
      update: Record<string, unknown>;
    };
    expect(updateCall.model).toBe("user");
    expect(updateCall.update.name).toBe("NewName");
    expect(updateCall.update.emailVerified).toBe(1);
    expect(updateCall.update.active).toBe(0);
  });

  it("updateUser：active=false 时级联吊销该用户全部会话（禁用即时生效）", async () => {
    const { db } = createMockAdapter();
    const sessions = createMockSessions();
    const admin = createUserAdmin(db, sessions);

    await admin.updateUser("u-1", { active: false });

    expect(sessions.destroyUserSessions).toHaveBeenCalledWith("u-1");
  });

  it("updateUser：active 未变更时不吊销会话", async () => {
    const { db } = createMockAdapter();
    const sessions = createMockSessions();
    const admin = createUserAdmin(db, sessions);

    await admin.updateUser("u-1", { name: "OnlyName" });

    expect(sessions.destroyUserSessions).not.toHaveBeenCalled();
  });

  it("updatePassword：哈希写库 + 吊销全部会话（改密强制重新登录）", async () => {
    const { db } = createMockAdapter();
    const sessions = createMockSessions();
    const admin = createUserAdmin(db, sessions);

    await admin.updatePassword("u-1", "new-password-123");

    const updateCall = (db.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      model: string;
      update: Record<string, unknown>;
    };
    expect(updateCall.model).toBe("user");
    // 密码必须哈希后入库（不存明文）
    expect(updateCall.update.password).not.toBe("new-password-123");
    expect(String(updateCall.update.password).length).toBeGreaterThan(20);
    expect(sessions.destroyUserSessions).toHaveBeenCalledWith("u-1");
  });

  it("getUser：组装 id/name/emailVerified/active/channels", async () => {
    const { db } = createMockAdapter();
    const sessions = createMockSessions();
    const admin = createUserAdmin(db, sessions);

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u-1",
      name: "Foo",
      emailVerified: 1,
      active: 1,
    });
    (db.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "c-1", provider: "email", providerOpenid: "foo@example.com" },
    ]);

    const user = await admin.getUser("u-1");

    expect(user).toMatchObject({
      id: "u-1",
      name: "Foo",
      emailVerified: true,
      active: true,
      channels: [
        expect.objectContaining({
          id: "c-1",
          provider: "email",
          providerOpenid: "foo@example.com",
        }),
      ],
    });
  });

  it("getUser：用户不存在返回 null", async () => {
    const { db } = createMockAdapter();
    const sessions = createMockSessions();
    const admin = createUserAdmin(db, sessions);

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    expect(await admin.getUser("ghost")).toBeNull();
  });

  it("deleteUser：单事务级联删除 session/socialAccount/oauthToken/user", async () => {
    const { db } = createMockAdapter();
    const sessions = createMockSessions();
    const admin = createUserAdmin(db, sessions);

    await admin.deleteUser("u-1");

    // transaction 透传执行：事务回调内按序执行 4 个删除
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const delMany = (db.deleteMany as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as { model: string }).model
    );
    expect(delMany).toEqual(["session", "socialAccount", "oauthToken"]);
    const delOne = (db.deleteOne as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as { model: string }).model
    );
    expect(delOne).toEqual(["user"]);
  });

  it("deleteUsers：逐个删除并统计成功/失败", async () => {
    const { db } = createMockAdapter();
    const sessions = createMockSessions();
    const admin = createUserAdmin(db, sessions);

    // 第二次 deleteUser 抛错（模拟其中一个删除失败）
    (db.deleteOne as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("boom"));

    const result = await admin.deleteUsers(["u-1", "u-2"]);

    expect(result).toEqual({ deleted: 1, failed: 1 });
  });

  it("findUserByEmail：经 email 渠道反查 userId", async () => {
    const { db } = createMockAdapter();
    const sessions = createMockSessions();
    const admin = createUserAdmin(db, sessions);

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: "u-42",
    });

    expect(await admin.findUserByEmail("Foo@Example.com")).toBe("u-42");
    // 查询按规范化邮箱执行
    const where = (db.findOne as ReturnType<typeof vi.fn>).mock.calls[0][0].where as Array<{
      field: string;
      value: string;
    }>;
    expect(where).toContainEqual({ field: "provider", value: "email" });
    expect(where).toContainEqual({ field: "providerOpenid", value: "foo@example.com" });
  });
});
