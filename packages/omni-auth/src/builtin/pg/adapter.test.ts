import { describe, it, expect, vi } from "vitest";
import { PgAdapter, buildPoolConfig } from "./adapter";

// PgAdapter 通过动态 import("pg") 延迟加载，mock 捕获 Pool 构造参数
const mockPoolCtor = vi.hoisted(() => vi.fn());

vi.mock("pg", () => ({
  Pool: class {
    constructor(config: unknown) {
      mockPoolCtor(config);
    }
    query = async () => ({ rows: [], rowCount: 0 });
    end = async () => {};
  },
}));

describe("PgAdapter", () => {
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
    expect(mockPoolCtor).toHaveBeenCalledTimes(2); // 每个 adapter 实例一个池
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
