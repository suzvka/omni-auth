import { describe, it, expect, expectTypeOf } from "vitest";
import { createDbFacade } from "./models";
import type { UserRow, SocialAccountRow, AccountRow } from "./models";
import type { DatabaseAdapter, WhereCondition } from "./adapters/database";

// ----------------------------------------------------------
// 内存数据库（复用各模块测试的惯用实现）
// ----------------------------------------------------------

function createInMemoryDb(): DatabaseAdapter {
  const store = new Map<string, Map<string, Record<string, unknown>>>();

  function ensureModel(model: string) {
    if (!store.has(model)) store.set(model, new Map());
    return store.get(model)!;
  }

  function matchWhere(record: Record<string, unknown>, where: WhereCondition[]): boolean {
    return where.every((w) => {
      const val = record[w.field];
      switch (w.operator) {
        case "neq":
          return val !== w.value;
        case "in":
          return Array.isArray(w.value) && w.value.includes(val);
        case "lt":
          return Number(val) < Number(w.value);
        case "gt":
          return Number(val) > Number(w.value);
        case "lte":
          return Number(val) <= Number(w.value);
        case "gte":
          return Number(val) >= Number(w.value);
        default:
          return val === w.value;
      }
    });
  }

  let nextId = 1;
  const now = () => new Date();

  return {
    async create({ model, data }) {
      const table = ensureModel(model);
      const id = (data.id as string) ?? String(nextId++);
      const record = { ...data, id, createdAt: now(), updatedAt: now() };
      table.set(id, record);
      return record;
    },

    async findOne({ model, where }) {
      const table = ensureModel(model);
      for (const [, record] of table) {
        if (matchWhere(record, where)) return record;
      }
      return null;
    },

    async findMany({ model, where, limit, offset }) {
      const table = ensureModel(model);
      const results: Record<string, unknown>[] = [];
      for (const [, record] of table) {
        if (!where || matchWhere(record, where)) results.push(record);
      }
      let sliced = results;
      if (offset) sliced = sliced.slice(offset);
      if (limit) sliced = sliced.slice(0, limit);
      return sliced;
    },

    async count({ model, where }) {
      const table = ensureModel(model);
      let n = 0;
      for (const [, record] of table) {
        if (!where || matchWhere(record, where)) n++;
      }
      return n;
    },

    async updateOne({ model, where, update }) {
      const table = ensureModel(model);
      for (const [, record] of table) {
        if (matchWhere(record, where)) {
          Object.assign(record, update, { updatedAt: now() });
          return record;
        }
      }
      return null;
    },

    async updateMany({ model, where, update }) {
      const table = ensureModel(model);
      let n = 0;
      for (const [, record] of table) {
        if (matchWhere(record, where)) {
          Object.assign(record, update);
          n++;
        }
      }
      return n;
    },

    async deleteOne({ model, where }) {
      const table = ensureModel(model);
      for (const [id, record] of table) {
        if (matchWhere(record, where)) {
          table.delete(id);
          return record;
        }
      }
      return null;
    },

    async deleteMany({ model, where }) {
      const table = ensureModel(model);
      const toDelete: string[] = [];
      for (const [id, record] of table) {
        if (matchWhere(record, where)) toDelete.push(id);
      }
      for (const id of toDelete) table.delete(id);
      return toDelete.length;
    },
  };
}

// ----------------------------------------------------------
// 测试
// ----------------------------------------------------------

describe("createDbFacade（类型化表视图）", () => {
  const adapter = createInMemoryDb();
  const db = createDbFacade(adapter);

  it("user 视图：create / findOne / findMany / count 全链路", async () => {
    const created = await db.user.create({
      data: { name: "张三", email: "a@b.c" },
    });
    expect(created.id).toBeDefined();
    expect(created.email).toBe("a@b.c");

    const found = await db.user.findOne({
      where: [{ field: "email", value: "a@b.c" }],
    });
    expect(found?.name).toBe("张三");

    const many = await db.user.findMany({});
    expect(many).toHaveLength(1);

    const total = await db.user.count({});
    expect(total).toBe(1);
  });

  it("socialAccount 视图：更新 / 删除 / 返回行形状", async () => {
    await db.socialAccount.create({
      data: { userId: "u1", provider: "wechat", providerOpenid: "openid-1" },
    });

    const updated = await db.socialAccount.updateOne({
      where: [{ field: "providerOpenid", value: "openid-1" }],
      update: { valid: 1 },
    });
    expect(updated?.valid).toBe(1);

    const deleted = await db.socialAccount.deleteOne({
      where: [{ field: "providerOpenid", value: "openid-1" }],
    });
    expect(deleted?.provider).toBe("wechat");
    expect(await db.socialAccount.count({})).toBe(0);
  });

  it("account 视图可用", async () => {
    await db.account.create({
      data: { userId: "u1", providerId: "credential", accountId: "u1" },
    });
    expect(
      await db.account.findOne({ where: [{ field: "providerId", value: "credential" }] })
    ).not.toBeNull();
  });

  it("弃用的泛型方法仍可委托", async () => {
    const row = await db.findOne({ model: "user", where: [] });
    expect(row).not.toBeNull();
  });
});

describe("类型化表视图（编译期断言）", () => {
  const adapter = createInMemoryDb();
  const db = createDbFacade(adapter);

  it("返回类型映射到行类型", async () => {
    const one = await db.user.findOne({ where: [{ field: "id", value: "1" }] });
    expectTypeOf(one).toEqualTypeOf<UserRow | null>();

    const many = await db.user.findMany({});
    expectTypeOf(many).toEqualTypeOf<UserRow[]>();

    const social = await db.socialAccount.findOne({
      where: [{ field: "providerOpenid", value: "x" }],
    });
    expectTypeOf(social).toEqualTypeOf<SocialAccountRow | null>();

    expectTypeOf(await db.account.count({})).toEqualTypeOf<number>();

    const created = await db.account.create({
      data: { userId: "u1", providerId: "credential", accountId: "u1" },
    });
    expectTypeOf(created).toEqualTypeOf<AccountRow>();
    expectTypeOf(created.providerId).toEqualTypeOf<string>();
  });

  it("未声明的列名在编译期报错（负向用例）", async () => {
    // @ts-expect-error "role" 不是 user 表的列（声明式 schema 中不存在）
    await db.user.create({ data: { role: "user" } });

    // @ts-expect-error "emial" 拼写错误，不在 user 列名中
    await db.user.findOne({ where: [{ field: "emial", value: "x" }] });

    // @ts-expect-error 未声明的表名不可访问
    db.notATable;
  });
});
