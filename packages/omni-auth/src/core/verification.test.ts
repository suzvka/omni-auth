import { describe, it, expect, beforeEach, vi } from "vitest";
import { createEmailVerification } from "./verification";
import type { DatabaseAdapter, WhereCondition } from "../adapters/database";
import type { EmailAdapter } from "../adapters/email";

// ============================================================
// 内存 Mock DatabaseAdapter
// ============================================================

/** 将值转为时间戳用于 lt/gt 等比较 */
function toTimestamp(val: unknown): number {
    if (val instanceof Date) return val.getTime();
    if (typeof val === "string") return new Date(val).getTime();
    if (typeof val === "number") return val;
    return NaN;
}

/** 判断单条记录是否匹配所有 where 条件（AND 语义） */
function matchesWhere(record: Record<string, unknown>, where: WhereCondition[]): boolean {
    return where.every((cond) => {
        const op = cond.operator ?? "eq";
        const val = record[cond.field];
        switch (op) {
            case "eq":
                return val === cond.value;
            case "neq":
                return val !== cond.value;
            case "lt":
                return toTimestamp(val) < toTimestamp(cond.value);
            case "gt":
                return toTimestamp(val) > toTimestamp(cond.value);
            case "lte":
                return toTimestamp(val) <= toTimestamp(cond.value);
            case "gte":
                return toTimestamp(val) >= toTimestamp(cond.value);
            case "in": {
                const arr = Array.isArray(cond.value) ? cond.value : [cond.value];
                return arr.includes(val);
            }
            default:
                return val === cond.value;
        }
    });
}

interface MockDB extends DatabaseAdapter {
    insertUser: (id: string, email: string) => void;
    _count: (model: string) => number;
    _records: (model: string) => Record<string, unknown>[];
}

/** 创建内存 Mock DB */
function createMockDB(): MockDB {
    const store = new Map<string, Record<string, unknown>[]>();

    function getTable(model: string): Record<string, unknown>[] {
        if (!store.has(model)) store.set(model, []);
        return store.get(model)!;
    }

    const db: DatabaseAdapter = {
        async create({ model, data }) {
            const table = getTable(model);
            const record = { ...data };
            table.push(record);
            return record;
        },

        async findOne({ model, where }) {
            const table = getTable(model);
            return table.find((r) => matchesWhere(r, where)) ?? null;
        },

        async findMany({ model, where, limit, offset }) {
            let results = getTable(model);
            if (where) results = results.filter((r) => matchesWhere(r, where));
            if (offset) results = results.slice(offset);
            if (limit != null) results = results.slice(0, limit);
            return results;
        },

        async count({ model, where }) {
            let results = getTable(model);
            if (where) results = results.filter((r) => matchesWhere(r, where));
            return results.length;
        },

        async updateOne({ model, where, update }) {
            const table = getTable(model);
            const idx = table.findIndex((r) => matchesWhere(r, where));
            if (idx === -1) return null;
            table[idx] = { ...table[idx], ...update };
            return table[idx];
        },

        async updateMany({ model, where, update }) {
            const table = getTable(model);
            let cnt = 0;
            for (let i = 0; i < table.length; i++) {
                if (matchesWhere(table[i], where)) {
                    table[i] = { ...table[i], ...update };
                    cnt++;
                }
            }
            return cnt;
        },

        async deleteOne({ model, where }) {
            const table = getTable(model);
            const idx = table.findIndex((r) => matchesWhere(r, where));
            if (idx === -1) return null;
            const [deleted] = table.splice(idx, 1);
            return deleted;
        },

        async deleteMany({ model, where }) {
            const table = getTable(model);
            const toDelete = table.filter((r) => matchesWhere(r, where));
            const toKeep = table.filter((r) => !matchesWhere(r, where));
            table.length = 0;
            table.push(...toKeep);
            return toDelete.length;
        },

        async init() {},
        async disconnect() {},
    };

    const mock: MockDB = {
        ...db,
        insertUser(id: string, email: string) {
            getTable("user").push({
                id,
                name: "Test User",
                email,
                emailVerified: false,
                image: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        },
        _count(model: string) {
            return getTable(model).length;
        },
        _records(model: string) {
            return getTable(model);
        },
    };

    return mock;
}

// ============================================================
// Mock EmailAdapter
// ============================================================

interface MockEmailAdapter extends EmailAdapter {
    calls: Array<{ to: string; subject: string; url: string; token: string }>;
}

function createMockEmailAdapter(): MockEmailAdapter {
    return {
        calls: [],
        async sendVerificationEmail(params) {
            this.calls.push({ ...params });
        },
        async sendPasswordResetEmail() {},
    };
}

// ============================================================
// 测试
// ============================================================

// ---- requestVerification ----

describe("requestVerification", () => {
    let db: MockDB;
    let emailAdapter: MockEmailAdapter;

    beforeEach(() => {
        db = createMockDB();
        db.insertUser("user-1", "test@example.com");
        emailAdapter = createMockEmailAdapter();
    });

    it("生成 43 字符 base64url token 并存入 Verification 表", async () => {
        const verification = createEmailVerification({
            db,
            email: emailAdapter,
            baseUrl: "https://app.test",
        });

        const token = await verification.requestVerification("user-1", "test@example.com");

        // token 格式校验
        expect(token).toHaveLength(43);
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

        // Verification 表有 1 条记录
        expect(db._count("verification")).toBe(1);

        const record = db._records("verification")[0];
        expect(record.value).toBe(token);
        expect(record.identifier).toBe("verify-email:test@example.com");
        expect(record.expiresAt).toBeInstanceOf(Date);

        // expiresAt 应在 ~1 小时后
        const ttl = (record.expiresAt as Date).getTime() - Date.now();
        expect(ttl).toBeGreaterThan(59 * 60 * 1000); // > 59 分钟
        expect(ttl).toBeLessThan(61 * 60 * 1000); // < 61 分钟
    });

    it("identifier 格式为 verify-email:{email}", async () => {
        const verification = createEmailVerification({ db, email: null });

        await verification.requestVerification("user-1", "alice@domain.com");

        const record = db._records("verification")[0];
        expect(record.identifier).toBe("verify-email:alice@domain.com");
    });

    it("清理同一邮箱的旧验证记录（防累积）", async () => {
        const verification = createEmailVerification({ db, email: null });

        // 第一次请求
        const token1 = await verification.requestVerification("user-1", "test@example.com");
        expect(db._count("verification")).toBe(1);

        // 第二次请求（同邮箱）
        const token2 = await verification.requestVerification("user-1", "test@example.com");
        expect(db._count("verification")).toBe(1);

        // 旧 token 不应再有效
        const record = db._records("verification")[0];
        expect(record.value).toBe(token2);
        expect(record.value).not.toBe(token1);
    });

    it("不同邮箱的验证记录互不影响", async () => {
        const verification = createEmailVerification({ db, email: null });

        await verification.requestVerification("user-1", "a@test.com");
        await verification.requestVerification("user-1", "b@test.com");

        expect(db._count("verification")).toBe(2);

        const identifiers = db._records("verification").map((r) => r.identifier);
        expect(identifiers).toContain("verify-email:a@test.com");
        expect(identifiers).toContain("verify-email:b@test.com");
    });

    it("EmailAdapter 可用时发送验证邮件", async () => {
        const verification = createEmailVerification({
            db,
            email: emailAdapter,
            baseUrl: "https://app.test",
        });

        const token = await verification.requestVerification("user-1", "test@example.com");

        expect(emailAdapter.calls).toHaveLength(1);
        const call = emailAdapter.calls[0];
        expect(call.to).toBe("test@example.com");
        expect(call.token).toBe(token);
        expect(call.url).toBe(`https://app.test/verify-email?token=${encodeURIComponent(token)}`);
    });

    it("EmailAdapter 为 null 时不发送邮件但仍返回 token", async () => {
        const verification = createEmailVerification({ db, email: null });

        const token = await verification.requestVerification("user-1", "test@example.com");

        expect(token).toHaveLength(43);
        expect(db._count("verification")).toBe(1);
        // 无邮件适配器，无异常即通过
    });

    it("未提供 baseUrl 时 url 仅含 token 参数", async () => {
        const verification = createEmailVerification({
            db,
            email: emailAdapter,
        });

        const token = await verification.requestVerification("user-1", "test@example.com");

        expect(emailAdapter.calls[0].url).toBe(`?token=${encodeURIComponent(token)}`);
    });
});

// ---- verify ----

describe("verify", () => {
    let db: MockDB;

    beforeEach(() => {
        db = createMockDB();
        db.insertUser("user-1", "verify@test.com");
    });

    it("有效 token → 更新 user.emailVerified 且删除验证记录", async () => {
        const verification = createEmailVerification({ db, email: null });

        const token = await verification.requestVerification("user-1", "verify@test.com");
        expect(db._count("verification")).toBe(1);

        // 验证前 user.emailVerified = false
        const userBefore = db._records("user")[0];
        expect(userBefore.emailVerified).toBe(false);

        // 执行验证
        const email = await verification.verify(token);

        // 返回邮箱地址
        expect(email).toBe("verify@test.com");

        // user.emailVerified 已更新为 true
        const userAfter = db._records("user")[0];
        expect(userAfter.emailVerified).toBe(true);

        // 验证记录已删除（一次性使用）
        expect(db._count("verification")).toBe(0);
    });

    it("无效 token → 抛出错误", async () => {
        const verification = createEmailVerification({ db, email: null });

        await expect(
            verification.verify("nonexistent-token-xxx"),
        ).rejects.toThrow("验证链接无效或已过期");
    });

    it("过期 token → 抛出错误且删除记录", async () => {
        const verification = createEmailVerification({ db, email: null });

        // 手动插入一条已过期的验证记录
        const pastDate = new Date(Date.now() - 1000);
        await db.create({
            model: "verification",
            data: {
                id: "expired-record",
                identifier: "verify-email:expired@test.com",
                value: "expired-token",
                expiresAt: pastDate,
                createdAt: pastDate,
                updatedAt: pastDate,
            },
        });

        expect(db._count("verification")).toBe(1);

        await expect(
            verification.verify("expired-token"),
        ).rejects.toThrow("验证链接无效或已过期");

        // 过期记录应被清理
        expect(db._count("verification")).toBe(0);
    });

    it("已使用的 token 不可重复验证", async () => {
        const verification = createEmailVerification({ db, email: null });

        const token = await verification.requestVerification("user-1", "verify@test.com");

        // 第一次验证成功
        await verification.verify(token);

        // 第二次验证应失败（记录已删除）
        await expect(
            verification.verify(token),
        ).rejects.toThrow("验证链接无效或已过期");
    });

    it("verify 不依赖 userId 参数（仅靠 token 查找）", async () => {
        const verification = createEmailVerification({ db, email: null });

        const token = await verification.requestVerification("user-1", "verify@test.com");

        // verify 仅接收 token 参数
        const email = await verification.verify(token);
        expect(email).toBe("verify@test.com");
    });
});
