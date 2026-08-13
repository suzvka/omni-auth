import { describe, it, expect, beforeEach } from "vitest";
import {
    requestCode,
    exchangeCode,
    registerVerificationSender,
} from "./verification-channel";
import type { VerificationSender } from "./verification-channel";
import type { DatabaseAdapter, WhereCondition } from "../adapters/database";
import type { SocialAccountRef } from "../social/token";

// ============================================================
// 内存 Mock DatabaseAdapter（参考 token.test.ts）
// ============================================================

function toTimestamp(val: unknown): number {
    if (val instanceof Date) return val.getTime();
    if (typeof val === "string") return new Date(val).getTime();
    if (typeof val === "number") return val;
    return NaN;
}

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
    _count: (model: string) => number;
    _records: (model: string) => Record<string, unknown>[];
    _createRaw: (model: string, data: Record<string, unknown>) => void;
}

function createMockDB(): MockDB {
    const store = new Map<string, Record<string, unknown>[]>();

    function getTable(model: string): Record<string, unknown>[] {
        if (!store.has(model)) store.set(model, []);
        return store.get(model)!;
    }

    const db: DatabaseAdapter = {
        async create({ model, data }) {
            const record = { ...data };
            getTable(model).push(record);
            return record;
        },
        async findOne({ model, where }) {
            return getTable(model).find((r) => matchesWhere(r, where)) ?? null;
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

    return {
        ...db,
        _count(model: string) {
            return getTable(model).length;
        },
        _records(model: string) {
            return getTable(model);
        },
        _createRaw(model: string, data: Record<string, unknown>) {
            getTable(model).push({ ...data });
        },
    };
}

// ============================================================
// Mock 验证码发送器
// ============================================================

let sentCode: string | null = null;
let sentChannelRef: SocialAccountRef | null = null;

const mockSender: VerificationSender = {
    async send(channel, code) {
        sentChannelRef = channel;
        sentCode = code;
    },
};

// ============================================================
// 测试
// ============================================================

describe("requestCode", () => {
    let db: MockDB;

    beforeEach(() => {
        db = createMockDB();
        sentCode = null;
        sentChannelRef = null;
        registerVerificationSender("email", mockSender);
    });

    it("创建 identifier 为 channel:{provider}:{providerOpenid} 的记录", async () => {
        await requestCode(db, "email", "user@example.com");

        const records = db._records("verification");
        expect(records).toHaveLength(1);
        expect(records[0].identifier).toBe("channel:email:user@example.com");
        expect(records[0].value).toBeDefined();
        expect(records[0].expiresAt).toBeInstanceOf(Date);
    });

    it("生成的验证码为 6 位数字 [100000, 999999]", async () => {
        for (let i = 0; i < 50; i++) {
            sentCode = null;
            // 每轮清空 verification 表
            db._records("verification").length = 0;
            await requestCode(db, "email", `user${i}@example.com`);
            expect(sentCode).not.toBeNull();
            expect(sentCode!).toMatch(/^\d{6}$/);
            const num = Number(sentCode);
            expect(num).toBeGreaterThanOrEqual(100000);
            expect(num).toBeLessThanOrEqual(999999);
        }
    });

    it("调用已注册的 sender 发送验证码", async () => {
        await requestCode(db, "email", "user@example.com");

        expect(sentCode).not.toBeNull();
        expect(sentChannelRef).not.toBeNull();
        expect(sentChannelRef!.provider).toBe("email");
        expect(sentChannelRef!.providerOpenid).toBe("user@example.com");
    });

    it("未注册 sender 时抛错", async () => {
        await expect(
            requestCode(db, "phone", "13800000000")
        ).rejects.toThrow('渠道 "phone" 未注册验证码发送器');
    });

    it("发送前清理同 identifier 的过期记录", async () => {
        const identifier = "channel:email:user@example.com";

        // 手动插入一条过期记录
        db._createRaw("verification", {
            id: "expired-1",
            identifier,
            value: "111111",
            expiresAt: new Date(Date.now() - 60_000), // 1 分钟前过期
        });

        // 插入一条仍有效的旧记录（应保留？不——requestCode 只清理过期的）
        db._createRaw("verification", {
            id: "valid-old",
            identifier,
            value: "222222",
            expiresAt: new Date(Date.now() + 60_000), // 1 分钟后过期
        });

        expect(db._count("verification")).toBe(2);

        await requestCode(db, "email", "user@example.com");

        // 过期记录被清理，有效旧记录 + 新记录 = 2 条
        expect(db._count("verification")).toBe(2);

        const ids = db._records("verification").map((r) => r.id);
        expect(ids).not.toContain("expired-1");
        expect(ids).toContain("valid-old");
    });

    it("未传入 channelRef 时构造最小引用", async () => {
        await requestCode(db, "email", "user@example.com");

        expect(sentChannelRef).not.toBeNull();
        expect(sentChannelRef!.id).toBe("");
        expect(sentChannelRef!.provider).toBe("email");
        expect(sentChannelRef!.providerOpenid).toBe("user@example.com");
        expect(sentChannelRef!.accessToken).toBeNull();
        expect(sentChannelRef!.refreshToken).toBeNull();
    });

    it("传入 channelRef 时原样传递给 sender", async () => {
        const fullRef: SocialAccountRef = {
            id: "ch-1",
            provider: "email",
            providerOpenid: "user@example.com",
            accessToken: "tok-abc",
            refreshToken: null,
            tokenExpiresAt: null,
            profileData: { name: "Test" },
        };

        await requestCode(db, "email", "user@example.com", fullRef);

        expect(sentChannelRef).toEqual(fullRef);
    });
});

// ---- exchangeCode ----

describe("exchangeCode", () => {
    let db: MockDB;

    beforeEach(() => {
        db = createMockDB();
        sentCode = null;
        sentChannelRef = null;
        registerVerificationSender("email", mockSender);
    });

    it("正确验证码返回 true 并删除记录（一次性消费）", async () => {
        await requestCode(db, "email", "user@example.com");
        const code = sentCode!;
        expect(db._count("verification")).toBe(1);

        const ok = await exchangeCode(db, "email", "user@example.com", code);
        expect(ok).toBe(true);

        // 记录被删除
        expect(db._count("verification")).toBe(0);

        // 再次消费同一验证码 → false（已删除）
        const ok2 = await exchangeCode(db, "email", "user@example.com", code);
        expect(ok2).toBe(false);
    });

    it("错误验证码返回 false 且不删除任何记录", async () => {
        await requestCode(db, "email", "user@example.com");
        expect(db._count("verification")).toBe(1);

        const ok = await exchangeCode(db, "email", "user@example.com", "000000");
        expect(ok).toBe(false);

        // 记录仍在
        expect(db._count("verification")).toBe(1);
    });

    it("过期的验证码返回 false 且不删除记录", async () => {
        const identifier = "channel:email:user@example.com";
        db._createRaw("verification", {
            id: "expired-code",
            identifier,
            value: "654321",
            expiresAt: new Date(Date.now() - 60_000), // 已过期
        });

        const ok = await exchangeCode(db, "email", "user@example.com", "654321");
        expect(ok).toBe(false);

        // 过期记录未被 exchangeCode 删除（由 requestCode 负责清理）
        expect(db._count("verification")).toBe(1);
    });

    it("不存在的验证码返回 false", async () => {
        const ok = await exchangeCode(db, "email", "nobody@example.com", "123456");
        expect(ok).toBe(false);
    });

    it("不同 identifier 互不干扰", async () => {
        registerVerificationSender("phone", mockSender);

        await requestCode(db, "email", "user@example.com");
        const emailCode = sentCode!;

        await requestCode(db, "phone", "13800000000");
        const phoneCode = sentCode!;

        // 用 email 验证码去验 phone 渠道 → false
        const cross = await exchangeCode(db, "phone", "13800000000", emailCode);
        expect(cross).toBe(false);

        // 各自正确验证码 → true
        expect(await exchangeCode(db, "email", "user@example.com", emailCode)).toBe(true);
        expect(await exchangeCode(db, "phone", "13800000000", phoneCode)).toBe(true);
    });
});
