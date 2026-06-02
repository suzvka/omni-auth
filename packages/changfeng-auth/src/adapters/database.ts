// ============================================================
// DatabaseAdapter — 数据库适配器接口
//
// 符合 better-auth 适配器规范，同时支持业务表操作。
// 框架无关，用户可提供 Prisma / Drizzle / 原始 SQL 等实现。
// ============================================================

export interface DatabaseAdapter {
  /** 创建单条记录 */
  create(params: {
    model: string;
    data: Record<string, unknown>;
  }): Promise<unknown>;

  /** 查询单条记录 */
  findOne(params: {
    model: string;
    where: { field: string; value: unknown; operator?: string }[];
  }): Promise<unknown | null>;

  /** 查询多条记录 */
  findMany(params: {
    model: string;
    where?: { field: string; value: unknown; operator?: string }[];
    limit?: number;
    offset?: number;
  }): Promise<unknown[]>;

  /** 更新单条记录，返回更新后的记录 */
  updateOne(params: {
    model: string;
    where: { field: string; value: unknown }[];
    update: Record<string, unknown>;
  }): Promise<unknown>;

  /** 批量更新，返回受影响行数 */
  updateMany(params: {
    model: string;
    where: { field: string; value: unknown; operator?: string }[];
    update: Record<string, unknown>;
  }): Promise<number>;

  /** 删除单条记录 */
  deleteOne(params: {
    model: string;
    where: { field: string; value: unknown; operator?: string }[];
  }): Promise<unknown>;

  /** 批量删除，返回受影响行数 */
  deleteMany(params: {
    model: string;
    where: { field: string; value: unknown; operator?: string }[];
  }): Promise<number>;

  /** 数据库初始化 / 健康检查（可选） */
  init?(): Promise<void>;
  disconnect?(): Promise<void>;
}
