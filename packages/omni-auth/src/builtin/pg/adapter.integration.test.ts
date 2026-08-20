// ============================================================
// PgAdapter 真实数据库集成测试
//
// 仅在设置 OMNI_AUTH_TEST_PG_URL 环境变量时运行，否则跳过。
// 例：OMNI_AUTH_TEST_PG_URL=postgres://user:pass@localhost:5432/test pnpm test
//
// 覆盖单元测试无法验证的关键路径：
// - 真实 SQL 执行与驼峰列名引号保真
// - 唯一约束冲突（23505）→ code=UNIQUE_VIOLATION 的 OmniAuthError（isUniqueViolation 守卫）
// - 单连接事务 BEGIN/COMMIT/ROLLBACK
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PgAdapter } from "./adapter";
import { isUniqueViolation } from "../../errors";
import { Pool } from "pg";

const PG_URL = process.env.OMNI_AUTH_TEST_PG_URL;

// 唯一表名，避免并行运行冲突
const TABLE = `omni_auth_it_${Date.now()}`;

describe.runIf(Boolean(PG_URL))("PgAdapter 集成测试（真实 PostgreSQL）", () => {
    // 测试自身作为宿主创建/关闭连接池（注入模式）
    const pool = new Pool({ connectionString: PG_URL! });
    const adapter = PgAdapter({ pool });

    beforeAll(async () => {
        // 普通表（非 TEMP）：连接池多连接可见；唯一表名避免并行冲突
        await pool.query(
            `CREATE TABLE IF NOT EXISTS ${TABLE} (
                "id" TEXT PRIMARY KEY,
                "email" TEXT NOT NULL UNIQUE,
                "name" TEXT,
                "createdAt" TIMESTAMPTZ NOT NULL
            )`
        );
    });

    afterAll(async () => {
        try {
            await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
        } finally {
            await pool.end(); // 池所有权归宿主（测试）
        }
    });

    it("create / findOne / updateOne / deleteOne 全流程（驼峰列名保真）", async () => {
        const now = new Date();

        const created = (await adapter.create({
            model: TABLE,
            data: { id: "u1", email: "a@it.local", name: "A", createdAt: now },
        })) as { id: string; email: string };
        expect(created.id).toBe("u1");
        expect(created.email).toBe("a@it.local");

        const found = (await adapter.findOne({
            model: TABLE,
            where: [{ field: "email", value: "a@it.local" }],
        })) as { id: string } | null;
        expect(found?.id).toBe("u1");

        const updated = (await adapter.updateOne({
            model: TABLE,
            where: [{ field: "id", value: "u1" }],
            update: { name: "A2" },
        })) as { name: string };
        expect(updated.name).toBe("A2");

        const deleted = (await adapter.deleteOne({
            model: TABLE,
            where: [{ field: "id", value: "u1" }],
        })) as { id: string };
        expect(deleted.id).toBe("u1");

        expect(
            await adapter.findOne({ model: TABLE, where: [{ field: "id", value: "u1" }] })
        ).toBeNull();
    });

    it("唯一约束冲突转译为 code=UNIQUE_VIOLATION（isUniqueViolation 守卫命中）", async () => {
        await adapter.create({
            model: TABLE,
            data: { id: "u2", email: "dup@it.local", name: "B", createdAt: new Date() },
        });

        await expect(
            adapter.create({
                model: TABLE,
                data: { id: "u3", email: "dup@it.local", name: "C", createdAt: new Date() },
            })
        ).rejects.toSatisfy(isUniqueViolation);
    });

    it("transaction 正常提交", async () => {
        await adapter.transaction!(async (tx) => {
            await tx.create({
                model: TABLE,
                data: { id: "tx1", email: "tx1@it.local", name: "T", createdAt: new Date() },
            });
        });

        const row = await adapter.findOne({
            model: TABLE,
            where: [{ field: "id", value: "tx1" }],
        });
        expect(row).not.toBeNull();
    });

    it("transaction 抛错时整体回滚", async () => {
        await expect(
            adapter.transaction!(async (tx) => {
                await tx.create({
                    model: TABLE,
                    data: { id: "tx2", email: "tx2@it.local", name: "T", createdAt: new Date() },
                });
                throw new Error("simulated failure");
            })
        ).rejects.toThrow("simulated failure");

        expect(
            await adapter.findOne({ model: TABLE, where: [{ field: "id", value: "tx2" }] })
        ).toBeNull();
    });
});
