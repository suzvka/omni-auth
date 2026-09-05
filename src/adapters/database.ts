// ============================================================
// DatabaseAdapter — 数据库适配器接口
//
// 符合 better-auth 适配器规范，同时支持业务表操作。
// 框架无关，用户可提供 Prisma / Drizzle / 原始 SQL 等实现。
// ============================================================

/** 查询条件操作符 */
export type WhereOperator = "eq" | "neq" | "in" | "lt" | "gt" | "lte" | "gte";

/** 单条查询条件（field 可限定为具体表的列名） */
export interface WhereCondition<Field extends string = string> {
  field: Field;
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

/**
 * 数据库适配器接口（完整契约，实现方必读）。
 *
 * 契约条款：
 * 1. **错误翻译下沉**：库级错误（唯一约束冲突等）必须在适配器层转译为
 *    code=UNIQUE_VIOLATION 等抽象信号的 OmniAuthError，不得把数据库原生
 *    错误码（如 pg 23505）泄漏到业务层；业务层统一经 isUniqueViolation
 *    守卫判断，跨包/多副本场景下禁止依赖错误类身份（instanceof）。
 * 2. **事务能力协商**：多表写入（注册 / 社交绑定 / 管理侧建号）依赖
 *    transaction。未实现时 createAuth 构造期 fail-fast（除非宿主经
 *    allowNonAtomicWrites 显式接受非原子降级）。
 */
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
   * 当前库内部暂无消费方（为单 token upsert 语义预留），
   * 适配器可不实现；未来启用时以能力协商声明。 */
  upsert?(params: {
    model: string;
    data: Record<string, unknown>;
    /** 冲突检测字段（如 ["userId"]） */
    conflictOn: string[];
    /** 冲突时更新的字段（不含 conflictOn 字段本身，由实现决定） */
    update: Record<string, unknown>;
  }): Promise<unknown>;

  /**
   * 事务执行（可选）。
   *
   * fn 收到的 tx 适配器与原适配器语义一致，但所有操作处于同一事务：
   * fn 正常返回则提交，抛错则回滚。多表写入（注册 = user + account +
   * socialAccount）应包入事务以保证原子性。
   *
   * 未实现时 {@link withTransaction} 回退为顺序写入并警告；
   * 但 createAuth 构造期默认对缺失的 transaction 能力 fail-fast，
   * 仅当宿主配置 allowNonAtomicWrites=true 时才容忍回退路径。
   */
  transaction?<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T>;

  /** 数据库初始化 / 健康检查（可选） */
  init?(): Promise<void>;
  disconnect?(): Promise<void>;
}

// ----------------------------------------------------------
// 事务辅助
// ----------------------------------------------------------

let txFallbackWarned = false;

/**
 * 在事务中执行多表操作；适配器未实现 transaction 时回退为顺序写入。
 *
 * 回退路径下多表写入不具原子性，仅在首次回退时警告一次。
 * 该路径不应被意外触达：createAuth 构造期已对缺失的 transaction 能力
 * fail-fast，回退仅在宿主经 allowNonAtomicWrites 显式接受降级后存在。
 */
export async function withTransaction<T>(
  adapter: DatabaseAdapter,
  fn: (tx: DatabaseAdapter) => Promise<T>
): Promise<T> {
  if (typeof adapter.transaction === "function") {
    return adapter.transaction(fn);
  }
  if (!txFallbackWarned) {
    txFallbackWarned = true;
    console.warn(
      "[omni-auth] 数据库适配器未实现 transaction，多表写入回退为顺序执行（不具原子性）。建议实现 DatabaseAdapter.transaction。"
    );
  }
  return fn(adapter);
}
