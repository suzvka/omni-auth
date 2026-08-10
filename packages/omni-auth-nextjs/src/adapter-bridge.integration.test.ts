import { describe, it, expect, vi } from "vitest";

// createQuickAuth 顶层 import next/headers，测试环境 mock 掉
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import { createQuickAuth } from "./index";
import type { DatabaseAdapter } from "omni-auth";

// 完整内存数据库：记录所有模型（user/session/account/socialAccount/businessAccount）
function createInMemoryDb(): DatabaseAdapter & { dump(model: string): Record<string, unknown>[] } {
  const store = new Map<string, Map<string, Record<string, unknown>>>();

  function ensureModel(model: string) {
    if (!store.has(model)) store.set(model, new Map());
    return store.get(model)!;
  }

  const db: DatabaseAdapter = {
    async create({ model, data }) {
      const table = ensureModel(model);
      const id = (data.id as string) ?? String(Math.random());
      const record = { ...data, id };
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
        if (!where || where.every((w) => r[w.field] === w.value)) results.push(r);
      }
      const sliced = limit != null ? results.slice(0, limit) : results;
      return offset != null ? sliced.slice(offset) : sliced;
    },
    async count({ model, where }) {
      const table = ensureModel(model);
      let n = 0;
      for (const [, r] of table) {
        if (!where || where.every((w) => r[w.field] === w.value)) n++;
      }
      return n;
    },
    async updateOne({ model, where, update }) {
      const table = ensureModel(model);
      for (const [, r] of table) {
        if (where.every((w) => r[w.field] === w.value)) {
          Object.assign(r, update);
          return r;
        }
      }
      return null;
    },
    async updateMany({ model, where, update }) {
      const table = ensureModel(model);
      let n = 0;
      for (const [, r] of table) {
        if (!where || where.every((w) => r[w.field] === w.value)) {
          Object.assign(r, update);
          n++;
        }
      }
      return n;
    },
    async deleteOne({ model, where }) {
      const table = ensureModel(model);
      for (const [id, r] of table) {
        if (where.every((w) => r[w.field] === w.value)) {
          table.delete(id);
          return r;
        }
      }
      return null;
    },
    async deleteMany({ model, where }) {
      const table = ensureModel(model);
      let n = 0;
      for (const [id, r] of [...table]) {
        if (!where || where.every((w) => r[w.field] === w.value)) {
          table.delete(id);
          n++;
        }
      }
      return n;
    },
  };

  return {
    ...db,
    dump(model: string) {
      return [...ensureModel(model).values()];
    },
  };
}

const AUTH_CONFIG = {
  secret: "0123456789abcdef0123456789abcdef",
  baseUrl: "http://localhost:3000",
};

describe("bridge join 支持（better-auth 1.6.26 密码存 account 表）", () => {
  it("signUp 将密码 hash 写入 account 表（providerId=credential）", async () => {
    const memDb = createInMemoryDb();
    const auth = createQuickAuth({ database: memDb, ...AUTH_CONFIG });

    const res = await auth.betterAuth.api.signUpEmail({
      body: { email: "test@test.local", password: "password123", name: "Tester" },
    });

    expect(res.token).toBeTruthy();
    const accounts = memDb.dump("account");
    expect(accounts.length).toBe(1);
    expect(accounts[0].providerId).toBe("credential");
    expect(accounts[0].password).toBeTruthy(); // 密码 hash 已存储
  });

  it("signUp 后 signIn 校验密码成功（回归：join 忽略导致登录 100% 失败）", async () => {
    const memDb = createInMemoryDb();
    const auth = createQuickAuth({ database: memDb, ...AUTH_CONFIG });

    await auth.betterAuth.api.signUpEmail({
      body: { email: "test@test.local", password: "password123", name: "Tester" },
    });

    const res = await auth.betterAuth.api.signInEmail({
      body: { email: "test@test.local", password: "password123" },
    });
    expect(res.token).toBeTruthy();
  });

  it("signIn 密码错误时拒绝", async () => {
    const memDb = createInMemoryDb();
    const auth = createQuickAuth({ database: memDb, ...AUTH_CONFIG });

    await auth.betterAuth.api.signUpEmail({
      body: { email: "test@test.local", password: "password123", name: "Tester" },
    });

    await expect(
      auth.betterAuth.api.signInEmail({
        body: { email: "test@test.local", password: "wrong-password" },
      })
    ).rejects.toThrow();
  });

  it("getSession 通过 token 还原完整 user（session join user）", async () => {
    const memDb = createInMemoryDb();
    const auth = createQuickAuth({ database: memDb, ...AUTH_CONFIG });

    const { token } = await auth.betterAuth.api.signUpEmail({
      body: { email: "test@test.local", password: "password123", name: "Tester" },
    });

    // Better Auth 要求 cookie 值为带 HMAC 签名的 token（rawToken.signature）
    const signedToken = auth.signSessionToken(token!);
    const session = await auth.betterAuth.api.getSession({
      headers: { cookie: `better-auth.session_token=${signedToken}` },
    });
    expect(session?.user?.email).toBe("test@test.local");
  });
});
