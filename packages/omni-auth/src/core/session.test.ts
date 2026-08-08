import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSessionManagement } from "./session";
import { UnauthorizedError } from "../errors";
import type { DatabaseAdapter } from "../adapters/database";

// Reuse in-memory DB (same pattern as social service test)
function createInMemoryDb(): DatabaseAdapter {
  const store = new Map<string, Map<string, Record<string, unknown>>>();

  function ensureModel(model: string): Map<string, Record<string, unknown>> {
    if (!store.has(model)) store.set(model, new Map());
    return store.get(model)!;
  }

  return {
    async create({ model, data }) {
      const table = ensureModel(model);
      const id = (data.id as string) ?? String(Math.random());
      const record = { ...data, id, createdAt: new Date(), updatedAt: new Date() };
      table.set(id, record);
      return record;
    },
    async findOne({ model, where }) {
      const table = ensureModel(model);
      for (const [, r] of table) {
        if (where.every((w) => r[w.field] === w.value)) return r;
      }
      return null;
    },
    async findMany({ model, where, limit, offset }) {
      const table = ensureModel(model);
      const results: Record<string, unknown>[] = [];
      for (const [, r] of table) {
        if (!where || where.every((w) => {
          if (w.operator === "neq") return r[w.field] !== w.value;
          return r[w.field] === w.value;
        })) results.push(r);
      }
      let sliced = results;
      if (offset) sliced = sliced.slice(offset);
      if (limit) sliced = sliced.slice(0, limit);
      return sliced;
    },
    async updateOne({ model, where, update }) {
      const table = ensureModel(model);
      for (const [, r] of table) {
        if (where.every((w) => r[w.field] === w.value)) {
          Object.assign(r, update, { updatedAt: new Date() });
          return r;
        }
      }
      throw new Error("Not found");
    },
    async updateMany({ model, where, update }) {
      const table = ensureModel(model);
      let c = 0;
      for (const [, r] of table) {
        if (where.every((w) => {
          if (w.operator === "neq") return r[w.field] !== w.value;
          return r[w.field] === w.value;
        })) { Object.assign(r, update); c++; }
      }
      return c;
    },
    async deleteOne({ model, where }) {
      const table = ensureModel(model);
      for (const [id, r] of table) {
        if (where.every((w) => r[w.field] === w.value)) { table.delete(id); return r; }
      }
      throw new Error("Not found");
    },
    async deleteMany({ model, where }) {
      const table = ensureModel(model);
      let c = 0;
      const del: string[] = [];
      for (const [id, r] of table) {
        if (where.every((w) => {
          if (w.operator === "neq") return r[w.field] !== w.value;
          return r[w.field] === w.value;
        })) del.push(id);
      }
      del.forEach((id) => { table.delete(id); c++; });
      return c;
    },
  };
}

function mockBetterAuth(userId: string | null, currentToken?: string) {
  return {
    api: {
      getSession: vi.fn().mockImplementation(async () => {
        if (!userId) return null;
        return {
          user: { id: userId, email: "test@test.com" },
          session: { token: currentToken ?? "current_session_token" },
        };
      }),
    },
  } as any;
}

describe("createSessionManagement", () => {
  let db: DatabaseAdapter;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  // ---- listSessions ----

  describe("listSessions", () => {
    it("未登录时应抛 UnauthorizedError", async () => {
      const auth = mockBetterAuth(null);
      const mgr = createSessionManagement({ auth, db });
      await expect(mgr.listSessions({} as any)).rejects.toThrow(UnauthorizedError);
    });

    it("应列出当前用户的所有 session", async () => {
      // 创建一些 session 记录
      await db.create({ model: "session", data: {
        id: "s1", userId: "u1", token: "tok1", expiresAt: new Date("2026-12-31"), createdAt: new Date(), ipAddress: "1.1.1.1",
      }});
      await db.create({ model: "session", data: {
        id: "s2", userId: "u1", token: "tok2", expiresAt: new Date("2026-12-31"), createdAt: new Date(),
      }});
      await db.create({ model: "session", data: {
        id: "s3", userId: "u2", token: "tok3", expiresAt: new Date("2026-12-31"), createdAt: new Date(),
      }});

      const auth = mockBetterAuth("u1", "tok1");
      const mgr = createSessionManagement({ auth, db });
      const sessions = await mgr.listSessions({} as any);

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.userId)).toEqual(["u1", "u1"]);
    });

    it("应标记当前 session 的 isCurrent 为 true", async () => {
      await db.create({ model: "session", data: {
        id: "s1", userId: "u1", token: "current_tok", expiresAt: new Date("2026-12-31"), createdAt: new Date(),
      }});
      await db.create({ model: "session", data: {
        id: "s2", userId: "u1", token: "other_tok", expiresAt: new Date("2026-12-31"), createdAt: new Date(),
      }});

      const auth = mockBetterAuth("u1", "current_tok");
      const mgr = createSessionManagement({ auth, db });
      const sessions = await mgr.listSessions({} as any);

      const current = sessions.find((s) => s.token === "current_tok");
      const other = sessions.find((s) => s.token === "other_tok");
      expect(current?.isCurrent).toBe(true);
      expect(other?.isCurrent).toBe(false);
    });
  });

  // ---- revokeSession ----

  describe("revokeSession", () => {
    it("应吊销指定 session", async () => {
      await db.create({ model: "session", data: {
        id: "s1", userId: "u1", token: "tok_to_revoke", expiresAt: new Date("2026-12-31"), createdAt: new Date(),
      }});

      const auth = mockBetterAuth("u1");
      const mgr = createSessionManagement({ auth, db });

      await mgr.revokeSession({} as any, "s1");

      const found = await db.findOne({ model: "session", where: [{ field: "id", value: "s1" }] });
      expect(found).toBeNull();
    });

    it("吊销他人的 session 应抛 UnauthorizedError", async () => {
      await db.create({ model: "session", data: {
        id: "s2", userId: "u2", token: "other_tok", expiresAt: new Date("2026-12-31"), createdAt: new Date(),
      }});

      const auth = mockBetterAuth("u1");
      const mgr = createSessionManagement({ auth, db });

      await expect(mgr.revokeSession({} as any, "s2")).rejects.toThrow(UnauthorizedError);
    });

    it("吊销不存在的 session 应抛异常", async () => {
      const auth = mockBetterAuth("u1");
      const mgr = createSessionManagement({ auth, db });

      await expect(mgr.revokeSession({} as any, "nonexistent")).rejects.toThrow("Session 不存在");
    });
  });

  // ---- revokeAllSessions ----

  describe("revokeAllSessions", () => {
    it("应吊销除当前 session 外的所有 session", async () => {
      await db.create({ model: "session", data: {
        id: "s1", userId: "u1", token: "current_tok", expiresAt: new Date("2026-12-31"), createdAt: new Date(),
      }});
      await db.create({ model: "session", data: {
        id: "s2", userId: "u1", token: "other_1", expiresAt: new Date("2026-12-31"), createdAt: new Date(),
      }});
      await db.create({ model: "session", data: {
        id: "s3", userId: "u1", token: "other_2", expiresAt: new Date("2026-12-31"), createdAt: new Date(),
      }});

      const auth = mockBetterAuth("u1", "current_tok");
      const mgr = createSessionManagement({ auth, db });

      const count = await mgr.revokeAllSessions({} as any);
      expect(count).toBe(2);

      // 当前 session 仍存在
      const current = await db.findOne({ model: "session", where: [{ field: "id", value: "s1" }] });
      expect(current).not.toBeNull();

      // 其他的被删除
      const s2 = await db.findOne({ model: "session", where: [{ field: "id", value: "s2" }] });
      expect(s2).toBeNull();
    });

    it("无其他 session 时返回 0", async () => {
      await db.create({ model: "session", data: {
        id: "s_only", userId: "u1", token: "only_tok", expiresAt: new Date("2026-12-31"), createdAt: new Date(),
      }});

      const auth = mockBetterAuth("u1", "only_tok");
      const mgr = createSessionManagement({ auth, db });

      const count = await mgr.revokeAllSessions({} as any);
      expect(count).toBe(0);
    });
  });
});
