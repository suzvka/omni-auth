// ============================================================
// PgAdapter — 基于 node-postgres 的 DatabaseAdapter 实现
//
// 零 ORM 依赖，直接执行参数化 SQL。
// 支持 PostgreSQL 14+。
//
// 连接池由宿主注入（必填）：本适配器不自行创建/关闭连接池，
// 池的生命周期（含 disconnect）归宿主所有，实现单池共享。
// ============================================================

import type { QueryResultRow } from "pg";
import type {
  DatabaseAdapter,
  WhereCondition,
  SearchCondition,
  OrderByCondition,
} from "../../adapters/database";
import { OmniAuthError } from "../../errors";

// ----------------------------------------------------------
// 配置
// ----------------------------------------------------------

/**
 * 宿主连接池的最小结构形状（结构化类型）。
 *
 * 刻意不引用 @types/pg 的 Pool 具体类型：宿主项目（如 yunzone-service-kit）
 * 可能解析到不同版本的 @types/pg，结构兼容即可避免跨项目类型耦合。
 */
export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{
    rows: unknown[];
    rowCount: number | null;
  }>;
  connect(): Promise<PgClientLike>;
}

/** 事务连接的最小结构形状 */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{
    rows: unknown[];
    rowCount: number | null;
  }>;
  release(err?: Error | boolean): void;
}

export interface PgAdapterOptions {
  /** 宿主提供的现成连接池（必填）。池配置（SSL/max 等）与生命周期归宿主 */
  pool: PgPoolLike;
}

export interface PgAdapterInstance extends DatabaseAdapter {
  /** 获取注入的宿主连接池引用 */
  getPool(): Promise<PgPoolLike>;
  /** 初始化（注入池已就绪，no-op） */
  init(): Promise<void>;
  /** 关闭连接池（no-op：池所有权归宿主） */
  disconnect(): Promise<void>;
}

// ----------------------------------------------------------
// SQL 生成工具
// ----------------------------------------------------------

/**
 * 标识符统一加双引号。
 *
 * PostgreSQL 会把未加引号的标识符折叠为小写（providerId → providerid），
 * 而 better-auth / omni-auth 业务层期望驼峰字段名（providerId）。
 * 表列名由 schema 同步（schema-sync）以引号形式创建（驼峰保真），
 * 因此读写的 SQL 必须同样加引号，否则写入折叠为小写、读取返回小写 key，
 * 导致字段名不匹配（登录时 "Credential account not found"）。
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 将 WhereCondition 转为参数化 SQL */
function buildWhereClause(
  conditions: WhereCondition[],
  startParamIndex: number
): { sql: string; values: unknown[] } {
  if (conditions.length === 0) return { sql: "", values: [] };

  const parts: string[] = [];
  const values: unknown[] = [];
  let paramIdx = startParamIndex;

  for (const cond of conditions) {
    const field = quoteIdent(cond.field);
    const op = cond.operator ?? "eq";

    switch (op) {
      case "eq":
        parts.push(`${field} = $${paramIdx++}`);
        values.push(cond.value);
        break;
      case "neq":
        parts.push(`${field} <> $${paramIdx++}`);
        values.push(cond.value);
        break;
      case "in": {
        const arr = Array.isArray(cond.value) ? cond.value : [cond.value];
        if (arr.length === 0) {
          parts.push("FALSE");
        } else {
          const placeholders = arr.map(() => `$${paramIdx++}`);
          parts.push(`${field} IN (${placeholders.join(", ")})`);
          values.push(...arr);
        }
        break;
      }
      case "lt":
        parts.push(`${field} < $${paramIdx++}`);
        values.push(cond.value);
        break;
      case "gt":
        parts.push(`${field} > $${paramIdx++}`);
        values.push(cond.value);
        break;
      case "lte":
        parts.push(`${field} <= $${paramIdx++}`);
        values.push(cond.value);
        break;
      case "gte":
        parts.push(`${field} >= $${paramIdx++}`);
        values.push(cond.value);
        break;
      default:
        parts.push(`${field} = $${paramIdx++}`);
        values.push(cond.value);
    }
  }

  return { sql: parts.join(" AND "), values };
}

/** 将 SearchCondition 转为参数化 SQL */
function buildSearchClause(
  search: SearchCondition,
  startParamIndex: number
): { sql: string; values: unknown[] } {
  if (!search.value || search.fields.length === 0) {
    return { sql: "", values: [] };
  }
  const parts: string[] = [];
  const values: unknown[] = [];
  let paramIdx = startParamIndex;
  for (const f of search.fields) {
    parts.push(`${quoteIdent(f)}::text ILIKE $${paramIdx++}`);
    values.push(`%${search.value}%`);
  }
  return { sql: `(${parts.join(" OR ")})`, values };
}

/** 将 OrderByCondition 转为 SQL */
function buildOrderClause(orderBy: OrderByCondition): string {
  if (!orderBy || !orderBy.field) return "";
  return `ORDER BY ${quoteIdent(orderBy.field)} ${orderBy.direction === "desc" ? "DESC" : "ASC"}`;
}

/**
 * 唯一约束冲突（pg 错误码 23505）转译为 code=UNIQUE_VIOLATION 的 OmniAuthError。
 *
 * 不设专用错误类：与宿主基础设施（yunzone-service-kit）的同名类区分，
 * 跨抽象判断统一按 err.code（isUniqueViolation 守卫）。
 */
function translatePgError(err: unknown): never {
  if (
    err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "23505"
  ) {
    throw new OmniAuthError(
      "UNIQUE_VIOLATION",
      err instanceof Error ? err.message : String(err)
    );
  }
  throw err;
}

/** 空 where 防护：更新/删除操作必须显式给出条件，防全表误操作 */
function requireNonEmptyWhere(method: string, where: WhereCondition[]): void {
  if (!where || where.length === 0) {
    throw new TypeError(`PgAdapter.${method}: where 条件不能为空（防全表误操作）`);
  }
}

// ----------------------------------------------------------
// 适配器实现
// ----------------------------------------------------------

/** SQL 执行器签名：Pool 级与事务 Client 级共用同一套 CRUD 构建（rows 用 unknown，避免类型版本耦合） */
type QueryExecutor = (
  sql: string,
  values: unknown[]
) => Promise<{ rows: unknown[]; rowCount: number }>;

/** 基于给定执行器构建完整 CRUD（pool 级 / 事务级共用） */
function buildCrudAdapter(exec: QueryExecutor): DatabaseAdapter {
  async function query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await exec(sql, values);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }

  return {
    // ---- CRUD ----

    async create({ model, data }) {
      const keys = Object.keys(data);
      const values = Object.values(data);
      const columns = keys.map(quoteIdent).join(", ");
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");

      const sql = `INSERT INTO ${quoteIdent(model)} (${columns}) VALUES (${placeholders}) RETURNING *`;
      const { rows } = await query(sql, values);
      return rows[0] ?? null;
    },

    async findOne({ model, where }) {
      const { sql: whereSql, values } = buildWhereClause(where, 1);
      const sql = `SELECT * FROM ${quoteIdent(model)}${whereSql ? ` WHERE ${whereSql}` : ""} LIMIT 1`;
      const { rows } = await query(sql, values);
      return rows[0] ?? null;
    },

    async findMany({ model, where, search, orderBy, limit, offset }) {
      const clauses: string[] = [];
      const allValues: unknown[] = [];
      let paramIdx = 1;

      // where
      const { sql: wSql, values: wVals } = buildWhereClause(where ?? [], paramIdx);
      if (wSql) {
        clauses.push(wSql);
        allValues.push(...wVals);
        paramIdx += wVals.length;
      }

      // search（与 where 为 AND 关系）
      if (search?.value) {
        const { sql: sSql, values: sVals } = buildSearchClause(search, paramIdx);
        if (sSql) {
          clauses.push(sSql);
          allValues.push(...sVals);
          paramIdx += sVals.length;
        }
      }

      const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      const orderClause = orderBy ? ` ${buildOrderClause(orderBy)}` : "";
      const limitClause = limit != null ? ` LIMIT $${paramIdx++}` : "";
      const offsetClause = offset != null ? ` OFFSET $${paramIdx++}` : "";

      const sql = `SELECT * FROM ${quoteIdent(model)}${whereClause}${orderClause}${limitClause}${offsetClause}`;

      const finalValues = [...allValues];
      if (limit != null) finalValues.push(limit);
      if (offset != null) finalValues.push(offset);

      const { rows } = await query(sql, finalValues);
      return rows;
    },

    async count({ model, where, search }) {
      const clauses: string[] = [];
      const allValues: unknown[] = [];
      let paramIdx = 1;

      const { sql: wSql, values: wVals } = buildWhereClause(where ?? [], paramIdx);
      if (wSql) {
        clauses.push(wSql);
        allValues.push(...wVals);
        paramIdx += wVals.length;
      }

      if (search?.value) {
        const { sql: sSql, values: sVals } = buildSearchClause(search, paramIdx);
        if (sSql) {
          clauses.push(sSql);
          allValues.push(...sVals);
        }
      }

      const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      const sql = `SELECT COUNT(*)::int AS total FROM ${quoteIdent(model)}${whereClause}`;
      const { rows } = await query<{ total: number }>(sql, allValues);
      return rows[0]?.total ?? 0;
    },

    async updateOne({ model, where, update }) {
      requireNonEmptyWhere("updateOne", where);
      const { sql: whereSql, values: wVals } = buildWhereClause(where, 1);
      const keys = Object.keys(update);
      const uVals = Object.values(update);
      const setClauses = keys.map((k, i) => `${quoteIdent(k)} = $${wVals.length + i + 1}`);
      const allValues = [...wVals, ...uVals];

      const sql = `UPDATE ${quoteIdent(model)} SET ${setClauses.join(", ")} WHERE ${whereSql} RETURNING *`;
      const { rows } = await query(sql, allValues);
      return rows[0] ?? null;
    },

    async updateMany({ model, where, update }) {
      requireNonEmptyWhere("updateMany", where);
      const { sql: whereSql, values: wVals } = buildWhereClause(where, 1);
      const keys = Object.keys(update);
      const uVals = Object.values(update);
      const setClauses = keys.map((k, i) => `${quoteIdent(k)} = $${wVals.length + i + 1}`);
      const allValues = [...wVals, ...uVals];

      const sql = `UPDATE ${quoteIdent(model)} SET ${setClauses.join(", ")} WHERE ${whereSql}`;
      const { rowCount } = await query(sql, allValues);
      return rowCount;
    },

    async deleteOne({ model, where }) {
      requireNonEmptyWhere("deleteOne", where);
      const { sql: whereSql, values } = buildWhereClause(where, 1);
      const sql = `DELETE FROM ${quoteIdent(model)} WHERE ${whereSql} RETURNING *`;
      const { rows } = await query(sql, values);
      return rows[0] ?? null;
    },

    async deleteMany({ model, where }) {
      requireNonEmptyWhere("deleteMany", where);
      const { sql: whereSql, values } = buildWhereClause(where, 1);
      const sql = `DELETE FROM ${quoteIdent(model)} WHERE ${whereSql}`;
      const { rowCount } = await query(sql, values);
      return rowCount;
    },

    // ---- 原子 upsert（ON CONFLICT ... DO UPDATE） ----

    async upsert({ model, data, conflictOn, update }) {
      const dataKeys = Object.keys(data);
      const dataValues = Object.values(data);
      const columns = dataKeys.map(quoteIdent).join(", ");
      const placeholders = dataKeys.map((_, i) => `$${i + 1}`).join(", ");

      // 冲突检测字段（支持多字段复合唯一约束）
      const conflictCols = conflictOn.map(quoteIdent).join(", ");

      // 构建 DO UPDATE SET 子句
      // 优先引用 INSERT 中同名参数位置（避免重复传值）
      let paramIdx = dataValues.length + 1;
      const setParts: string[] = [];
      const extraValues: unknown[] = [];
      for (const [key] of Object.entries(update)) {
        const dataIdx = dataKeys.indexOf(key);
        if (dataIdx !== -1) {
          setParts.push(`${quoteIdent(key)} = $${dataIdx + 1}`);
        } else {
          setParts.push(`${quoteIdent(key)} = $${paramIdx++}`);
          extraValues.push((update as Record<string, unknown>)[key]);
        }
      }

      const sql =
        `INSERT INTO ${quoteIdent(model)} (${columns}) VALUES (${placeholders})` +
        ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${setParts.join(", ")}` +
        ` RETURNING *`;
      const { rows } = await query(sql, [...dataValues, ...extraValues]);
      return rows[0] ?? null;
    },
  };
}

export function PgAdapter(options: PgAdapterOptions): PgAdapterInstance {
  const pool = options.pool;

  /** Pool 级执行器（含唯一约束错误转译；注入池返回原生 pg 错误，归一化在本层） */
  const poolExec: QueryExecutor = async (sql, values) => {
    try {
      const result = await pool.query(sql, values);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    } catch (err) {
      translatePgError(err);
    }
  };

  const crud = buildCrudAdapter(poolExec);

  return {
    ...crud,

    // ---- 事务 ----

    /**
     * 单连接事务：BEGIN → fn(tx) → COMMIT，抛错则 ROLLBACK。
     * tx 适配器与主适配器语义一致，但所有查询走事务绑定的连接。
     *
     * 契约约束：库事务与宿主事务（如 yunzone-service-kit withTransaction）
     * 互相不可见——宿主应在自身事务外调用库写操作，否则库在池上另开
     * 连接，其写入会静默逃逸宿主事务。
     */
    async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const clientExec: QueryExecutor = async (sql, values) => {
        try {
          const result = await client.query(sql, values);
          return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
        } catch (err) {
          translatePgError(err);
        }
      };
      const txAdapter = buildCrudAdapter(clientExec);

      try {
        await client.query("BEGIN");
        const result = await fn(txAdapter);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          console.error("[PgAdapter] ROLLBACK 失败:", rollbackErr);
        }
        throw err;
      } finally {
        client.release();
      }
    },

    // ---- 生命周期 ----

    async getPool() {
      return pool;
    },

    async init() {
      // 注入池已由宿主就绪，无需预热
    },

    async disconnect() {
      // 池所有权归宿主（如 yunzone-service-kit PgSqlDb），不在此关闭
    },
  };
}
