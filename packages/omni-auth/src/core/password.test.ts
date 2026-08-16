import { describe, it, expect, beforeEach } from "vitest";
import { hashPassword, verifyPassword } from "@better-auth/utils/password";
import { createPasswordReset } from "./password";
import { createChannelVerification } from "./verification-channel";
import type { VerificationSender, VerificationVerifier } from "./verification-channel";
import type { DatabaseAdapter, WhereCondition } from "../adapters/database";
import type { SocialAccountRef } from "../social/token";
import { createRegistry, type OmniRegistry } from "../registry";

// ============================================================
// 内存 Mock DatabaseAdapter
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
// Mock 验证码投递器 / 验证器（委托模式：状态由实现方管理）
// ============================================================

let sentCode: string | null = null;
let sentAt: number | null = null;

/** 模拟渠道侧的验证码 TTL */
const MOCK_TTL_MS = 5 * 60 * 1000;

const mockSender: VerificationSender = {
    async send(_channel: SocialAccountRef, code: string) {
        sentCode = code;
        sentAt = Date.now();
    },
};

const mockVerifier: VerificationVerifier = {
    async verify(_channel: SocialAccountRef, code: string) {
        // 模拟渠道权威验证：码匹配且未过期
        if (sentCode !== code) return false;
        if (sentAt == null || Date.now() - sentAt > MOCK_TTL_MS) return false;
        return true;
    },
};

// ============================================================
// 测试
// ============================================================

const USER_ID = "user-001";
const PROVIDER = "email";
const OPENID = "user@example.com";
const OLD_PASSWORD = "oldpass123";
const NEW_PASSWORD = "newpass456";

describe("createPasswordReset", () => {
    let db: MockDB;
    let registry: OmniRegistry;

    beforeEach(async () => {
        db = createMockDB();
        sentCode = null;
        sentAt = null;
        // 3.0.0：验证码 sender/verifier 注册在实例注册表
        registry = createRegistry();
        registry.senders.set(PROVIDER, mockSender);
        registry.verifiers.set(PROVIDER, mockVerifier);

        // 预置：用户（含共享密码哈希，5.0.0 起密码存 user 表）
        db._createRaw("user", {
            id: USER_ID,
            name: "Test User",
            password: await hashPassword(OLD_PASSWORD),
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // 预置：socialAccount 渠道（email）
        db._createRaw("socialAccount", {
            id: "sa-1",
            userId: USER_ID,
            provider: PROVIDER,
            providerOpenid: OPENID,
            valid: 1,
            allowPasswordUpdate: 1,
            allowVerification: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    });

    // ---- reset ----

    describe("reset", () => {
        it("有效验证码 + 新密码 → 密码更新 + 返回 userId", async () => {
            const pr = createPasswordReset({ db, channelVerification: createChannelVerification(registry) });

            // 1. 请求重置（发码）
            await pr.requestReset(PROVIDER, OPENID);
            const code = sentCode!;
            expect(code).toMatch(/^\d{6}$/);

            // 2. 执行重置
            const returnedUserId = await pr.reset(
                PROVIDER,
                OPENID,
                code,
                NEW_PASSWORD
            );
            expect(returnedUserId).toBe(USER_ID);

            // 3. 密码已更新：新密码可验证，旧密码不可验证（user.password）
            const user = db._records("user")[0];
            expect(await verifyPassword(user.password as string, NEW_PASSWORD)).toBe(true);
            expect(await verifyPassword(user.password as string, OLD_PASSWORD)).toBe(false);
        });

        it("无效验证码 → 抛错且不修改密码", async () => {
            const pr = createPasswordReset({ db, channelVerification: createChannelVerification(registry) });

            await expect(
                pr.reset(PROVIDER, OPENID, "000000", NEW_PASSWORD)
            ).rejects.toThrow("验证码错误或已过期");

            // 密码未变：旧密码仍可验证
            const user = db._records("user")[0];
            expect(await verifyPassword(user.password as string, OLD_PASSWORD)).toBe(true);
        });

        it("验证码已过期（渠道侧判定）→ 抛错", async () => {
            const pr = createPasswordReset({ db, channelVerification: createChannelVerification(registry) });

            await pr.requestReset(PROVIDER, OPENID);
            const code = sentCode!;

            // 模拟渠道侧已过 TTL
            sentAt = Date.now() - MOCK_TTL_MS - 60_000;

            await expect(
                pr.reset(PROVIDER, OPENID, code, NEW_PASSWORD)
            ).rejects.toThrow("验证码错误或已过期");
        });

        it("渠道未绑定用户 → 抛错", async () => {
            const pr = createPasswordReset({ db, channelVerification: createChannelVerification(registry) });

            // 为不存在的渠道发码（sender 仍会发送，但 socialAccount 不存在）
            await pr.requestReset(PROVIDER, "nobody@example.com");
            const code = sentCode!;

            await expect(
                pr.reset(PROVIDER, "nobody@example.com", code, NEW_PASSWORD)
            ).rejects.toThrow("未找到对应的用户账户");
        });

        it("用户无密码（OAuth-only）→ 重置即从无到有设置密码", async () => {
            const pr = createPasswordReset({ db, channelVerification: createChannelVerification(registry) });

            // 清除 user.password（模拟 OAuth-only 用户）
            db._records("user")[0].password = null;

            await pr.requestReset(PROVIDER, OPENID);
            const code = sentCode!;

            const returnedUserId = await pr.reset(PROVIDER, OPENID, code, NEW_PASSWORD);
            expect(returnedUserId).toBe(USER_ID);

            const user = db._records("user")[0];
            expect(await verifyPassword(user.password as string, NEW_PASSWORD)).toBe(true);
        });
    });
});
