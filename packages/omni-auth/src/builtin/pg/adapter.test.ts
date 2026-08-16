import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgAdapter, buildPoolConfig } from "./adapter";

// PgAdapter 通过动态 import("pg") 延迟加载，mock 捕获 Pool 构造参数与 SQL
const mockPoolCtor = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("pg", () => ({
  Pool: class {
    constructor(config: unknown) {
      mockPoolCtor(config);
    }
    query = mockQuery;
    end = async () => {};
  },
}));

describe("PgAdapter", () => {
  beforeEach(() => {
    mockPoolCtor.mockClear();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("init() 延迟加载 pg 并透传连接池配置", async () => {
    const adapter = PgAdapter({
      url: "postgres://localhost:5432/db",
      ssl: true,
      pool: { max: 20 },
    });
    await adapter.init();
    expect(mockPoolCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: "postgres://localhost:5432/db",
        ssl: true,
        max: 20,
      })
    );
  });

  it("重复调用 init() 只创建一个连接池", async () => {
    const adapter = PgAdapter({ url: "postgres://localhost:5432/db" });
    await adapter.init();
    await adapter.init();
    expect(mockPoolCtor).toHaveBeenCalledTimes(1); // 同一实例只建一个池
  });

  it("SELECT 使用引号标识符保持驼峰列名（providerOpenid 而非 provideropenid）", async () => {
    const adapter = PgAdapter({ url: "postgres://localhost:5432/db" });
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
    const adapter = PgAdapter({ url: "postgres://localhost:5432/db" });
    await adapter.create({
      model: "socialAccount",
      data: { providerOpenid: "oid-1", userId: "u1", accessToken: "at" },
    });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO "socialAccount"');
    expect(sql).toContain('"providerOpenid"');
    expect(sql).toContain('"userId"');
  });
});

describe("buildPoolConfig", () => {
  it("透传 ssl 配置", () => {
    const config = buildPoolConfig({
      url: "postgres://localhost:5432/db",
      ssl: { rejectUnauthorized: false },
    });
    expect(config).toEqual(
      expect.objectContaining({ ssl: { rejectUnauthorized: false } })
    );
  });

  it("支持 ssl: true 形式", () => {
    const config = buildPoolConfig({
      url: "postgres://localhost:5432/db",
      ssl: true,
    });
    expect(config.ssl).toBe(true);
  });

  it("未配置 ssl 时 ssl 为 undefined", () => {
    const config = buildPoolConfig({ url: "postgres://localhost:5432/db" });
    expect(config.ssl).toBeUndefined();
  });

  it("应用连接池默认值与自定义值", () => {
    const defaults = buildPoolConfig({ url: "postgres://localhost:5432/db" });
    expect(defaults.max).toBe(10);
    expect(defaults.idleTimeoutMillis).toBe(30000);

    const custom = buildPoolConfig({
      url: "postgres://localhost:5432/db",
      pool: { max: 20, idleTimeoutMillis: 60000 },
    });
    expect(custom.max).toBe(20);
    expect(custom.idleTimeoutMillis).toBe(60000);
  });
});
