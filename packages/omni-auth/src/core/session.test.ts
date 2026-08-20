import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionService, SESSION_TTL_MS } from "./session";
import type { DatabaseAdapter } from "../adapters/database";

// ------------------------------------------------------------
// 会话模块单测（mock DatabaseAdapter，不连真实数据库）
// ------------------------------------------------------------

/** 内存版 mock 适配器：真实记录增删查语义，便于断言级联行为 */
function createMemoryAdapter() {
  const store = new Map<string, Record<string, unknown>>();
  let keySeq = 0;

  // 条件匹配：支持 eq（默认）与 lt（cleanupExpiredSessions 用）
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
    transaction: vi.fn(async <T>(fn: (tx: DatabaseAdapter) => Promise<T>) => fn(db)),
  } as unknown as DatabaseAdapter;

  return { db, store };
}

describe("createSessionService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("createSession：写入 session 记录并返回 token/expiresAt（默认 7 天）", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const result = await svc.createSession("u-1");

    expect(result.token).toBeTruthy();
    const ttl = result.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(SESSION_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_MS);
    expect(store.size).toBe(1);
    const rec = [...store.values()][0];
    expect(rec.userId).toBe("u-1");
    expect(rec.token).toBe(result.token);
  });

  it("validateSession：有效会话返回 userId", async () => {
    const { db } = createMemoryAdapter();
    const svc = createSessionService(db);

    const { token } = await svc.createSession("u-1");
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

    const { token } = await svc.createSession("u-1", { ttlMs: -1000 }); // 已过期
    await db.create({ model: "user", data: { id: "u-1", active: 1 } });

    expect(await svc.validateSession(token)).toBeNull();
    // 会话已销毁（user 记录保留）
    expect([...store.values()].some((r) => r.token === token)).toBe(false);
  });

  it("validateSession：账号禁用（active=0）即时失效并销毁会话", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const { token } = await svc.createSession("u-1");
    await db.create({ model: "user", data: { id: "u-1", active: 0 } });

    expect(await svc.validateSession(token)).toBeNull();
    expect([...store.values()].some((r) => r.token === token)).toBe(false);
  });

  it("validateSession：用户不存在时销毁会话并返回 null", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const { token } = await svc.createSession("ghost-user");

    expect(await svc.validateSession(token)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("invalidateSession：按 token 销毁单条会话", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    const { token } = await svc.createSession("u-1");
    await svc.invalidateSession(token);

    expect(store.size).toBe(0);
  });

  it("destroyUserSessions：级联销毁用户全部会话（禁用/删用户场景）", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    await svc.createSession("u-1");
    await svc.createSession("u-1");
    await svc.createSession("u-2");

    await svc.destroyUserSessions("u-1");

    expect(store.size).toBe(1); // 仅剩 u-2 的会话
  });

  it("cleanupExpiredSessions：清理全部过期会话（定时任务）", async () => {
    const { db, store } = createMemoryAdapter();
    const svc = createSessionService(db);

    await svc.createSession("u-1", { ttlMs: -1000 }); // 过期
    const { token: validToken } = await svc.createSession("u-2"); // 有效

    await svc.cleanupExpiredSessions();

    // 过期会话被删除，有效会话保留
    const remaining = [...store.values()].map((r) => r.token);
    expect(remaining).toEqual([validToken]);
  });
});
