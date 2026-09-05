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
 * - TDefault：是否声明了 default（phantom，由 default() 提升为 true）
 */
export class ColumnBuilder<
  T extends ColumnType = ColumnType,
  TRequired extends boolean = boolean,
  TDefault extends boolean = boolean,
  TTs extends unknown = Record<string, unknown>
> {
  constructor(public _def: ColumnDef<T>) {}

  notNull(): ColumnBuilder<T, true, TDefault, TTs> {
    this._def.required = true;
    return this as unknown as ColumnBuilder<T, true, TDefault, TTs>;
  }

  unique(): this {
    this._def.unique = true;
    return this;
  }

  default(value: unknown): ColumnBuilder<T, TRequired, true, TTs> {
    this._def.default = value;
    return this as unknown as ColumnBuilder<T, TRequired, true, TTs>;
  }

  primaryKey(): ColumnBuilder<T, true, TDefault, TTs> {
    this._def.primaryKey = true;
    this._def.required = true;
    return this as unknown as ColumnBuilder<T, true, TDefault, TTs>;
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
/**
 * jsonb 列。
 *
 * 通过泛型参数声明值的 TS 形状（如 `jsonb<string[]>()`），驱动 InferSelect /
 * InferInsert 推导准确类型；不带参数时默认为 `Record<string, unknown>`。
 * SQL 类型恒为 JSONB，与 TS 形状无关。
 */
export const jsonb = <TTs extends unknown = Record<string, unknown>>(): ColumnBuilder<
  "jsonb",
  boolean,
  boolean,
  TTs
> => new ColumnBuilder({ type: "jsonb" });
export const timestamptz = (): ColumnBuilder<"timestamptz"> =>
  new ColumnBuilder({ type: "timestamptz" });
export const timestamp = (): ColumnBuilder<"timestamp"> =>
  new ColumnBuilder({ type: "timestamp" });

// ----------------------------------------------------------
// 表定义
// ----------------------------------------------------------

export type AnyColumnBuilder = ColumnBuilder<any, any, any, any>;

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

type IsRequired<T extends AnyColumnBuilder> = T extends ColumnBuilder<any, infer R, any>
  ? R extends true
    ? true
    : false
  : false;

type HasDefault<T extends AnyColumnBuilder> = T extends ColumnBuilder<any, any, infer D>
  ? D extends true
    ? true
    : false
  : false;

/** 列的 TS 值类型（jsonb 取泛型声明的形状，其余查 TypeMap） */
type ColumnTsType<T extends AnyColumnBuilder> = T extends ColumnBuilder<
  "jsonb",
  any,
  any,
  infer TTs
>
  ? TTs
  : TypeMap[T["_def"]["type"]];

/** 推断 SELECT 返回类型（全字段，required 非空，optional 可 null） */
export type InferSelect<T extends TableDef> = {
  [K in keyof T["columns"]]: IsRequired<T["columns"][K]> extends true
    ? ColumnTsType<T["columns"][K]>
    : ColumnTsType<T["columns"][K]> | null;
};

// ----------------------------------------------------------
// INSERT 类型推断
// ----------------------------------------------------------

/** INSERT 时省略的系统字段（由调用方或 DB 默认值生成） */
type SystemKeys = "id" | "createdAt" | "updatedAt";

/** 折叠交叉类型，便于阅读与断言 */
type Prettify<T> = { [K in keyof T]: T[K] } & {};

/** INSERT 必填列：NOT NULL 且无 default 的非系统字段 */
type InsertRequiredKeys<T extends TableDef> = {
  [K in keyof T["columns"]]: K extends SystemKeys
    ? never
    : IsRequired<T["columns"][K]> extends true
      ? HasDefault<T["columns"][K]> extends true
        ? never
        : K
      : never;
}[keyof T["columns"]];

/** INSERT 可选列：其余非系统字段（可空列或有默认值的列） */
type InsertOptionalKeys<T extends TableDef> = {
  [K in keyof T["columns"]]: K extends SystemKeys
    ? never
    : K extends InsertRequiredKeys<T>
      ? never
      : K;
}[keyof T["columns"]];

/**
 * 推断 INSERT 输入类型。
 *
 * 省略系统字段 id/createdAt/updatedAt；NOT NULL 且无默认值的列必填，
 * 可空列与带默认值的列可选。
 */
export type InferInsert<T extends TableDef> = Prettify<
  { [K in InsertRequiredKeys<T>]: ColumnTsType<T["columns"][K]> } & {
    [K in InsertOptionalKeys<T>]?: ColumnTsType<T["columns"][K]> | null;
  }
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
