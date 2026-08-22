import { describe, it, expect, expectTypeOf } from "vitest";
import {
  table,
  text,
  boolean,
  integer,
  jsonb,
  timestamptz,
  defineSchema,
} from "./schema-builder";
import type { InferSelect } from "./schema-builder";

// ----------------------------------------------------------
// DSL 行为
// ----------------------------------------------------------

describe("Schema DSL（schema-builder）", () => {
  it("builder 方法正确设置 ColumnDef", () => {
    const col = text().notNull().unique().default("x");
    expect(col._def).toEqual({
      type: "text",
      required: true,
      unique: true,
      default: "x",
    });

    const pk = text().primaryKey();
    expect(pk._def.primaryKey).toBe(true);
    expect(pk._def.required).toBe(true);

    const fk = text().notNull().references("user", { onDelete: "cascade" });
    expect(fk._def.relation).toEqual({
      model: "user",
      onDelete: "cascade",
    });
  });

  it("table() 组装 TableDef 并保留 uniqueConstraints", () => {
    const t = table("demo", { a: text() }, { uniqueConstraints: [["a"]] });
    expect(t.name).toBe("demo");
    expect(Object.keys(t.columns)).toEqual(["a"]);
    expect(t.uniqueConstraints).toEqual([["a"]]);
  });

  it("defineSchema 原样返回传入对象", () => {
    const s = defineSchema({ a: table("a", { id: text().primaryKey() }) });
    expect(s.a.name).toBe("a");
  });
});

// ----------------------------------------------------------
// 类型推断（编译期）
// ----------------------------------------------------------

describe("InferSelect 类型推断", () => {
  const demo = table("demo", {
    id: text().primaryKey(),
    name: text().notNull(),
    nickname: text(),
    active: boolean().notNull(),
    score: integer(),
    profile: jsonb().notNull(),
    tags: jsonb<string[]>().notNull(),
    createdAt: timestamptz().notNull(),
    deletedAt: timestamptz(),
  });

  type DemoRow = InferSelect<typeof demo>;

  it("required 字段非空，optional 字段可 null", () => {
    expectTypeOf<DemoRow["id"]>().toEqualTypeOf<string>();
    expectTypeOf<DemoRow["name"]>().toEqualTypeOf<string>();
    expectTypeOf<DemoRow["nickname"]>().toEqualTypeOf<string | null>();
    expectTypeOf<DemoRow["active"]>().toEqualTypeOf<boolean>();
    expectTypeOf<DemoRow["score"]>().toEqualTypeOf<number | null>();
    expectTypeOf<DemoRow["profile"]>().toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf<DemoRow["createdAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<DemoRow["deletedAt"]>().toEqualTypeOf<Date | null>();
  });

  it("jsonb<T>() 泛型：推导指定值形状（默认仍为 Record）", () => {
    // 显式形状：推导为 string[]
    expectTypeOf<DemoRow["tags"]>().toEqualTypeOf<string[]>();
    // 无泛型参数：保持 Record<string, unknown> 默认
    expectTypeOf<DemoRow["profile"]>().toEqualTypeOf<Record<string, unknown>>();
  });
});
