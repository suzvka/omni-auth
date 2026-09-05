import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgAdapter } from "./adapter";
import type { Pool, PoolClient } from "pg";

// PgAdapter 使用宿主注入的现成连接池（不自行创建/关闭池）
const mockQuery = vi.hoisted(() => vi.fn());

function createMockPool(): Pool {
  return {
    query: mockQuery,
    connect: vi.fn(),
    end: vi.fn(),
  } as unknown as Pool;
}

describe("PgAdapter", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("使用宿主注入的连接池（同一引用，不自行创建）", async () => {
    const pool = createMockPool();
    const adapter = PgAdapter({ pool });
    await adapter.init();
    expect(await adapter.getPool()).toBe(pool);
  });

  it("disconnect 不关闭注入池（池所有权归宿主）", async () => {
    const pool = createMockPool();
    const adapter = PgAdapter({ pool });
    await adapter.disconnect();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("SELECT 使用引号标识符保持驼峰列名（providerOpenid 而非 provideropenid）", async () => {
    const adapter = PgAdapter({ pool: createMockPool() });
    await adapter.findOne({
      model: "socialAccount",
      where: [{ field: "providerOpenid", value: "oid-1" }],
    });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('FROM "socialAccount"');
    expect(sql).toContain('"providerOpenid"');
  });

  it("INSERT 使用引号列名（数据写入驼峰列）", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "a1" }], rowCount: 1 });
    const adapter = PgAdapter({ pool: createMockPool() });
    await adapter.create({
      model: "socialAccount",
      data: { providerOpenid: "oid-1", userId: "u1", accessToken: "at" },
    });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO "socialAccount"');
    expect(sql).toContain('"providerOpenid"');
    expect(sql).toContain('"userId"');
  });

  it("事务从注入池取连接并执行 BEGIN/COMMIT", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = createMockPool();
    pool.connect = vi.fn().mockResolvedValue(client);

    const adapter = PgAdapter({ pool });
    await adapter.transaction!(async (tx) => {
      await tx.count({ model: "user", where: [] });
    });

    expect(pool.connect).toHaveBeenCalledTimes(1);
    const statements = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0]
    );
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("COUNT");
    expect(statements[statements.length - 1]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
