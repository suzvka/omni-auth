import type { DatabaseAdapter, WhereCondition } from "changfeng-auth";

// ============================================================
// Better Auth CustomAdapter 桥接层
//
// 将 ChangfengAuth 的 DatabaseAdapter 包装为 Better Auth 期望的
// CustomAdapter 接口。运行时核心差异：
//   1. 方法名：BA 用 update / delete，我们用 updateOne / deleteOne
//   2. findMany 排序：BA 用 sortBy，我们用 orderBy
//   3. Where 运算符：BA 用 "ne"，我们统一用 "neq"
// ============================================================

/**
 * Better Auth Where 的运行时形状（精简版）。
 * 包含 BA adapter factory 传递过来的所有字段。
 */
interface BAWhere {
  field: string;
  value: unknown;
  operator?: string;
  connector?: "AND" | "OR";
  mode?: "sensitive" | "insensitive";
}

/**
 * 将 Better Auth 的 Where 转换为 ChangfengAuth 的 WhereCondition。
 *
 * 差异处理：
 * - operator "ne" → "neq"
 * - 忽略 connector / mode（当前 PgAdapter 不依赖这两个字段）
 */
function mapWhere(baWhere: BAWhere[]): WhereCondition[] {
  return baWhere.map((w) => {
    const operator = w.operator === "ne" ? "neq" : w.operator;
    return {
      field: w.field,
      value: w.value,
      ...(operator ? { operator } : {}),
    } as WhereCondition;
  });
}

/**
 * 将 DatabaseAdapter 包装为 Better Auth 兼容的 CustomAdapter。
 *
 * 返回的对象在运行时满足 Better Auth 的 `CustomAdapter` 接口，
 * 可安全地传入 `BetterAuthOptions.database`。
 *
 * @param db ChangfengAuth 的 DatabaseAdapter 实例
 * @returns 兼容 Better Auth 的 adapter 对象
 */
export function toBetterAuthAdapter(db: DatabaseAdapter): Record<string, unknown> {
  return {
    id: "changfeng-pg",

    // ---- create ----
    create: async ({
      data,
      model,
    }: {
      model: string;
      data: Record<string, unknown>;
      select?: string[];
    }) => {
      return db.create({ model, data });
    },

    // ---- update → updateOne（方法名映射） ----
    update: async ({
      model,
      where,
      update,
    }: {
      model: string;
      where: BAWhere[];
      update: Record<string, unknown>;
    }) => {
      return db.updateOne({
        model,
        where: mapWhere(where),
        update, // BA update 字段名与 DatabaseAdapter 一致，无需映射
      });
    },

    // ---- updateMany：直接透传 ----
    updateMany: async ({
      model,
      where,
      update,
    }: {
      model: string;
      where: BAWhere[];
      update: Record<string, unknown>;
    }) => {
      return db.updateMany({
        model,
        where: mapWhere(where),
        update,
      });
    },

    // ---- findOne（忽略 BA 的 select / join 参数） ----
    findOne: async ({
      model,
      where,
    }: {
      model: string;
      where: BAWhere[];
      select?: string[];
    }) => {
      return db.findOne({
        model,
        where: mapWhere(where),
      });
    },

    // ---- findMany（sortBy → orderBy 映射，忽略 select / join） ----
    findMany: async ({
      model,
      where,
      limit,
      sortBy,
      offset,
    }: {
      model: string;
      where?: BAWhere[];
      limit?: number;
      select?: string[];
      sortBy?: { field: string; direction: "asc" | "desc" };
      offset?: number;
    }) => {
      return db.findMany({
        model,
        where: where ? mapWhere(where) : undefined,
        orderBy: sortBy,
        limit,
        offset,
      } as Partial<Parameters<typeof db.findMany>[0]> as never);
    },

    // ---- delete → deleteOne（方法名映射） ----
    delete: async ({
      model,
      where,
    }: {
      model: string;
      where: BAWhere[];
    }) => {
      await db.deleteOne({ model, where: mapWhere(where) });
    },

    // ---- deleteMany：直接透传 ----
    deleteMany: async ({
      model,
      where,
    }: {
      model: string;
      where: BAWhere[];
    }) => {
      return db.deleteMany({ model, where: mapWhere(where) });
    },

    // ---- count：直接透传 ----
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    count: async ({
      model,
      where,
    }: {
      model: string;
      where?: BAWhere[];
    }) => {
      return (db as any).count({
        model,
        where: where ? mapWhere(where) : undefined,
      });
    },

    // consumeOne：不提供，让 Better Auth adapter factory 用 fallback
    //（内部 fallback = findMany + deleteMany wrapped in transaction）
  };
}
