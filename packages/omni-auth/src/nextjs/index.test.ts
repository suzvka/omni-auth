import { describe, it, expect, vi } from "vitest";

// createQuickAuth 顶层 import next/headers，测试环境 mock 掉
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import { createQuickAuth } from "./index";
import type { DatabaseAdapter } from "../adapters/database";

function createInMemoryDb(): DatabaseAdapter {
  const store = new Map<string, Map<string, Record<string, unknown>>>();

  function ensureModel(model: string) {
    if (!store.has(model)) store.set(model, new Map());
    return store.get(model)!;
  }

  return {
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
    async findMany({ model, where }) {
      const table = ensureModel(model);
      const results: Record<string, unknown>[] = [];
      for (const [, r] of table) {
        if (!where || where.every((w) => r[w.field] === w.value)) results.push(r);
      }
      return results;
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
}

const MINIMAL_CONFIG = {
  secret: "0123456789abcdef0123456789abcdef",
  baseUrl: "http://localhost:3000",
};

describe("createQuickAuth", () => {
  it("以函数形式向 better-auth 传递 CustomAdapter 桥接（full 模式兼容）", async () => {
    const auth = createQuickAuth({
      database: createInMemoryDb(),
      ...MINIMAL_CONFIG,
    });

    const dbOption = (auth.betterAuth.options as { database?: unknown }).database;
    // 核心回归：better-auth@1.6.26 full 模式仅接受函数形式，
    // 对象形式会走 Kysely 路径抛出 "Failed to initialize database adapter"
    expect(typeof dbOption).toBe("function");

    // 触发 better-auth 初始化，验证不再抛错
    await expect(auth.betterAuth.$context).resolves.toBeDefined();
  });

  it("声明式配置路径同样能完成初始化", async () => {
    const auth = createQuickAuth({
      database: { url: "postgres://localhost:5432/db" },
      ...MINIMAL_CONFIG,
    });
    await expect(auth.betterAuth.$context).resolves.toBeDefined();
  });
});
