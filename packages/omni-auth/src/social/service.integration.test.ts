import { describe, it, expect } from "vitest";
import { newDb, type IMemoryDb } from "pg-mem";
import { syncSchema } from "../schema-sync";
import { PgAdapter, type PgPoolLike } from "../builtin/pg/adapter";
import { createSocialService } from "./service";

// ============================================================
// bindToUser 与 autoSync 建表协同的集成冒烟（pg-mem 内存库）
//
// 回归场景：autoSync 建出的 socialAccount.id 为 TEXT NOT NULL PK
// （无 DB DEFAULT），bindToUser 必须应用层生成 id 才能插入成功。
// 若回归到"不传 id"，本测试在真实约束下会因 NOT NULL 违反失败。
// ============================================================

function createMemPool(): { db: IMemoryDb; pool: PgPoolLike } {
  // noAstCoverageCheck: 容忍 CREATE TABLE IF NOT EXISTS 等未覆盖的 AST 分支
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as unknown as PgPoolLike;
  return { db, pool };
}

describe("bindToUser（autoSync 建表 + pg 适配器集成）", () => {
  it("全新库：autoSync 建表后 bindToUser 可成功插入并回查", async () => {
    const { pool } = createMemPool();

    // 模拟 createQuickAuth({ autoSync: true })：空库执行幂等 DDL
    const result = await syncSchema(pool);
    expect(result.synced).toBe(true);

    const adapter = PgAdapter({ pool });
    const social = createSocialService(adapter);

    // 绑定社交账户（全新库注册路径的真实写操作）
    const record = await social.bindToUser("user_1", {
      provider: "wechat",
      providerOpenid: "oid_integration",
      accessToken: "at_int",
      profileData: { nickname: "集成测试" },
    });

    expect(record.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    // 数据可经语义 API 回查（确认真实落库而非仅返回形状）
    const found = await social.findByProvider("wechat", "oid_integration");
    expect(found?.id).toBe(record.id);
    expect(found?.userId).toBe("user_1");
    expect(found?.profileData).toEqual({ nickname: "集成测试" });
  });

  it("同库绑定第二个账户时 id 仍唯一（冲突走唯一约束不撞 id）", async () => {
    const { pool } = createMemPool();
    await syncSchema(pool);

    const social = createSocialService(PgAdapter({ pool }));

    const r1 = await social.bindToUser("user_1", {
      provider: "wechat",
      providerOpenid: "oid_a",
    });
    const r2 = await social.bindToUser("user_2", {
      provider: "wechat",
      providerOpenid: "oid_b",
    });

    expect(r1.id).not.toBe(r2.id);
  });
});
