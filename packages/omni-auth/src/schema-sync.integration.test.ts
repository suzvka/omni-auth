import { describe, it, expect, beforeEach } from "vitest";
import { newDb, type IMemoryDb } from "pg-mem";
import { syncSchema } from "./schema-sync";
import { schema } from "./schema";
import type { PgPoolLike } from "./builtin/pg/adapter";

// ------------------------------------------------------------
// schema-sync 集成冒烟（pg-mem 内存库执行真实 DDL）
//
// 覆盖"旧库升级"场景：已有 user/socialAccount（旧结构），
// 缺 session/oauth_token/oauth_client 表 + user 缺元数据列 +
// session 旧版小写折叠列名，验证 syncSchema 一次补齐。
// ------------------------------------------------------------

function createMemPool(): { db: IMemoryDb; pool: PgPoolLike } {
  // noAstCoverageCheck: 容忍 CREATE TABLE IF NOT EXISTS 等未覆盖的 AST 分支
  const db = newDb({ noAstCoverageCheck: true });
  // pg-mem 的 fake pg 实现：Pool 为类，实例化后 query 直接命中内存库
  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as unknown as PgPoolLike;
  return { db, pool };
}

describe("syncSchema（pg-mem 集成）", () => {
  beforeEach(() => {});

  it("旧库升级：缺表 + 缺列 + 小写列名一次补齐（真实 DDL 执行）", async () => {
    const { pool } = createMemPool();
    const ddl = pool as unknown as { query(text: string): Promise<{ rows: unknown[]; rowCount: number }> };

    // 模拟旧库：仅 user / socialAccount 两表，且 user 缺元数据列
    await ddl.query(
      `CREATE TABLE "user" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "image" TEXT,
        "password" TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL
      )`
    );
    await ddl.query(
      `CREATE TABLE "socialAccount" (
        "id" TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "providerOpenid" TEXT NOT NULL,
        "profileData" JSONB NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL,
        UNIQUE ("provider", "providerOpenid")
      )`
    );

    // 旧库已有历史数据（验证同步不破坏数据）
    await ddl.query(
      `INSERT INTO "user" ("id", "name", "createdAt", "updatedAt") VALUES ('u-1', '老用户', NOW(), NOW())`
    );

    // 第一次同步：补齐全部表 + user 元数据列
    const result = await syncSchema(pool);

    expect(result.synced).toBe(true);
    expect(result.addedColumns).toBeGreaterThanOrEqual(2);

    // 五张表全部就绪
    const tables = await ddl.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const tableNames = (tables.rows as Array<{ table_name: string }>).map((r) => r.table_name);
    for (const t of Object.values(schema)) {
      expect(tableNames).toContain(t.name);
    }

    // user 元数据列已添加且带默认值
    const userCols = await ddl.query(
      `SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'user'`
    );
    const colMap = new Map(
      (userCols.rows as Array<{ column_name: string; column_default: string | null }>).map((r) => [
        r.column_name,
        r.column_default,
      ])
    );
    expect(colMap.has("emailVerified")).toBe(true);
    expect(colMap.has("active")).toBe(true);

    // 历史数据未被破坏
    const users = await ddl.query(`SELECT id, name FROM "user"`);
    expect(users.rows).toEqual([{ id: "u-1", name: "老用户" }]);

    // 第二次同步：幂等，0 新增列
    const again = await syncSchema(pool);
    expect(again.addedColumns).toBe(0);
  });

  it("session 表旧版小写折叠列名被 RENAME 保真（不丢数据）", async () => {
    const { pool } = createMemPool();
    const ddl = pool as unknown as { query(text: string): Promise<{ rows: unknown[]; rowCount: number }> };

    // 模拟旧版同步产物：session 表列名全部小写折叠，且已有数据
    await ddl.query(
      `CREATE TABLE "session" (
        "id" TEXT PRIMARY KEY,
        "userid" TEXT NOT NULL,
        "token" TEXT NOT NULL,
        "expiresat" TIMESTAMPTZ NOT NULL,
        "createdat" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    await ddl.query(
      `INSERT INTO "session" ("id", "userid", "token", "expiresat", "createdat")
       VALUES ('s-1', 'u-1', 'tok-1', NOW() + INTERVAL '1 day', NOW())`
    );

    const result = await syncSchema(pool);

    expect(result.synced).toBe(true);
    expect(result.addedColumns).toBe(0); // RENAME 不算新增列

    // 列名已保真为驼峰
    const cols = await ddl.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'session'`
    );
    const colNames = (cols.rows as Array<{ column_name: string }>).map((r) => r.column_name);
    expect(colNames).toContain("userId");
    expect(colNames).toContain("expiresAt");
    expect(colNames).not.toContain("userid");

    // 数据未丢失，且可经驼峰列名读到
    const rows = await ddl.query(`SELECT id, "userId", token FROM "session"`);
    expect(rows.rows).toEqual([{ id: "s-1", userId: "u-1", token: "tok-1" }]);
  });
});
