// ============================================================
// Typed 数据访问门面
//
// 将 DatabaseAdapter 的字符串表名 / unknown 返回包装为
// 按表分组的类型化视图：
//
//   auth.db.user.findOne({ where: [{ field: "email", value }] })
//   // → UserRow | null（field 限定为 user 列名，编译期校验）
//
// 行类型由 schema.ts 的 DSL 派生（InferSelect），
// 修改表结构时只需改 schema.ts。
// 泛型方法（db.findOne({ model: "..." }) 等）保留但已弃用，
// 底层 DatabaseAdapter 作为 SPI 不变。
// ============================================================

import type {
  DatabaseAdapter,
  WhereCondition,
  SearchCondition,
  OrderByCondition,
} from "./adapters/database";
import type { UserRow, AccountRow, SocialAccountRow } from "./schema";

// Re-export 行类型（保持 index.ts 导入路径不变）
export type { UserRow, AccountRow, SocialAccountRow };

// ----------------------------------------------------------
// ModelMap：表名 → 行类型
// ----------------------------------------------------------

/** model 名 → 行类型 映射 */
export interface ModelMap {
  user: UserRow;
  account: AccountRow;
  socialAccount: SocialAccountRow;
}

/** 合法的表名（字面量联合） */
export type ModelName = keyof ModelMap;

/** 表视图的查询条件：field 限定为该表的列名 */
export type ModelWhere<Row> = WhereCondition<keyof Row & string>[];

// ----------------------------------------------------------
// 表视图
// ----------------------------------------------------------

/** 单表类型化视图：方法语义与 DatabaseAdapter 一致，行形状已知 */
export interface ModelView<Row> {
  /** 查询单条记录 */
  findOne(params: { where: ModelWhere<Row> }): Promise<Row | null>;
  /** 查询多条记录（支持搜索/排序/分页） */
  findMany(params: {
    where?: ModelWhere<Row>;
    search?: SearchCondition;
    orderBy?: OrderByCondition;
    limit?: number;
    offset?: number;
  }): Promise<Row[]>;
  /** 创建单条记录 */
  create(params: { data: Partial<Row> }): Promise<Row>;
  /** 更新单条记录，返回更新后的记录 */
  updateOne(params: {
    where: ModelWhere<Row>;
    update: Partial<Row>;
  }): Promise<Row | null>;
  /** 批量更新，返回受影响行数 */
  updateMany(params: {
    where: ModelWhere<Row>;
    update: Partial<Row>;
  }): Promise<number>;
  /** 删除单条记录 */
  deleteOne(params: { where: ModelWhere<Row> }): Promise<Row | null>;
  /** 批量删除，返回受影响行数 */
  deleteMany(params: { where: ModelWhere<Row> }): Promise<number>;
  /** 计数查询 */
  count(params: {
    where?: ModelWhere<Row>;
    search?: SearchCondition;
  }): Promise<number>;
}

// ----------------------------------------------------------
// 门面
// ----------------------------------------------------------

/** auth.db 门面：类型化表视图 + 已弃用的泛型方法 */
export interface DbFacade {
  // ---- 类型化表视图（推荐） ----
  user: ModelView<UserRow>;
  account: ModelView<AccountRow>;
  socialAccount: ModelView<SocialAccountRow>;

  // ---- 泛型方法（已弃用） ----

  /** @deprecated 使用表视图 db.user.* / db.account.* 等，获得编译期表名与列名校验 */
  findOne(params: {
    model: string;
    where: WhereCondition[];
  }): Promise<unknown | null>;
  /** @deprecated 使用表视图 db.user.* / db.account.* 等，获得编译期表名与列名校验 */
  findMany(params: {
    model: string;
    where?: WhereCondition[];
    search?: SearchCondition;
    orderBy?: OrderByCondition;
    limit?: number;
    offset?: number;
  }): Promise<unknown[]>;
  /** @deprecated 使用表视图 db.user.* / db.account.* 等，获得编译期表名与列名校验 */
  create(params: {
    model: string;
    data: Record<string, unknown>;
  }): Promise<unknown>;
  /** @deprecated 使用表视图 db.user.* / db.account.* 等，获得编译期表名与列名校验 */
  updateOne(params: {
    model: string;
    where: WhereCondition[];
    update: Record<string, unknown>;
  }): Promise<unknown>;
  /** @deprecated 使用表视图 db.user.* / db.account.* 等，获得编译期表名与列名校验 */
  updateMany(params: {
    model: string;
    where: WhereCondition[];
    update: Record<string, unknown>;
  }): Promise<number>;
  /** @deprecated 使用表视图 db.user.* / db.account.* 等，获得编译期表名与列名校验 */
  deleteOne(params: {
    model: string;
    where: WhereCondition[];
  }): Promise<unknown>;
  /** @deprecated 使用表视图 db.user.* / db.account.* 等，获得编译期表名与列名校验 */
  deleteMany(params: {
    model: string;
    where: WhereCondition[];
  }): Promise<number>;
  /** @deprecated 使用表视图 db.user.* / db.account.* 等，获得编译期表名与列名校验 */
  count(params: {
    model: string;
    where?: WhereCondition[];
    search?: SearchCondition;
  }): Promise<number>;
}

// ----------------------------------------------------------
// 工厂
// ----------------------------------------------------------

/** 为指定 model 创建类型化表视图 */
export function createModelView<M extends ModelName>(
  adapter: DatabaseAdapter,
  model: M
): ModelView<ModelMap[M]> {
  return {
    findOne: async (params) =>
      (await adapter.findOne({ model, where: params.where })) as ModelMap[M] | null,
    findMany: async (params) =>
      (await adapter.findMany({ model, ...params })) as ModelMap[M][],
    create: async (params) =>
      (await adapter.create({
        model,
        data: params.data as Record<string, unknown>,
      })) as ModelMap[M],
    updateOne: async (params) =>
      (await adapter.updateOne({
        model,
        where: params.where,
        update: params.update as Record<string, unknown>,
      })) as ModelMap[M] | null,
    updateMany: async (params) =>
      adapter.updateMany({
        model,
        where: params.where,
        update: params.update as Record<string, unknown>,
      }),
    deleteOne: async (params) =>
      (await adapter.deleteOne({ model, where: params.where })) as ModelMap[M] | null,
    deleteMany: async (params) => adapter.deleteMany({ model, where: params.where }),
    count: async (params) =>
      adapter.count({ model, where: params.where, search: params.search }),
  };
}

/** 创建完整门面（OmniAuth.db getter 使用） */
export function createDbFacade(adapter: DatabaseAdapter): DbFacade {
  return {
    user: createModelView(adapter, "user"),
    account: createModelView(adapter, "account"),
    socialAccount: createModelView(adapter, "socialAccount"),

    findOne: (params) => adapter.findOne(params),
    findMany: (params) => adapter.findMany(params),
    create: (params) => adapter.create(params),
    updateOne: (params) => adapter.updateOne(params),
    updateMany: (params) => adapter.updateMany(params),
    deleteOne: (params) => adapter.deleteOne(params),
    deleteMany: (params) => adapter.deleteMany(params),
    count: (params) => adapter.count(params),
  };
}
