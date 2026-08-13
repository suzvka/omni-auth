import { describe, it, expect, vi } from "vitest";

// mock next/headers（测试环境兼容）
vi.mock("next/headers", () => ({
    headers: async () => new Headers(),
}));

import { createAuth, type OmniAuthConfig } from "./auth";
import type { DatabaseAdapter, WhereCondition } from "./adapters/database";
import { verifyPassword } from "@better-auth/utils/password";
import { createRequestContext } from "./adapters/request";
import {
    CredentialInvalidError,
    InvalidPasswordError,
    RateLimitedError,
    UserExistsError,
} from "./errors";

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
        async transaction(fn) {
            // 快照式事务：fn 抛错时恢复快照（回滚）
            const snapshot = new Map(
                [...store].map(([m, t]) => [m, new Map(t)] as [string, Map<string, Record<string, unknown>>])
            );
            try {
                return await fn(db);
            } catch (err) {
                store.clear();
                for (const [m, t] of snapshot) store.set(m, t);
                throw err;
            }
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

    it("signUp 不再写入 businessAccount 业务表（3.0.0 迁出 SDK，由 hooks 处理）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await auth.signUp({
            email: "biz@test.local",
            password: "password123",
            name: "Biz",
        });

        // SDK 不再创建 app 业务表记录
        const bizAccounts = memDb.dump("businessAccount");
        expect(bizAccounts.length).toBe(0);
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

// ----------------------------------------------------------
// 类型化错误（2.1.0）
// ----------------------------------------------------------

describe("OmniAuth 类型化错误", () => {
    it("signUp 重复邮箱抛 UserExistsError", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await auth.signUp({ email: "t1@err.local", password: "password123", name: "T" });

        await expect(
            auth.signUp({ email: "t1@err.local", password: "password456", name: "T2" })
        ).rejects.toThrow(UserExistsError);
    });

    it("signIn 密码错误抛 InvalidPasswordError（消息防枚举）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);
        await auth.signUp({ email: "t2@err.local", password: "password123", name: "T" });

        await expect(
            auth.signIn({ email: "t2@err.local", password: "wrong" })
        ).rejects.toThrow(InvalidPasswordError);
    });
});

// ----------------------------------------------------------
// 限流键（2.1.0：signUp 按客户端 IP 限流）
// ----------------------------------------------------------

describe("限流键", () => {
    it("signUp 按客户端 IP 限流：同 IP 第 4 次拒绝，不同 IP 不受影响", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        const ctxA = createRequestContext({ "x-forwarded-for": "1.1.1.1" });
        for (let i = 0; i < 3; i++) {
            await auth.signUp(
                { email: `rl${i}@test.local`, password: "password123", name: "RL" },
                ctxA,
            );
        }

        await expect(
            auth.signUp(
                { email: "rl3@test.local", password: "password123", name: "RL" },
                ctxA,
            )
        ).rejects.toThrow(RateLimitedError);

        // 不同 IP 不受影响
        const ctxB = createRequestContext({ "x-forwarded-for": "2.2.2.2" });
        await expect(
            auth.signUp(
                { email: "rl3@test.local", password: "password123", name: "RL" },
                ctxB,
            )
        ).resolves.toBeTruthy();
    });

    it("可注入自定义限流器（config.rateLimit.limiter）", async () => {
        const memDb = createInMemoryDb();
        const check = vi.fn().mockResolvedValue({ allowed: true, remaining: 0, resetAt: 0 });
        const auth = createTestAuth(memDb, {
            rateLimit: { limiter: { check, reset: async () => {} } },
        });

        await auth.signUp({ email: "custom@rl.local", password: "password123", name: "C" });
        expect(check).toHaveBeenCalled();
    });
});

// ----------------------------------------------------------
// authenticateChannel 非密码凭证契约（2.1.0）
// ----------------------------------------------------------

describe("authenticateChannel 非密码凭证契约", () => {
    it("非密码凭证且 verified !== true 时抛 CredentialInvalidError", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await expect(
            auth.authenticateChannel({
                provider: "phone",
                providerOpenid: "13800000000",
                credential: { type: "smsCode", value: "123456" },
            })
        ).rejects.toThrow(CredentialInvalidError);
    });

    it("verified = true 时允许注册（调用方已完成验证）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        const result = await auth.authenticateChannel({
            provider: "phone",
            providerOpenid: "13800000001",
            credential: { type: "smsCode", value: "123456", verified: true },
            profile: { name: "手机用户" },
        });

        expect(result.isNewUser).toBe(true);
        expect(result.user.name).toBe("手机用户");
        expect(result.channel.provider).toBe("phone");
    });
});

// ----------------------------------------------------------
// 事务（3.0.0）
// ----------------------------------------------------------

/** 带事务的专用测试 DB：第 2 次 socialAccount 写入时模拟失败 */
function createTxFailureDb() {
    const store = new Map<string, Record<string, unknown>[]>();
    const state = { socialCreates: 0 };

    function table(model: string) {
        if (!store.has(model)) store.set(model, []);
        return store.get(model)!;
    }
    const match = (r: Record<string, unknown>, where: WhereCondition[]) =>
        where.every((w) => r[w.field] === w.value);

    const adapter: DatabaseAdapter = {
        async create({ model, data }) {
            if (model === "socialAccount") {
                state.socialCreates++;
                if (state.socialCreates >= 2) {
                    throw new Error("simulated social bind failure");
                }
            }
            const rec = { ...data, id: (data.id as string) ?? String(Math.random()) };
            table(model).push(rec);
            return rec;
        },
        async findOne({ model, where }) {
            return table(model).find((r) => match(r, where)) ?? null;
        },
        async findMany({ model, where }) {
            return table(model).filter((r) => !where || match(r, where));
        },
        async count({ model, where }) {
            return table(model).filter((r) => !where || match(r, where)).length;
        },
        async updateOne({ model, where, update }) {
            const r = table(model).find((rec) => match(rec, where));
            if (r) Object.assign(r, update);
            return r ?? null;
        },
        async updateMany() {
            return 0;
        },
        async deleteOne({ model, where }) {
            const t = table(model);
            const i = t.findIndex((r) => match(r, where));
            if (i === -1) return null;
            return t.splice(i, 1)[0];
        },
        async deleteMany() {
            return 0;
        },
        async transaction(fn) {
            // 快照式事务：失败时恢复快照
            const snapshot = new Map(
                [...store].map(([m, rows]) => [m, [...rows]] as [string, Record<string, unknown>[]])
            );
            try {
                return await fn(adapter);
            } catch (err) {
                store.clear();
                for (const [m, rows] of snapshot) store.set(m, rows);
                throw err;
            }
        },
    };

    return { adapter, dump: (m: string) => table(m), state };
}

describe("事务原子性（3.0.0）", () => {
    it("signUpWithSocial 社交绑定失败时整体回滚（user/account 不留存）", async () => {
        const { adapter, dump } = createTxFailureDb();
        const auth = createAuth({
            database: adapter,
            baseUrl: "http://localhost:3000",
        });

        await expect(
            auth.signUpWithSocial({
                email: "tx@test.local",
                password: "password123",
                name: "Tx",
                social: { provider: "wechat", providerOpenid: "oid_tx" },
            })
        ).rejects.toThrow("simulated social bind failure");

        // 事务回滚：三张表均无残留
        expect(dump("user").length).toBe(0);
        expect(dump("account").length).toBe(0);
        expect(dump("socialAccount").length).toBe(0);
    });

    it("适配器未实现 transaction 时回退顺序写入（功能可用）", async () => {
        const memDb = createInMemoryDb();
        const { transaction: _unused, ...rest } = memDb as DatabaseAdapter & {
            transaction: unknown;
            dump: unknown;
        };
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const auth = createAuth({
            database: rest as DatabaseAdapter,
            baseUrl: "http://localhost:3000",
        });

        const result = await auth.signUp({
            email: "notx@test.local",
            password: "password123",
            name: "NoTx",
        });

        expect(result.userId).toBeTruthy();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("未实现 transaction"),
        );
        warnSpy.mockRestore();
    });
});

// ----------------------------------------------------------
// 实例隔离（3.0.0：注册表为实例级）
// ----------------------------------------------------------

describe("实例隔离（3.0.0）", () => {
    it("两个实例的 OAuth provider 注册表互不干扰", async () => {
        const memDb = createInMemoryDb();
        const authA = createTestAuth(memDb);
        const authB = createTestAuth(memDb);

        authA.registerOAuthProvider({
            provider: "wechat",
            exchangeCode: async () => ({ openid: "oid_iso", accessToken: "at" }),
        });

        // authB 未注册 wechat → 拒绝
        await expect(
            authB.handleOAuthCallback("wechat", "code", "http://localhost/cb")
        ).rejects.toThrow("未注册的 OAuth 平台");
    });

    it("两个实例的验证码 verifier 注册表互不干扰", async () => {
        const memDb = createInMemoryDb();
        const authA = createTestAuth(memDb);
        const authB = createTestAuth(memDb);

        authA.registerVerificationVerifier("email", {
            verify: async () => true,
        });

        expect(await authA.verifyChannelCode("email", "a@b.c", "123456")).toBe(true);
        await expect(
            authB.verifyChannelCode("email", "a@b.c", "123456")
        ).rejects.toThrow("未注册验证码验证器");
    });
});
