// ============================================================
// PgAdapter — 基于 node-postgres 的 DatabaseAdapter 实现
//
// 零 ORM 依赖，直接执行参数化 SQL。
// 支持 PostgreSQL 14+。
// ============================================================

import type { Pool, PoolConfig, QueryResultRow } from "pg";
import type {
  DatabaseAdapter,
  WhereCondition,
  SearchCondition,
  OrderByCondition,
} from "../../adapters/database";

// ----------------------------------------------------------
// 配置
// ----------------------------------------------------------

export interface PgAdapterOptions {
  /** PostgreSQL 连接 URL（必填） */
  url: string;
  /** TLS/SSL 配置（Neon、Supabase 等云数据库通常要求启用） */
  ssl?: PoolConfig["ssl"];
  /** 连接池配置（可选） */
  pool?: {
    max?: number;
    idleTimeoutMillis?: number;
  };
}

export interface PgAdapterInstance extends DatabaseAdapter {
  /** 内部持有的 pg Pool 引用 */
  _pool: Pool;
  /** 关闭连接池 */
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
 * 表列名由 db:push / schema 同步以引号形式创建（驼峰保真），
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

// ----------------------------------------------------------
// 适配器实现
// ----------------------------------------------------------

/** 构建 pg Pool 构造参数（独立纯函数，便于单元测试） */
export function buildPoolConfig(options: PgAdapterOptions): PoolConfig {
  return {
    connectionString: options.url,
    ssl: options.ssl,
    max: options.pool?.max ?? 10,
    idleTimeoutMillis: options.pool?.idleTimeoutMillis ?? 30000,
  };
}

export function PgAdapter(options: PgAdapterOptions): PgAdapterInstance {
  // 延迟加载 pg 以支持 tree-shaking（仅在使用此适配器时加载）。
  // 使用动态 import("pg") 而非 require("pg")：esbuild 会把 require 转为
  // __require shim，Next.js 16 的打包器无法静态分析 __require("pg")，
  // 会报 "dynamic usage of require is not supported"。
  let _pool: Pool | null = null;
  let _pgPromise: Promise<typeof import("pg")> | null = null;

  function loadPg(): Promise<typeof import("pg")> {
    if (!_pgPromise) {
      _pgPromise = import("pg");
    }
    return _pgPromise;
  }

  async function getPool(): Promise<Pool> {
    if (!_pool) {
      const pg = await loadPg();
      _pool = new pg.Pool(buildPoolConfig(options));
    }
    return _pool;
  }

  async function query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    const pool = await getPool();
    const result = await pool.query<T>(sql, values);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  }

  return {
    _pool: undefined as unknown as Pool, // 由 getPool 延迟初始化

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
      const { sql: whereSql, values } = buildWhereClause(where, 1);
      const sql = `DELETE FROM ${quoteIdent(model)} WHERE ${whereSql} RETURNING *`;
      const { rows } = await query(sql, values);
      return rows[0] ?? null;
    },

    async deleteMany({ model, where }) {
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

    // ---- 生命周期 ----

    async init() {
      await getPool(); // 预热连接池
    },

    async disconnect() {
      if (_pool) {
        await _pool.end();
        _pool = null;
      }
    },
  };
}
