import { describe, it, expect, beforeEach } from "vitest";
import { hashPassword } from "@better-auth/utils/password";
import { createAccountDeletion, type UpdateProfileInput } from "./account";
import { InvalidPasswordError } from "../errors";
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
    /** 插入测试用户 + credential account */
    insertUserWithCredential: (
        userId: string,
        email: string,
        password: string,
    ) => Promise<void>;
    /** 插入 AuthToken 记录 */
    insertAuthToken: (userId: string) => void;
    /** 插入 BusinessAccount 记录 */
    insertBusinessAccount: (userId: string, displayName: string) => void;
    _count: (model: string) => number;
    _records: (model: string) => Record<string, unknown>[];
    _findUser: (userId: string) => Record<string, unknown> | null;
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
        async insertUserWithCredential(userId, email, password) {
            const now = new Date();
            const hashed = await hashPassword(password);
            getTable("user").push({
                id: userId,
                name: "Test User",
                email,
                emailVerified: false,
                image: null,
                createdAt: now,
                updatedAt: now,
            });
            getTable("account").push({
                id: `acc-${userId}`,
                accountId: userId,
                providerId: "credential",
                userId,
                password: hashed,
                createdAt: now,
                updatedAt: now,
            });
        },
        insertAuthToken(userId: string) {
            getTable("authToken").push({
                id: `token-${userId}-${Date.now()}`,
                tokenHash: "fake-hash",
                userId,
                metadata: {},
                expiresAt: new Date(Date.now() + 3600000),
                createdAt: new Date(),
            });
        },
        insertBusinessAccount(userId: string, displayName: string) {
            getTable("businessAccount").push({
                id: `biz-${userId}`,
                authUserId: userId,
                displayName,
                status: "active",
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
        _findUser(userId: string) {
            const table = getTable("user");
            return table.find((r) => r.id === userId) ?? null;
        },
    };

    return mock;
}

// ============================================================
// 测试
// ============================================================

// ---- deleteAccount ----

describe("deleteAccount", () => {
    let db: MockDB;

    beforeEach(async () => {
        db = createMockDB();
        await db.insertUserWithCredential("user-1", "test@example.com", "correct-pass-123");
    });

    it("正确密码 → 用户删除、token 吊销", async () => {
        // 插入一些 AuthToken
        db.insertAuthToken("user-1");
        db.insertAuthToken("user-1");
        expect(db._count("authToken")).toBe(2);

        const account = createAccountDeletion({ db });

        await account.deleteAccount("user-1", "correct-pass-123");

        // 用户已删除
        expect(db._count("user")).toBe(0);
        expect(db._findUser("user-1")).toBeNull();

        // AuthToken 已全部吊销
        expect(db._count("authToken")).toBe(0);

        // credential account 也应被删除（mock 不模拟 FK CASCADE，
        // 但 revokeAllTokens 已执行，且 deleteOne user 已执行）
    });

    it("错误密码 → 抛出 InvalidPasswordError", async () => {
        const account = createAccountDeletion({ db });

        await expect(
            account.deleteAccount("user-1", "wrong-password"),
        ).rejects.toThrow(InvalidPasswordError);

        // 用户不应被删除
        expect(db._count("user")).toBe(1);
        expect(db._findUser("user-1")).not.toBeNull();
    });

    it("错误密码 → 错误消息为「密码错误」", async () => {
        const account = createAccountDeletion({ db });

        try {
            await account.deleteAccount("user-1", "wrong-password");
            expect.fail("应抛出异常");
        } catch (err) {
            expect(err).toBeInstanceOf(InvalidPasswordError);
            expect((err as InvalidPasswordError).message).toBe("密码错误");
        }
    });

    it("账号不存在（无 credential account）→ 抛出 InvalidPasswordError", async () => {
        // 创建一个没有 credential account 的用户
        await db.create({
            model: "user",
            data: {
                id: "user-2",
                name: "No Credential",
                email: "nocred@test.com",
                emailVerified: false,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        });

        const account = createAccountDeletion({ db });

        await expect(
            account.deleteAccount("user-2", "any-password"),
        ).rejects.toThrow(InvalidPasswordError);
    });

    it("用户不存在 → 抛出 InvalidPasswordError（无 credential account）", async () => {
        const account = createAccountDeletion({ db });

        await expect(
            account.deleteAccount("nonexistent-user", "any-password"),
        ).rejects.toThrow(InvalidPasswordError);
    });

    it("其他用户的 token 不受影响", async () => {
        db.insertAuthToken("user-1");
        await db.insertUserWithCredential("user-2", "other@test.com", "other-pass-123");
        db.insertAuthToken("user-2");

        expect(db._count("authToken")).toBe(2);

        const account = createAccountDeletion({ db });
        await account.deleteAccount("user-1", "correct-pass-123");

        // user-1 已删除，user-2 仍在
        expect(db._findUser("user-1")).toBeNull();
        expect(db._findUser("user-2")).not.toBeNull();

        // user-1 的 token 已删除，user-2 的仍在
        const remainingTokens = db._records("authToken");
        expect(remainingTokens).toHaveLength(1);
        expect(remainingTokens[0].userId).toBe("user-2");
    });
});

// ---- updateProfile ----

describe("updateProfile", () => {
    let db: MockDB;

    beforeEach(async () => {
        db = createMockDB();
        await db.insertUserWithCredential("user-1", "test@example.com", "pass-123");
    });

    it("更新 name 字段", async () => {
        const account = createAccountDeletion({ db });
        const input: UpdateProfileInput = { name: "New Name" };

        await account.updateProfile("user-1", input);

        const user = db._findUser("user-1");
        expect(user!.name).toBe("New Name");
        expect(user!.updatedAt).toBeInstanceOf(Date);
    });

    it("更新 image 字段", async () => {
        const account = createAccountDeletion({ db });
        const input: UpdateProfileInput = { image: "https://cdn.test/avatar.png" };

        await account.updateProfile("user-1", input);

        const user = db._findUser("user-1");
        expect(user!.image).toBe("https://cdn.test/avatar.png");
    });

    it("同时更新 name 和 image", async () => {
        const account = createAccountDeletion({ db });
        const input: UpdateProfileInput = { name: "Combined", image: "https://cdn.test/x.png" };

        await account.updateProfile("user-1", input);

        const user = db._findUser("user-1");
        expect(user!.name).toBe("Combined");
        expect(user!.image).toBe("https://cdn.test/x.png");
    });

    it("name 变更时同步更新 BusinessAccount.displayName", async () => {
        db.insertBusinessAccount("user-1", "Old Name");
        const account = createAccountDeletion({ db });

        await account.updateProfile("user-1", { name: "Updated Name" });

        const biz = db._records("businessAccount")[0];
        expect(biz.displayName).toBe("Updated Name");
    });

    it("BusinessAccount 不存在时不报错（仅 warn）", async () => {
        const account = createAccountDeletion({ db });

        // 不插入 BusinessAccount，直接更新 name
        await expect(
            account.updateProfile("user-1", { name: "No Biz Account" }),
        ).resolves.toBeUndefined();

        const user = db._findUser("user-1");
        expect(user!.name).toBe("No Biz Account");
    });

    it("无字段更新时直接返回（no-op）", async () => {
        const account = createAccountDeletion({ db });
        const input: UpdateProfileInput = {};

        const userBefore = { ...db._findUser("user-1")! };

        await account.updateProfile("user-1", input);

        // 用户记录不变
        const userAfter = db._findUser("user-1");
        expect(userAfter!.name).toBe(userBefore.name);
        expect(userAfter!.image).toBe(userBefore.image);
    });

    it("不接收 RequestContext（直接接收 userId）", async () => {
        // 验证新接口：updateProfile 的第一个参数是 userId 字符串
        const account = createAccountDeletion({ db });

        // 传入 userId + input，不再需要 ctx
        await account.updateProfile("user-1", { name: "Direct userId" });

        const user = db._findUser("user-1");
        expect(user!.name).toBe("Direct userId");
    });
});
