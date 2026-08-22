import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncSchema } from "./schema-sync";
import { schema } from "./schema";
import type { PgPoolLike } from "./builtin/pg/adapter";

// ------------------------------------------------------------
// schema-sync 幂等性测试（mock 注入池，不连真实数据库）
// ------------------------------------------------------------

/** 可编程 mock 池：按 SQL 内容分发响应 */
function createMockPool(opts: {
  /** information_schema.tables 的返回（现有表） */
  existingTables?: string[];
  /** information_schema.columns 的返回（每表现有列，key 为表名） */
  existingColumns?: Record<string, string[]>;
} = {}) {
  const executed: string[] = [];
  const { existingTables = [], existingColumns = {} } = opts;

  const pool = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      executed.push(text);
      if (text.includes("information_schema.tables")) {
        return {
          rows: existingTables.map((t) => ({ table_name: t })),
          rowCount: existingTables.length,
        };
      }
      if (text.includes("information_schema.columns")) {
        const tableName = String(values?.[0] ?? "");
        const cols = existingColumns[tableName] ?? [];
        return {
          rows: cols.map((c) => ({ column_name: c })),
          rowCount: cols.length,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(),
  } as unknown as PgPoolLike & { query: ReturnType<typeof vi.fn> };

  return { pool, executed };
}

/** 表名清单（schema 单一事实源） */
const ALL_TABLES = Object.values(schema).map((t) => t.name);

/** 每表的完整列名（schema 单一事实源） */
const FULL_COLUMNS: Record<string, string[]> = {};
for (const t of Object.values(schema)) {
  FULL_COLUMNS[t.name] = Object.keys(t.columns);
}

describe("syncSchema", () => {
  beforeEach(() => {
    // 防止测试环境残留 DATABASE_URL 触发 bootstrap 真实连接
    delete process.env.DATABASE_URL;
    delete process.env.PGDATABASE_URL;
  });

  it("autoSync=false：仅检查缺表，不执行任何 DDL", async () => {
    const { pool, executed } = createMockPool({ existingTables: ALL_TABLES });
    const result = await syncSchema(pool, { autoSync: false });

    expect(result.synced).toBe(false);
    expect(result.missingTables).toEqual([]);
    expect(executed.every((s) => !s.startsWith("CREATE"))).toBe(true);
  });

  it("autoSync=false：检测到缺表时返回缺失清单", async () => {
    const missing = ["session", "oauthToken", "oauthClient"];
    const { pool } = createMockPool({
      existingTables: ["user", "socialAccount"],
    });
    const result = await syncSchema(pool, { autoSync: false });

    expect(result.synced).toBe(false);
    expect(result.missingTables.sort()).toEqual([...missing].sort());
  });

  it("autoSync=true：全表缺失时执行 CREATE TABLE IF NOT EXISTS（幂等形态）", async () => {
    const { pool, executed } = createMockPool({ existingTables: [] });
    const result = await syncSchema(pool);

    expect(result.synced).toBe(true);
    expect(result.missingTables).toEqual([]);
    const createStmts = executed.filter((s) => s.startsWith("CREATE TABLE"));
    expect(createStmts.length).toBe(ALL_TABLES.length);
    for (const t of ALL_TABLES) {
      expect(createStmts.some((s) => s.includes(`"${t}"`))).toBe(true);
    }
    // 幂等：再次同步不产生非幂等语句
    expect(createStmts.every((s) => s.includes("IF NOT EXISTS"))).toBe(true);
  });

  it("autoSync=true：表已存在时不再重复建表（IF NOT EXISTS 语义）", async () => {
    const { pool, executed } = createMockPool({ existingTables: ALL_TABLES });
    await syncSchema(pool);

    const createStmts = executed.filter((s) => s.startsWith("CREATE TABLE"));
    // 仍会执行 DDL（IF NOT EXISTS 由数据库兜底），但列修正查询确认无缺失
    expect(createStmts.length).toBe(ALL_TABLES.length);
  });

  it("缺列时执行 ADD COLUMN 并返回新增列数", async () => {
    const { pool, executed } = createMockPool({
      existingTables: ALL_TABLES,
      // user 表缺 emailVerified / active 两列（旧库升级场景），其余表完整
      existingColumns: {
        ...FULL_COLUMNS,
        user: FULL_COLUMNS.user.filter((c) => c !== "emailVerified" && c !== "active"),
      },
    });
    const result = await syncSchema(pool);

    expect(result.synced).toBe(true);
    expect(result.addedColumns).toBe(2);
    const alters = executed.filter((s) => s.startsWith("ALTER TABLE"));
    expect(alters).toContainEqual(
      expect.stringContaining('ADD COLUMN "emailVerified" INTEGER NOT NULL DEFAULT 0')
    );
    expect(alters).toContainEqual(
      expect.stringContaining('ADD COLUMN "active" INTEGER NOT NULL DEFAULT 1')
    );
  });

  it("旧版全小写列名（驼峰被折叠）时执行 RENAME 保真修复", async () => {
    const { pool, executed } = createMockPool({
      existingTables: ALL_TABLES,
      // session 表旧同步把驼峰列全部折叠成全小写，其余表完整
      existingColumns: {
        ...FULL_COLUMNS,
        session: ["id", "userid", "token", "expiresat", "createdat"],
      },
    });
    const result = await syncSchema(pool);

    expect(result.synced).toBe(true);
    const renames = executed.filter((s) => s.includes("RENAME COLUMN"));
    expect(renames).toContainEqual(
      expect.stringContaining('"session" RENAME COLUMN "userid" TO "userId"')
    );
    // RENAME 修复后不应再对 session 表的 userId 列 ADD COLUMN
    const adds = executed.filter((s) => s.includes("ADD COLUMN"));
    expect(adds.some((s) => s.includes('"session"') && s.includes('ADD COLUMN "userId"'))).toBe(false);
  });

  it("CREATE TABLE 失败视为真实错误（中断抛出）", async () => {
    const pool = {
      query: vi.fn(async (text: string) => {
        if (text.startsWith("CREATE TABLE")) {
          throw new Error("permission denied");
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(),
    } as unknown as PgPoolLike;

    await expect(syncSchema(pool)).rejects.toThrow("permission denied");
  });

  it("CREATE INDEX 失败仅警告，不阻断同步", async () => {
    const pool = {
      query: vi.fn(async (text: string) => {
        if (text.startsWith("CREATE UNIQUE INDEX")) {
          throw new Error("duplicate index");
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(),
    } as unknown as PgPoolLike;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await syncSchema(pool);
    warnSpy.mockRestore();

    expect(result.synced).toBe(true);
  });
});
