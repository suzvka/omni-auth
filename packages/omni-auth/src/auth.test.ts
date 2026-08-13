import { describe, it, expect, vi } from "vitest";

// mock next/headers（测试环境兼容）
vi.mock("next/headers", () => ({
    headers: async () => new Headers(),
}));

import { createAuth, type OmniAuthConfig } from "./auth";
import type { DatabaseAdapter, WhereCondition } from "./adapters/database";
import { verifyPassword } from "@better-auth/utils/password";

// ----------------------------------------------------------
// 完整内存数据库
// ----------------------------------------------------------

function createInMemoryDb(): DatabaseAdapter & {
    dump(model: string): Record<string, unknown>[];
} {
    const store = new Map<string, Map<string, Record<string, unknown>>>();

    function ensureModel(model: string) {
        if (!store.has(model)) store.set(model, new Map());
        return store.get(model)!;
    }

    function matchWhere(record: Record<string, unknown>, where: WhereCondition[]): boolean {
        return where.every((w) => {
            const val = record[w.field];
            switch (w.operator) {
                case "neq":
                    return val !== w.value;
                case "lt":
                    return val instanceof Date
                        ? val.getTime() < new Date(w.value as string).getTime()
                        : Number(val) < Number(w.value);
                case "gt":
                    return val instanceof Date
                        ? val.getTime() > new Date(w.value as string).getTime()
                        : Number(val) > Number(w.value);
                case "lte":
                    return val instanceof Date
                        ? val.getTime() <= new Date(w.value as string).getTime()
                        : Number(val) <= Number(w.value);
                case "gte":
                    return val instanceof Date
                        ? val.getTime() >= new Date(w.value as string).getTime()
                        : Number(val) >= Number(w.value);
                case "in":
                    return Array.isArray(w.value) && w.value.includes(val);
                default:
                    return val === w.value;
            }
        });
    }

    const db: DatabaseAdapter = {
        async create({ model, data }) {
            const table = ensureModel(model);
            const id = (data.id as string) ?? String(Math.random());
            const record = { ...data, id };
            table.set(id, record);
            return record;
        },
        async findOne({ model, where }) {
            const table = ensureModel(model);
            for (const [, r] of table) {
                if (matchWhere(r, where)) return r;
            }
            return null;
        },
        async findMany({ model, where, limit, offset }) {
            const table = ensureModel(model);
            const results: Record<string, unknown>[] = [];
            for (const [, r] of table) {
                if (!where || matchWhere(r, where)) results.push(r);
            }
            const sliced = limit != null ? results.slice(0, limit) : results;
            return offset != null ? sliced.slice(offset) : sliced;
        },
        async count({ model, where }) {
            const table = ensureModel(model);
            let n = 0;
            for (const [, r] of table) {
                if (!where || matchWhere(r, where)) n++;
            }
            return n;
        },
        async updateOne({ model, where, update }) {
            const table = ensureModel(model);
            for (const [, r] of table) {
                if (matchWhere(r, where)) {
                    Object.assign(r, update);
                    return r;
                }
            }
            return null;
        },
        async updateMany({ model, where, update }) {
            const table = ensureModel(model);
            let n = 0;
            for (const [, r] of table) {
                if (!where || matchWhere(r, where)) {
                    Object.assign(r, update);
                    n++;
                }
            }
            return n;
        },
        async deleteOne({ model, where }) {
            const table = ensureModel(model);
            for (const [id, r] of table) {
                if (matchWhere(r, where)) {
                    table.delete(id);
                    return r;
                }
            }
            return null;
        },
        async deleteMany({ model, where }) {
            const table = ensureModel(model);
            let n = 0;
            for (const [id, r] of [...table]) {
                if (!where || matchWhere(r, where)) {
                    table.delete(id);
                    n++;
                }
            }
            return n;
        },
        async upsert({ model, data, conflictOn, update }) {
            const table = ensureModel(model);
            // 查找冲突记录
            let existingId: string | null = null;
            for (const [id, r] of table) {
                if (conflictOn.every((field) => r[field] === data[field])) {
                    existingId = id;
                    break;
                }
            }
            if (existingId) {
                const r = table.get(existingId)!;
                Object.assign(r, update, { updatedAt: new Date() });
                return r;
            }
            const id = (data.id as string) ?? String(Math.random());
            const record = { ...data, id };
            table.set(id, record);
            return record;
        },
    };

    return {
        ...db,
        dump(model: string) {
            return [...ensureModel(model).values()];
        },
    };
}

const AUTH_CONFIG = {
    secret: "0123456789abcdef0123456789abcdef",
    baseUrl: "http://localhost:3000",
};

/** 创建测试用 auth 实例 */
function createTestAuth(
    memDb: ReturnType<typeof createInMemoryDb>,
    extra?: Partial<OmniAuthConfig>,
) {
    return createAuth({
        database: memDb,
        ...AUTH_CONFIG,
        ...extra,
    });
}

// ----------------------------------------------------------
// 测试
// ----------------------------------------------------------

describe("OmniAuth 凭证校验", () => {
    it("signUp 创建 user + account（不创建会话令牌）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        const result = await auth.signUp({
            email: "alice@test.local",
            password: "password123",
            name: "Alice",
        });

        // 返回用户信息
        expect(result.userId).toBeTruthy();
        expect(result.user.email).toBe("alice@test.local");

        // user 表有 1 条记录
        const users = memDb.dump("user");
        expect(users.length).toBe(1);
        expect(users[0].email).toBe("alice@test.local");

        // account 表有 1 条记录，providerId = credential，password 已哈希
        const accounts = memDb.dump("account");
        expect(accounts.length).toBe(1);
        expect(accounts[0].providerId).toBe("credential");
        expect(accounts[0].password).toBeTruthy();
        expect(accounts[0].password).not.toBe("password123"); // 确认不是明文
    });

    it("signUp 密码长度不足 6 位时拒绝", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await expect(
            auth.signUp({ email: "short@test.local", password: "123", name: "Short" })
        ).rejects.toThrow("密码长度不能少于 6 位");
    });

    it("signUp 重复邮箱时拒绝", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await auth.signUp({ email: "dup@test.local", password: "password123", name: "Dup1" });

        await expect(
            auth.signUp({ email: "dup@test.local", password: "password456", name: "Dup2" })
        ).rejects.toThrow("该邮箱已被注册");
    });

    it("signUp 后 signIn 校验密码成功并返回用户", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        const signUpResult = await auth.signUp({
            email: "bob@test.local",
            password: "password123",
            name: "Bob",
        });

        const signInResult = await auth.signIn({
            email: "bob@test.local",
            password: "password123",
        });

        expect(signInResult.userId).toBe(signUpResult.userId);
        expect(signInResult.user.email).toBe("bob@test.local");
    });

    it("signIn 密码错误时拒绝", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await auth.signUp({
            email: "eve@test.local",
            password: "password123",
            name: "Eve",
        });

        await expect(
            auth.signIn({ email: "eve@test.local", password: "wrong-password" })
        ).rejects.toThrow("邮箱或密码错误");
    });

    it("signIn 邮箱不存在时拒绝（统一错误消息防枚举）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await expect(
            auth.signIn({ email: "nobody@test.local", password: "password123" })
        ).rejects.toThrow("邮箱或密码错误");
    });

    it("signUp 触发 onUserCreated hook", async () => {
        const memDb = createInMemoryDb();
        let hookPayload: { userId: string; email?: string; name?: string } | null = null;

        const auth = createTestAuth(memDb, {
            hooks: {
                onUserCreated: async (payload) => {
                    hookPayload = payload;
                },
            },
        });

        const result = await auth.signUp({
            email: "hook@test.local",
            password: "password123",
            name: "Hook",
        });

        expect(hookPayload).not.toBeNull();
        expect(hookPayload!.userId).toBe(result.userId);
        expect(hookPayload!.email).toBe("hook@test.local");
        expect(hookPayload!.name).toBe("Hook");
    });

    it("signUp 自动创建 BusinessAccount（无需 hooks）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        const result = await auth.signUp({
            email: "biz@test.local",
            password: "password123",
            name: "Biz",
        });

        // BusinessAccount 已自动创建（不依赖 hooks）
        const bizAccounts = memDb.dump("businessAccount");
        expect(bizAccounts.length).toBe(1);
        expect(bizAccounts[0].authUserId).toBe(result.userId);
        expect(bizAccounts[0].displayName).toBe("Biz");
        expect(bizAccounts[0].status).toBe("active");
    });

    it("密码使用 hashPassword/verifyPassword（非明文存储）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await auth.signUp({
            email: "hash@test.local",
            password: "mypassword",
            name: "Hash",
        });

        // 从 DB 读取 account 记录
        const accounts = memDb.dump("account");
        const storedHash = accounts[0].password as string;

        // 确认存储的是哈希值
        expect(storedHash).not.toBe("mypassword");

        // 确认 verifyPassword 能校验
        const isValid = await verifyPassword(storedHash, "mypassword");
        expect(isValid).toBe(true);

        // 确认错误密码校验失败
        const isInvalid = await verifyPassword(storedHash, "wrong");
        expect(isInvalid).toBe(false);
    });
});
