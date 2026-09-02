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
    OmniAuthError,
    RateLimitedError,
    UserExistsError,
    WeakPasswordError,
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
    it("intent: signUp 创建 user + email 渠道（不创建会话令牌）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        const result = await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "alice@test.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "Alice" },
            channelData: { allowPasswordUpdate: 1, allowVerification: 1 },
        });

        // 返回用户信息
        expect(result.userId).toBeTruthy();
        expect(result.user.name).toBe("Alice");

        // user 表有 1 条记录，password 已哈希（共享密码存放处）
        const users = memDb.dump("user");
        expect(users.length).toBe(1);
        expect(users[0].name).toBe("Alice");
        expect(users[0].password).toBeTruthy();
        expect(users[0].password).not.toBe("password123"); // 确认不是明文

        // email 渠道记录已创建（provider=email，valid=1 真实登记）
        const channels = memDb.dump("socialAccount");
        expect(channels.length).toBe(1);
        expect(channels[0].provider).toBe("email");
        expect(channels[0].providerOpenid).toBe("alice@test.local");
        expect(channels[0].valid).toBe(1);
        expect(channels[0].allowPasswordUpdate).toBe(1);
    });

    it("intent: signUp 密码长度不足默认 8 位时拒绝（WeakPasswordError）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        const weakSignUp = () =>
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "short@test.local",
                intent: "signUp",
                credential: { type: "password", value: "1234567" },
                profile: { name: "Short" },
            });

        await expect(weakSignUp()).rejects.toThrow(WeakPasswordError);
        await expect(weakSignUp()).rejects.toThrow("密码长度不能少于 8 位");
    });

    it("intent: signUp 渠道重复时拒绝（注册冲突即错误）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "dup@test.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "Dup1" },
        });

        await expect(
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "dup@test.local",
                intent: "signUp",
                credential: { type: "password", value: "password456" },
                profile: { name: "Dup2" },
            })
        ).rejects.toThrow("该渠道已被注册");
    });

    it("signUp 意图后 signIn 意图校验密码成功并返回用户", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        const signUpResult = await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "bob@test.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "Bob" },
        });

        const signInResult = await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "bob@test.local",
            intent: "signIn",
            credential: { type: "password", value: "password123" },
        });

        expect(signInResult.userId).toBe(signUpResult.userId);
        expect(signInResult.user.name).toBe("Bob");
        expect(signInResult.isNewUser).toBe(false);
    });

    it("intent: signIn 密码错误时拒绝（统一消息防枚举）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "eve@test.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "Eve" },
        });

        await expect(
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "eve@test.local",
                intent: "signIn",
                credential: { type: "password", value: "wrong-password" },
            })
        ).rejects.toThrow("凭证或密码错误");
    });

    it("intent: signIn 渠道不存在时拒绝且不建号（统一错误消息防枚举）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await expect(
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "nobody@test.local",
                intent: "signIn",
                credential: { type: "password", value: "password123" },
            })
        ).rejects.toThrow("凭证或密码错误");

        // signIn 意图绝不建号（upsert 会在此处自动注册）
        expect(memDb.dump("user").length).toBe(0);
    });

    it("intent: signUp 触发 onUserCreated hook", async () => {
        const memDb = createInMemoryDb();
        let hookPayload: { userId: string; name?: string } | null = null;

        const auth = createTestAuth(memDb, {
            hooks: {
                onUserCreated: async (payload) => {
                    hookPayload = payload;
                },
            },
        });

        const result = await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "hook@test.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "Hook" },
        });

        expect(hookPayload).not.toBeNull();
        expect(hookPayload!.userId).toBe(result.userId);
        expect(hookPayload!.name).toBe("Hook");
    });

    it("intent: signUp 不再写入 businessAccount 业务表（3.0.0 迁出 SDK，由 hooks 处理）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "biz@test.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "Biz" },
        });

        // SDK 不再创建 app 业务表记录
        const bizAccounts = memDb.dump("businessAccount");
        expect(bizAccounts.length).toBe(0);
    });

    it("密码使用 hashPassword/verifyPassword（非明文存储）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "hash@test.local",
            intent: "signUp",
            credential: { type: "password", value: "mypassword" },
            profile: { name: "Hash" },
        });

        // 从 DB 读取 user 记录（共享密码存放处）
        const users = memDb.dump("user");
        const storedHash = users[0].password as string;

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
    it("intent: signUp 渠道重复抛 UserExistsError", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "t1@err.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "T" },
        });

        await expect(
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "t1@err.local",
                intent: "signUp",
                credential: { type: "password", value: "password456" },
                profile: { name: "T2" },
            })
        ).rejects.toThrow(UserExistsError);
    });

    it("intent: signIn 密码错误抛 InvalidPasswordError（消息防枚举）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);
        await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "t2@err.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "T" },
        });

        await expect(
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "t2@err.local",
                intent: "signIn",
                credential: { type: "password", value: "wrong" },
            })
        ).rejects.toThrow(InvalidPasswordError);
    });
});

// ----------------------------------------------------------
// 限流键（2.1.0：signUp 按客户端 IP 限流）
// ----------------------------------------------------------

describe("限流键", () => {
    it("signUp 意图按客户端 IP 限流：同 IP 第 4 次拒绝，不同 IP 不受影响", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        const ctxA = createRequestContext({ "x-forwarded-for": "1.1.1.1" });
        for (let i = 0; i < 3; i++) {
            await auth.authenticateChannel(
                {
                    provider: "email",
                    providerOpenid: `rl${i}@test.local`,
                    intent: "signUp",
                    credential: { type: "password", value: "password123" },
                    profile: { name: "RL" },
                },
                ctxA,
            );
        }

        await expect(
            auth.authenticateChannel(
                {
                    provider: "email",
                    providerOpenid: "rl3@test.local",
                    intent: "signUp",
                    credential: { type: "password", value: "password123" },
                    profile: { name: "RL" },
                },
                ctxA,
            )
        ).rejects.toThrow(RateLimitedError);

        // 不同 IP 不受影响
        const ctxB = createRequestContext({ "x-forwarded-for": "2.2.2.2" });
        await expect(
            auth.authenticateChannel(
                {
                    provider: "email",
                    providerOpenid: "rl3@test.local",
                    intent: "signUp",
                    credential: { type: "password", value: "password123" },
                    profile: { name: "RL" },
                },
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

        await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "custom@rl.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "C" },
        });
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
// authenticateChannel 意图语义（6.0.0）
// ----------------------------------------------------------

describe("authenticateChannel 意图语义（6.0.0）", () => {
    it("intent: signIn 非密码凭证抛 CredentialInvalidError（防凭空建号）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await expect(
            auth.authenticateChannel({
                provider: "phone",
                providerOpenid: "13800000002",
                intent: "signIn",
                credential: { type: "smsCode", value: "123456", verified: true },
            })
        ).rejects.toThrow(CredentialInvalidError);
    });

    it("intent: signUp 并发唯一约束兜底转译 UserExistsError", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "race@test.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "R1" },
        });

        // 模拟竞态：预检查后渠道被并发写入（反查漏判），唯一约束在事务内兜底（pg 23505）
        const originalFindOne = memDb.findOne.bind(memDb);
        memDb.findOne = async (args) => {
            if (
                args.model === "socialAccount" &&
                args.where.some((w) => w.field === "providerOpenid" && w.value === "race@test.local")
            ) {
                return null;
            }
            return originalFindOne(args);
        };
        // 事务闭包持有内层适配器引用，需经 transaction 包装注入才能生效：
        // 内层反查同样漏判，socialAccount 写入抛唯一约束冲突，模拟并发注册的第二笔写入（pg 23505）
        const originalTx = memDb.transaction!.bind(memDb);
        memDb.transaction = async (fn) =>
            originalTx(async (tx) => {
                const wrapped: DatabaseAdapter = {
                    ...tx,
                    findOne: async (args) => {
                        if (
                            args.model === "socialAccount" &&
                            args.where.some((w) => w.field === "providerOpenid" && w.value === "race@test.local")
                        ) {
                            return null;
                        }
                        return tx.findOne(args);
                    },
                    create: async (args) => {
                        if (args.model === "socialAccount") {
                            throw new OmniAuthError("UNIQUE_VIOLATION", "duplicate key value violates unique constraint");
                        }
                        return tx.create(args);
                    },
                };
                return fn(wrapped);
            });

        await expect(
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "race@test.local",
                intent: "signUp",
                credential: { type: "password", value: "password456" },
                profile: { name: "R2" },
            })
        ).rejects.toThrow(UserExistsError);
    });

    it("intent: signIn 反查前即限流（不存在的渠道同样付出限流代价）", async () => {
        const memDb = createInMemoryDb();
        const check = vi.fn().mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 });
        const auth = createTestAuth(memDb, {
            rateLimit: { limiter: { check, reset: async () => {} } },
        });

        await expect(
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "probe@test.local",
                intent: "signIn",
                credential: { type: "password", value: "whatever" },
            })
        ).rejects.toThrow(RateLimitedError);

        // 限流键形如 signIn:ip:provider:openid
        expect(check).toHaveBeenCalledWith(
            expect.stringContaining("signIn:"),
            expect.any(Number),
            expect.any(Number),
        );
    });

    it("默认 upsert 行为不变：渠道已存在时直接登录（不抛冲突）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        const created = await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "upsert@test.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "U" },
        });

        const logged = await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "upsert@test.local",
            credential: { type: "password", value: "password123" },
        });

        expect(logged.isNewUser).toBe(false);
        expect(logged.userId).toBe(created.userId);
        expect(memDb.dump("user").length).toBe(1);
    });
});

// ----------------------------------------------------------
// 事务（3.0.0）
// ----------------------------------------------------------

/** 带事务的专用测试 DB：第 failFrom 次 socialAccount 写入时模拟失败 */
function createTxFailureDb(failFrom = 2) {
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
                if (state.socialCreates >= failFrom) {
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

        const result = await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "notx@test.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "NoTx" },
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

// ----------------------------------------------------------
// 密码策略（4.1.0）
// ----------------------------------------------------------

describe("密码策略（4.1.0）", () => {
    it("passwordPolicy.minLength 可收紧密码长度要求", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb, {
            passwordPolicy: { minLength: 8 },
        });

        const weakSignUp = () =>
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "p7@test.local",
                intent: "signUp",
                credential: { type: "password", value: "1234567" },
                profile: { name: "P" },
            });

        await expect(weakSignUp()).rejects.toThrow(WeakPasswordError);
        await expect(weakSignUp()).rejects.toThrow("密码长度不能少于 8 位");

        // 8 位通过
        await expect(
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "p8@test.local",
                intent: "signUp",
                credential: { type: "password", value: "12345678" },
                profile: { name: "P" },
            })
        ).resolves.toBeTruthy();
    });

    it("authenticateChannel 密码凭证注册同样遵循密码策略", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb, {
            passwordPolicy: { minLength: 8 },
        });

        await expect(
            auth.authenticateChannel({
                provider: "phone",
                providerOpenid: "13800000000",
                credential: { type: "password", value: "1234567" },
                profile: { name: "P" },
            })
        ).rejects.toThrow(WeakPasswordError);
    });

    it("不配置时默认最短 8 位", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        await expect(
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "p8@test.local",
                intent: "signUp",
                credential: { type: "password", value: "12345678" },
                profile: { name: "P" },
            })
        ).resolves.toBeTruthy();
    });
});

// ----------------------------------------------------------
// 限流加固（4.1.0）
// ----------------------------------------------------------

describe("限流加固（4.1.0）", () => {
    it("signIn 成功后重置限流计数", async () => {
        const memDb = createInMemoryDb();
        const reset = vi.fn().mockResolvedValue(undefined);
        const auth = createTestAuth(memDb, {
            rateLimit: {
                limiter: {
                    check: async () => ({ allowed: true, remaining: 5, resetAt: 0 }),
                    reset,
                },
            },
        });

        await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "reset@rl.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "R" },
        });
        await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "reset@rl.local",
            intent: "signIn",
            credential: { type: "password", value: "password123" },
        });

        expect(reset).toHaveBeenCalledWith(expect.stringContaining("signIn:"));
    });

    it("signIn 失败时不重置限流计数", async () => {
        const memDb = createInMemoryDb();
        const reset = vi.fn().mockResolvedValue(undefined);
        const auth = createTestAuth(memDb, {
            rateLimit: {
                limiter: {
                    check: async () => ({ allowed: true, remaining: 5, resetAt: 0 }),
                    reset,
                },
            },
        });

        await auth.authenticateChannel({
            provider: "email",
            providerOpenid: "fail@rl.local",
            intent: "signUp",
            credential: { type: "password", value: "password123" },
            profile: { name: "F" },
        });
        await expect(
            auth.authenticateChannel({
                provider: "email",
                providerOpenid: "fail@rl.local",
                intent: "signIn",
                credential: { type: "password", value: "wrong" },
            })
        ).rejects.toThrow(InvalidPasswordError);

        expect(reset).not.toHaveBeenCalled();
    });

    it("verifyChannelCode 默认不限流（行为兼容）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);
        auth.registerVerificationVerifier("email", { verify: async () => false });

        // 未配置 verifyCode 限流：超过 3 次仍允许尝试
        for (let i = 0; i < 5; i++) {
            await expect(
                auth.verifyChannelCode("email", "nolimit@x.c", "000000")
            ).resolves.toBe(false);
        }
    });

    it("配置 rateLimit.verifyCode 后限制验证尝试次数", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb, {
            rateLimit: { verifyCode: { maxAttempts: 2, windowMs: 60_000 } },
        });
        auth.registerVerificationVerifier("email", { verify: async () => false });

        await expect(auth.verifyChannelCode("email", "v@x.c", "1")).resolves.toBe(false);
        await expect(auth.verifyChannelCode("email", "v@x.c", "2")).resolves.toBe(false);
        await expect(
            auth.verifyChannelCode("email", "v@x.c", "3")
        ).rejects.toThrow(RateLimitedError);
    });

    it("verifyChannelCode 验证成功时重置计数", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb, {
            rateLimit: { verifyCode: { maxAttempts: 2, windowMs: 60_000 } },
        });
        auth.registerVerificationVerifier("email", {
            verify: async (_ch, code) => code === "888888",
        });

        // 失败 1 次 → 成功（重置）→ 再成功，不受 maxAttempts=2 限制
        await expect(auth.verifyChannelCode("email", "ok@x.c", "1")).resolves.toBe(false);
        await expect(auth.verifyChannelCode("email", "ok@x.c", "888888")).resolves.toBe(true);
        await expect(auth.verifyChannelCode("email", "ok@x.c", "888888")).resolves.toBe(true);
    });

    it("可注入自定义 getClientIp（限流键使用自定义解析结果）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb, {
            rateLimit: { getClientIp: () => "9.9.9.9" },
        });

        // 请求头各不相同，但自定义解析器统一返回 9.9.9.9 → 同键限流
        for (let i = 0; i < 3; i++) {
            await auth.authenticateChannel(
                {
                    provider: "email",
                    providerOpenid: `ip${i}@inj.local`,
                    intent: "signUp",
                    credential: { type: "password", value: "password123" },
                    profile: { name: "I" },
                },
                createRequestContext({ "x-forwarded-for": `10.0.0.${i}` }),
            );
        }
        await expect(
            auth.authenticateChannel(
                {
                    provider: "email",
                    providerOpenid: "ip3@inj.local",
                    intent: "signUp",
                    credential: { type: "password", value: "password123" },
                    profile: { name: "I" },
                },
                createRequestContext({ "x-forwarded-for": "10.0.0.99" }),
            )
        ).rejects.toThrow(RateLimitedError);
    });
});

// ----------------------------------------------------------
// authenticateChannel 原子性（4.1.0）
// ----------------------------------------------------------

describe("authenticateChannel 渠道写入原子性（4.1.0）", () => {
    it("channelData 随注册同事务写入（无事务外补丁）", async () => {
        const memDb = createInMemoryDb();
        const auth = createTestAuth(memDb);

        const result = await auth.authenticateChannel({
            provider: "wechat",
            providerOpenid: "oid_atom",
            credential: { type: "oauthCode", value: "code", verified: true },
            channelData: { accessToken: "at_1", valid: 1, profileData: { vip: true } },
        });

        expect(result.isNewUser).toBe(true);
        expect(result.channel.valid).toBe(1);

        const rows = memDb.dump("socialAccount");
        expect(rows.length).toBe(1);
        expect(rows[0].accessToken).toBe("at_1");
        expect(rows[0].profileData).toEqual({ vip: true });
    });

    it("渠道写入失败时整体回滚（user/account 不留存）", async () => {
        const { adapter, dump } = createTxFailureDb(1);
        const auth = createAuth({
            database: adapter,
            baseUrl: "http://localhost:3000",
        });

        await expect(
            auth.authenticateChannel({
                provider: "wechat",
                providerOpenid: "oid_fail",
                credential: { type: "oauthCode", value: "code", verified: true },
                channelData: { accessToken: "at_x" },
            })
        ).rejects.toThrow("simulated social bind failure");

        // 事务回滚：两张表均无残留（旧版事务外 updateOne 会残留 user）
        expect(dump("user").length).toBe(0);
        expect(dump("socialAccount").length).toBe(0);
    });
});
