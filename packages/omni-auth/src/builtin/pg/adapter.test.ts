import { describe, it, expect } from "vitest";
import { buildPoolConfig } from "./adapter";

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
