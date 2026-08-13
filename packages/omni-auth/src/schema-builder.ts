// ============================================================
// Schema DSL — 表结构定义的单一事实源
//
// 提供 Drizzle 风格的轻量 builder：
//   table("user", { id: text().primaryKey(), ... })
//
// 由 schema.ts 使用此 DSL 定义表，由此派生：
// 1. TypeScript 行类型（InferSelect）
// 2. SQL DDL（codegen-ddl.ts）
// 3. Prisma schema（codegen-prisma.ts）
// ============================================================

// ----------------------------------------------------------
// 列定义
// ----------------------------------------------------------

export type ColumnType =
  | "text"
  | "boolean"
  | "integer"
  | "jsonb"
  | "timestamptz"
  | "timestamp";

export interface ColumnDef<T extends ColumnType = ColumnType> {
  type: T;
  required?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  default?: unknown;
  relation?: {
    model: string;
    onDelete?: "cascade" | "set null" | "restrict";
  };
}

/**
 * 列 builder。
 *
 * 类型参数：
 * - T：列类型字面量（"text" 等），驱动 TypeMap 推断
 * - TRequired：NOT NULL 标志（phantom，由 notNull()/primaryKey() 提升为 true）
 */
export class ColumnBuilder<
  T extends ColumnType = ColumnType,
  TRequired extends boolean = boolean
> {
  constructor(public _def: ColumnDef<T>) {}

  notNull(): ColumnBuilder<T, true> {
    this._def.required = true;
    return this as unknown as ColumnBuilder<T, true>;
  }

  unique(): this {
    this._def.unique = true;
    return this;
  }

  default(value: unknown): this {
    this._def.default = value;
    return this;
  }

  primaryKey(): ColumnBuilder<T, true> {
    this._def.primaryKey = true;
    this._def.required = true;
    return this as unknown as ColumnBuilder<T, true>;
  }

  references(
    model: string,
    opts?: { onDelete?: "cascade" | "set null" | "restrict" }
  ): this {
    this._def.relation = { model, onDelete: opts?.onDelete };
    return this;
  }
}

// ----------------------------------------------------------
// 列类型工厂
// ----------------------------------------------------------

export const text = (): ColumnBuilder<"text"> =>
  new ColumnBuilder({ type: "text" });
export const boolean = (): ColumnBuilder<"boolean"> =>
  new ColumnBuilder({ type: "boolean" });
export const integer = (): ColumnBuilder<"integer"> =>
  new ColumnBuilder({ type: "integer" });
export const jsonb = (): ColumnBuilder<"jsonb"> =>
  new ColumnBuilder({ type: "jsonb" });
export const timestamptz = (): ColumnBuilder<"timestamptz"> =>
  new ColumnBuilder({ type: "timestamptz" });
export const timestamp = (): ColumnBuilder<"timestamp"> =>
  new ColumnBuilder({ type: "timestamp" });

// ----------------------------------------------------------
// 表定义
// ----------------------------------------------------------

export type AnyColumnBuilder = ColumnBuilder<any, any>;

export interface TableDef<
  TColumns extends Record<string, AnyColumnBuilder> = Record<string, AnyColumnBuilder>
> {
  name: string;
  columns: TColumns;
  uniqueConstraints?: string[][];
}

export interface TableOptions {
  uniqueConstraints?: string[][];
}

export function table<TColumns extends Record<string, AnyColumnBuilder>>(
  name: string,
  columns: TColumns,
  opts?: TableOptions
): TableDef<TColumns> {
  return {
    name,
    columns,
    uniqueConstraints: opts?.uniqueConstraints,
  };
}

// ----------------------------------------------------------
// 类型推断
// ----------------------------------------------------------

type TypeMap = {
  text: string;
  boolean: boolean;
  integer: number;
  jsonb: Record<string, unknown>;
  timestamptz: Date;
  timestamp: Date;
};

type IsRequired<T extends AnyColumnBuilder> = T extends ColumnBuilder<any, infer R>
  ? R extends true
    ? true
    : false
  : false;

/** 推断 SELECT 返回类型（全字段，required 非空，optional 可 null） */
export type InferSelect<T extends TableDef> = {
  [K in keyof T["columns"]]: IsRequired<T["columns"][K]> extends true
    ? TypeMap[T["columns"][K]["_def"]["type"]]
    : TypeMap[T["columns"][K]["_def"]["type"]] | null;
};

/** 推断 INSERT 输入类型（省略系统字段 id/createdAt/updatedAt） */
export type InferInsert<T extends TableDef> = Partial<
  Omit<InferSelect<T>, "id" | "createdAt" | "updatedAt">
>;

// ----------------------------------------------------------
// Schema 容器
// ----------------------------------------------------------

export interface Schema {
  [key: string]: TableDef;
}

export function defineSchema<T extends Schema>(tables: T): T {
  return tables;
}
