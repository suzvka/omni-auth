// ============================================================
// DatabaseAdapter — 数据库适配器接口
//
// 符合 better-auth 适配器规范，同时支持业务表操作。
// 框架无关，用户可提供 Prisma / Drizzle / 原始 SQL 等实现。
// ============================================================

/** 查询条件操作符 */
export type WhereOperator = "eq" | "neq" | "in" | "lt" | "gt" | "lte" | "gte";

/** 单条查询条件 */
export interface WhereCondition {
  field: string;
  value: unknown;
  operator?: WhereOperator;
}

/** 搜索条件：多字段 LIKE（AND 语义） */
export interface SearchCondition {
  fields: string[];
  value: string;
}

/** 排序条件 */
export interface OrderByCondition {
  field: string;
  direction: "asc" | "desc";
}

export interface DatabaseAdapter {
  /** 创建单条记录 */
  create(params: {
    model: string;
    data: Record<string, unknown>;
  }): Promise<unknown>;

  /** 查询单条记录 */
  findOne(params: {
    model: string;
    where: WhereCondition[];
  }): Promise<unknown | null>;

  /** 查询多条记录（支持搜索/排序/分页） */
  findMany(params: {
    model: string;
    where?: WhereCondition[];
    search?: SearchCondition;
    orderBy?: OrderByCondition;
    limit?: number;
    offset?: number;
  }): Promise<unknown[]>;

  /** 计数查询（search 参数与 findMany 语义一致） */
  count(params: {
    model: string;
    where?: WhereCondition[];
    search?: SearchCondition;
  }): Promise<number>;

  /** 更新单条记录，返回更新后的记录 */
  updateOne(params: {
    model: string;
    where: WhereCondition[];
    update: Record<string, unknown>;
  }): Promise<unknown>;

  /** 批量更新，返回受影响行数 */
  updateMany(params: {
    model: string;
    where: WhereCondition[];
    update: Record<string, unknown>;
  }): Promise<number>;

  /** 删除单条记录 */
  deleteOne(params: {
    model: string;
    where: WhereCondition[];
  }): Promise<unknown>;

  /** 批量删除，返回受影响行数 */
  deleteMany(params: {
    model: string;
    where: WhereCondition[];
  }): Promise<number>;

  /** 插入或更新（原子 upsert，用于单 token 语义）
   *
   * PostgreSQL 实现使用 ON CONFLICT ... DO UPDATE。
   * 非 PG 适配器可不实现（token.ts 会检测并回退）。 */
  upsert?(params: {
    model: string;
    data: Record<string, unknown>;
    /** 冲突检测字段（如 ["userId"]） */
    conflictOn: string[];
    /** 冲突时更新的字段（不含 conflictOn 字段本身，由实现决定） */
    update: Record<string, unknown>;
  }): Promise<unknown>;

  /** 数据库初始化 / 健康检查（可选） */
  init?(): Promise<void>;
  disconnect?(): Promise<void>;
}
