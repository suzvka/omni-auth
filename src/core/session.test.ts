import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionService, SESSION_TTL_MS } from "./session";
import type { DatabaseAdapter } from "../adapters/database";

// ------------------------------------------------------------
// 会话模块单测（mock DatabaseAdapter，不连真实数据库）
//
// 钉死单令牌共享模型不变式：同一用户至多一枚令牌，
// 有效即复用（多设备共享）、过期才重铸、吊销级联。
// ------------------------------------------------------------

/** 内存版 mock 适配器：真实记录增删查语义，upsert 模拟 ON CONFLICT DO UPDATE ... WHERE */
function createMemoryAdapter() {
  const store = new Map<string, Record<string, unknown>>();
  let keySeq = 0;

  // 条件匹配：支持 eq（默认）与 lt（会话过期判定 / cleanup 用）
  function matches(
    rec: Record<string, unknown>,
    conds: Array<{ field: string; value: unknown; operator?: string }>
  ): boolean {
    return conds.every((c) => {
      const op = c.operator ?? "eq";
      if (op === "lt") {
        return new Date(rec[c.field] as string | number | Date).getTime() <
          new Date(c.value as string | number | Date).getTime();
      }
      return rec[c.field] === c.value;
    });
  }

  const db = {
    create: vi.fn(async (params: { model: string; data: Record<string, unknown> }) => {
      const id = `rec-${++keySeq}`;
      store.set(id, { id, ...params.data });
      return store.get(id);
    }),
    findOne: vi.fn(
      async (params: { model: string; where: Array<{ field: string; value: unknown }> }) => {
        for (const rec of store.values()) {
          if (matches(rec, params.where)) return rec;
        }
        return null;
      }
    ),
    deleteOne: vi.fn(async (params: { model: string; where: Array<{ field: string; value: unknown }> }) => {
      for (const [key, rec] of store.entries()) {
        if (matches(rec, params.where)) {
          store.delete(key);
          return rec;
        }
      }
      return null;
    }),
    deleteMany: vi.fn(async (params: { model: string; where: Array<{ field: string; value: unknown }> }) => {
      let deleted = 0;
      for (const [key, rec] of store.entries()) {
        if (matches(rec, params.where)) {
          store.delete(key);
          deleted++;
        }
      }
      return deleted;
    }),
    upsert: vi.fn(
      async (params: {
        model: string;
        data: Record<string, unknown>;
        conflictOn: string[];
        update: Record<string, unknown>;
        where?: Array<{ field: string; value: unknown; operator?: string }>;
      }) => {
        for (const rec of store.values()) {
          if (params.conflictOn.every((f) => rec[f] === params.data[f])) {
            // 冲突：条件不满足则跳过更新（对应 SQL 的无 RETURNING 行）
            if (params.where && params.where.length > 0 && !matches(rec, params.where)) {
              return null;
            }
            Object.assign(rec, params.update);
            return rec;
          }
        }
        const id = `rec-${++keySeq}`;
        store.set(id, { id, ...params.data });
        return store.get(id);
      }
    ),
  } as unknown as DatabaseAdapter;

  return { db, store };
}

describe("createSessionService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("getOrCreateSession：首次铸造写入一行并返回 token/expiresAt（默认 7 天）", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const result = await svc.getOrCreateSession("u-1");

    expect(result.token).toBeTruthy();
    const ttl = result.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(SESSION_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_MS);
    expect(store.size).toBe(1);
    const rec = [...store.values()][0];
    expect(rec.userId).toBe("u-1");
    expect(rec.token).toBe(result.token);
  });

  it("getOrCreateSession：既有令牌有效 → 复用同一枚（多设备共享），不重铸、不新增行", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const first = await svc.getOrCreateSession("u-1");
    const second = await svc.getOrCreateSession("u-1");

    expect(second.token).toBe(first.token);
    expect(second.expiresAt.getTime()).toBe(first.expiresAt.getTime());
    expect(store.size).toBe(1);
  });

  it("getOrCreateSession：既有令牌已过期 → 重铸（令牌更新、过期时间前移、仍为单行）", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const expired = await svc.getOrCreateSession("u-1", { ttlMs: -1000 });
    const fresh = await svc.getOrCreateSession("u-1");

    expect(fresh.token).not.toBe(expired.token);
    expect(fresh.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(store.size).toBe(1);
  });

  it("getUserSession：有效会话返回 {token, expiresAt}", async () => {
    const { db } = createMemoryAdapter();
    const svc = createSessionService(db);

    const { token } = await svc.getOrCreateSession("u-1");
    await db.create({ model: "user", data: { id: "u-1", active: 1 } });

    const current = await svc.getUserSession("u-1");
    expect(current?.token).toBe(token);
    expect(current?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("getUserSession：无会话返回 null", async () => {
    const { db } = createMemoryAdapter();
    const svc = createSessionService(db);

    expect(await svc.getUserSession("no-such-user")).toBeNull();
  });

  it("getUserSession：过期视为无会话（纯读——不删行、不重铸）", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const { token } = await svc.getOrCreateSession("u-1", { ttlMs: -1000 });

    expect(await svc.getUserSession("u-1")).toBeNull();
    expect([...store.values()].some((r) => r.token === token)).toBe(true);
  });

  it("getUserSession：账号禁用（active=0）视为无会话", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const { token } = await svc.getOrCreateSession("u-1");
    await db.create({ model: "user", data: { id: "u-1", active: 0 } });

    expect(await svc.getUserSession("u-1")).toBeNull();
    // 纯读：会话行销毁由 validateSession / 管理链路承担
    expect([...store.values()].some((r) => r.token === token)).toBe(true);
  });

  it("validateSession：有效会话返回 userId", async () => {
    const { db } = createMemoryAdapter();
    const svc = createSessionService(db);

    const { token } = await svc.getOrCreateSession("u-1");
    // 用户存在且 active
    await db.create({
      model: "user",
      data: { id: "u-1", active: 1 },
    });

    expect(await svc.validateSession(token)).toBe("u-1");
  });

  it("validateSession：token 不存在返回 null", async () => {
    const { db } = createMemoryAdapter();
    const svc = createSessionService(db);

    expect(await svc.validateSession("no-such-token")).toBeNull();
  });

  it("validateSession：过期会话被销毁并返回 null", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const { token } = await svc.getOrCreateSession("u-1", { ttlMs: -1000 }); // 已过期
    await db.create({ model: "user", data: { id: "u-1", active: 1 } });

    expect(await svc.validateSession(token)).toBeNull();
    // 会话已销毁（user 记录保留）
    expect([...store.values()].some((r) => r.token === token)).toBe(false);
  });

  it("validateSession：账号禁用（active=0）即时失效并销毁会话", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const { token } = await svc.getOrCreateSession("u-1");
    await db.create({ model: "user", data: { id: "u-1", active: 0 } });

    expect(await svc.validateSession(token)).toBeNull();
    expect([...store.values()].some((r) => r.token === token)).toBe(false);
  });

  it("validateSession：用户不存在时销毁会话并返回 null", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const { token } = await svc.getOrCreateSession("ghost-user");

    expect(await svc.validateSession(token)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("destroyUserSessions：级联销毁用户全部会话（登出/禁用/删用户场景）", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    await svc.getOrCreateSession("u-1");
    await svc.getOrCreateSession("u-2");

    await svc.destroyUserSessions("u-1");

    expect(store.size).toBe(1); // 仅剩 u-2 的会话
    expect([...store.values()][0].userId).toBe("u-2");
  });

  it("cleanupExpiredSessions：清理全部过期会话（定时任务）", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    await svc.getOrCreateSession("u-1", { ttlMs: -1000 }); // 过期
    const { token: validToken } = await svc.getOrCreateSession("u-2"); // 有效

    await svc.cleanupExpiredSessions();

    // 过期会话被删除，有效会话保留
    const remaining = [...store.values()].map((r) => r.token);
    expect(remaining).toEqual([validToken]);
  });

  it("适配器未实现 upsert：构造期 fail-fast（单令牌原子性依赖）", () => {
    expect(() => createSessionService({} as DatabaseAdapter)).toThrow(/upsert/);
  });
});
