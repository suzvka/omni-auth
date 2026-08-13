import { describe, it, expect, beforeEach } from "vitest";
import {
    generateToken,
    hashToken,
    validateMetadataSize,
    createAuthToken,
    validateToken,
    revokeToken,
    revokeAllTokens,
    cleanupExpiredTokens,
} from "./token";
import type { DatabaseAdapter, WhereCondition } from "../adapters/database";

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
    insertUser: (id: string) => void;
    _count: (model: string) => number;
    _records: (model: string) => Record<string, unknown>[];
}

/** 创建内存 Mock DB */
function createMockDB(options: { withUpsert?: boolean } = {}): MockDB {
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

    if (options.withUpsert) {
        db.upsert = async ({ model, data, conflictOn, update }) => {
            const table = getTable(model);
            // 查找冲突记录（conflictOn 字段匹配 data 中对应值）
            const idx = table.findIndex((r) =>
                conflictOn.every((field) => r[field] === data[field])
            );
            if (idx !== -1) {
                // 冲突：更新指定字段
                table[idx] = { ...table[idx], ...update };
                return table[idx];
            }
            // 无冲突：插入完整 data
            const record = { ...data };
            table.push(record);
            return record;
        };
    }

    const mock: MockDB = {
        ...db,
        insertUser(id: string) {
            getTable("user").push({
                id,
                name: "Test User",
                email: `${id}@test.com`,
                emailVerified: false,
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
// 测试
// ============================================================

// ---- 纯函数 ----

describe("generateToken", () => {
    it("生成 1000 个 token 全部唯一且长度为 43", () => {
        const tokens = new Set<string>();
        for (let i = 0; i < 1000; i++) {
            const token = generateToken();
            expect(token).toHaveLength(43);
            tokens.add(token);
        }
        expect(tokens.size).toBe(1000);
    });
});

describe("hashToken", () => {
    it("输出为 64 位 hex 字符（SHA-256）", () => {
        const hash = hashToken("test-token");
        expect(hash).toHaveLength(64);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("相同输入产生相同输出（确定性）", () => {
        const hash1 = hashToken("same-input");
        const hash2 = hashToken("same-input");
        expect(hash1).toBe(hash2);
    });

    it("不同输入产生不同输出", () => {
        const hash1 = hashToken("input-a");
        const hash2 = hashToken("input-b");
        expect(hash1).not.toBe(hash2);
    });
});

describe("validateMetadataSize", () => {
    it("undefined / null 不抛错", () => {
        expect(() => validateMetadataSize(undefined)).not.toThrow();
        expect(() => validateMetadataSize(null)).not.toThrow();
    });

    it("正常大小不抛错", () => {
        expect(() => validateMetadataSize({ foo: "bar" })).not.toThrow();
    });

    it("超限（>2KB）抛错", () => {
        const big = { data: "x".repeat(2100) };
        expect(() => validateMetadataSize(big)).toThrow("超过上限");
    });
});

// ---- createAuthToken（upsert 路径） ----

describe("createAuthToken（upsert 路径）", () => {
    let db: MockDB;

    beforeEach(() => {
        db = createMockDB({ withUpsert: true });
        db.insertUser("user-a");
    });

    it("存储哈希而非明文 token", async () => {
        const token = await createAuthToken(db, "user-a", 3600);
        expect(token).toHaveLength(43);

        const records = db._records("authToken");
        expect(records).toHaveLength(1);

        const record = records[0];
        expect(record.tokenHash).toHaveLength(64);
        expect(record.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        // 明文 token 不落库
        expect(record.token).toBeUndefined();
        expect(record.userId).toBe("user-a");
    });

    it("upsert 覆盖旧 token（同一用户仅 1 条记录）", async () => {
        const token1 = await createAuthToken(db, "user-a", 3600);
        expect(db._count("authToken")).toBe(1);

        const token2 = await createAuthToken(db, "user-a", 3600);
        expect(db._count("authToken")).toBe(1);

        // 旧 token 不再有效
        const result1 = await validateToken(db, token1);
        expect(result1).toBeNull();

        // 新 token 有效
        const result2 = await validateToken(db, token2);
        expect(result2).not.toBeNull();
        expect(result2!.userId).toBe("user-a");
    });

    it("metadata 往返一致", async () => {
        const metadata = { foo: "bar", num: 42 };
        const token = await createAuthToken(db, "user-a", 3600, metadata);

        const result = await validateToken(db, token);
        expect(result).not.toBeNull();
        expect(result!.metadata).toEqual({ foo: "bar", num: 42 });
    });

    it("metadata 超限拒绝", async () => {
        const bigMetadata = { data: "x".repeat(2100) };
        await expect(
            createAuthToken(db, "user-a", 3600, bigMetadata)
        ).rejects.toThrow("超过上限");
    });

    it("upsert 覆盖 metadata", async () => {
        await createAuthToken(db, "user-a", 3600, { a: 1 });
        const token2 = await createAuthToken(db, "user-a", 3600, { b: 2 });

        const result = await validateToken(db, token2);
        expect(result).not.toBeNull();
        expect(result!.metadata).toEqual({ b: 2 });
        expect(result!.metadata).not.toHaveProperty("a");
    });

    it("并发 upsert 原子性（同一用户仅 1 条记录）", async () => {
        const [token1, token2] = await Promise.all([
            createAuthToken(db, "user-a", 3600),
            createAuthToken(db, "user-a", 3600),
        ]);

        // 仅 1 条记录
        expect(db._count("authToken")).toBe(1);

        // 其中一个 token 有效，另一个无效
        const r1 = await validateToken(db, token1);
        const r2 = await validateToken(db, token2);
        const validCount = (r1 ? 1 : 0) + (r2 ? 1 : 0);
        expect(validCount).toBe(1);
    });
});

// ---- validateToken ----

describe("validateToken", () => {
    let db: MockDB;

    beforeEach(() => {
        db = createMockDB({ withUpsert: true });
        db.insertUser("user-a");
    });

    it("有效 token 返回 userId 和 metadata", async () => {
        const token = await createAuthToken(db, "user-a", 3600, { role: "admin" });

        const result = await validateToken(db, token);
        expect(result).not.toBeNull();
        expect(result!.userId).toBe("user-a");
        expect(result!.metadata).toEqual({ role: "admin" });
    });

    it("不存在的 token 返回 null", async () => {
        const result = await validateToken(db, "nonexistent-token");
        expect(result).toBeNull();
    });

    it("过期 token 返回 null 且记录被删除", async () => {
        // expiresIn = -1 → 已过期
        const token = await createAuthToken(db, "user-a", -1);
        expect(db._count("authToken")).toBe(1);

        const result = await validateToken(db, token);
        expect(result).toBeNull();
        // 过期记录应被清理
        expect(db._count("authToken")).toBe(0);
    });

    it("用户已删除时返回 null 并清理孤儿 token", async () => {
        const token = await createAuthToken(db, "user-a", 3600);

        // 删除用户
        await db.deleteOne({
            model: "user",
            where: [{ field: "id", value: "user-a" }],
        });

        const result = await validateToken(db, token);
        expect(result).toBeNull();
        expect(db._count("authToken")).toBe(0);
    });
});

// ---- revokeToken ----

describe("revokeToken", () => {
    let db: MockDB;

    beforeEach(() => {
        db = createMockDB({ withUpsert: true });
        db.insertUser("user-a");
        db.insertUser("user-b");
    });

    it("正确 userId 吊销成功", async () => {
        const token = await createAuthToken(db, "user-a", 3600);
        expect(db._count("authToken")).toBe(1);

        const ok = await revokeToken(db, "user-a", token);
        expect(ok).toBe(true);
        expect(db._count("authToken")).toBe(0);

        // 吊销后不再有效
        const result = await validateToken(db, token);
        expect(result).toBeNull();
    });

    it("错误 userId 不删除记录", async () => {
        const token = await createAuthToken(db, "user-a", 3600);

        const ok = await revokeToken(db, "user-b", token);
        expect(ok).toBe(false);
        expect(db._count("authToken")).toBe(1);
    });
});

// ---- revokeAllTokens ----

describe("revokeAllTokens", () => {
    let db: MockDB;

    beforeEach(() => {
        db = createMockDB({ withUpsert: true });
        db.insertUser("user-a");
        db.insertUser("user-b");
    });

    it("吊销用户全部 token，其他用户不受影响", async () => {
        await createAuthToken(db, "user-a", 3600);
        await createAuthToken(db, "user-b", 3600);

        const count = await revokeAllTokens(db, "user-a");
        expect(count).toBe(1);
        expect(db._count("authToken")).toBe(1);

        // user-b 的 token 仍在
        const records = db._records("authToken");
        expect(records[0].userId).toBe("user-b");
    });
});

// ---- cleanupExpiredTokens ----

describe("cleanupExpiredTokens", () => {
    let db: MockDB;

    beforeEach(() => {
        db = createMockDB({ withUpsert: true });
        db.insertUser("user-a");
        db.insertUser("user-b");
    });

    it("清理过期记录并返回数量", async () => {
        // 创建一个过期 token 和一个有效 token
        await createAuthToken(db, "user-a", -1);     // 过期
        await createAuthToken(db, "user-b", 3600);   // 有效

        // 由于 user-a 的 token 过期，upsert 时已覆盖（仅 1 条 per user）
        // 但它们是不同用户，所以 2 条记录
        expect(db._count("authToken")).toBe(2);

        const count = await cleanupExpiredTokens(db);
        expect(count).toBe(1);
        expect(db._count("authToken")).toBe(1);

        // 剩余记录是 user-b 的（有效）
        const records = db._records("authToken");
        expect(records[0].userId).toBe("user-b");
    });

    it("无过期记录时返回 0", async () => {
        await createAuthToken(db, "user-a", 3600);

        const count = await cleanupExpiredTokens(db);
        expect(count).toBe(0);
    });
});

// ---- 回退路径（无 upsert） ----

describe("回退路径（无 upsert）", () => {
    let db: MockDB;

    beforeEach(() => {
        db = createMockDB({ withUpsert: false });
        db.insertUser("user-a");
    });

    it("createAuthToken 正常工作", async () => {
        const token = await createAuthToken(db, "user-a", 3600);
        expect(token).toHaveLength(43);
        expect(db._count("authToken")).toBe(1);

        const result = await validateToken(db, token);
        expect(result).not.toBeNull();
        expect(result!.userId).toBe("user-a");
    });

    it("覆盖旧 token（delete + create 回退）", async () => {
        const token1 = await createAuthToken(db, "user-a", 3600);
        expect(db._count("authToken")).toBe(1);

        const token2 = await createAuthToken(db, "user-a", 3600);
        expect(db._count("authToken")).toBe(1);

        // 旧 token 失效
        const r1 = await validateToken(db, token1);
        expect(r1).toBeNull();

        // 新 token 有效
        const r2 = await validateToken(db, token2);
        expect(r2).not.toBeNull();
        expect(r2!.userId).toBe("user-a");
    });

    it("metadata 往返一致", async () => {
        const token = await createAuthToken(db, "user-a", 3600, { foo: "bar", num: 42 });

        const result = await validateToken(db, token);
        expect(result).not.toBeNull();
        expect(result!.metadata).toEqual({ foo: "bar", num: 42 });
    });

    it("过期 token 被清理", async () => {
        const token = await createAuthToken(db, "user-a", -1);
        expect(db._count("authToken")).toBe(1);

        const result = await validateToken(db, token);
        expect(result).toBeNull();
        expect(db._count("authToken")).toBe(0);
    });
});
