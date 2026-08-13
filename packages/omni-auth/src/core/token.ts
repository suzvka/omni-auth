// ============================================================
// AuthToken 凭证引擎 — token 生成、哈希存储、校验、吊销
//
// token = 32 字节随机值（base64url），数据库只存 SHA-256 哈希。
// 单 token per user：登录时 upsert 覆盖旧 token。
// 吊销 = 删除记录。固定过期，不自动续期。
// ============================================================

import { randomBytes, createHash, randomUUID } from "crypto";
import type { DatabaseAdapter } from "../adapters/database";

// ---- 常量 ----

/** metadata 序列化后最大字节数（安全边界） */
const MAX_METADATA_SIZE = 2048;

// ---- 纯函数 ----

/** 生成明文 token（43 字符，256-bit 熵） */
export function generateToken(): string {
    return randomBytes(32).toString("base64url");
}

/** 计算 token 的 SHA-256 哈希（hex 编码，仅此值落库） */
export function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/** 校验 metadata 大小（序列化后 ≤ 2KB），超限抛错 */
export function validateMetadataSize(metadata: unknown): void {
    if (metadata === undefined || metadata === null) return;
    const serialized = JSON.stringify(metadata);
    if (serialized.length > MAX_METADATA_SIZE) {
        throw new Error(`metadata 序列化后 ${serialized.length} 字节，超过上限 ${MAX_METADATA_SIZE} 字节`);
    }
}

// ---- 数据库操作 ----

/**
 * 创建 AuthToken（DB 级原子 upsert）。
 *
 * 单 token per user：登录时 upsert 覆盖旧 token。
 * 必须使用 DB 级 ON CONFLICT 原子操作，禁止读→删→写三步。
 *
 * @returns 明文 token（调用方负责设置 cookie / 返回给客户端）
 */
export async function createAuthToken(
    db: DatabaseAdapter,
    userId: string,
    expiresIn: number,
    metadata?: Record<string, unknown>,
): Promise<string> {
    validateMetadataSize(metadata);

    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresIn * 1000);

    const data = {
        id: randomUUID(),
        tokenHash,
        userId,
        metadata: metadata ?? {},
        expiresAt,
        createdAt: now,
    };

    if (db.upsert) {
        // PgAdapter: 原子 ON CONFLICT
        await db.upsert({
            model: "authToken",
            data,
            conflictOn: ["userId"],
            update: { tokenHash, metadata: metadata ?? {}, expiresAt, createdAt: now },
        });
    } else {
        // 回退：内存测试 DB 或非 PG 适配器（不保证原子性，仅用于测试）
        // 先删旧（如有）再插新
        await db.deleteMany({
            model: "authToken",
            where: [{ field: "userId", value: userId }],
        });
        await db.create({ model: "authToken", data });
    }

    return token;
}

/**
 * 校验 token（纯查询 + 过期清理，无续期）。
 *
 * 1. hash token → 查 AuthToken 表
 * 2. 无记录 → null
 * 3. 过期 → 删除该记录，返回 null
 * 4. 查 user 表确认用户存在 → 返回 { userId, metadata }
 */
export async function validateToken(
    db: DatabaseAdapter,
    token: string,
): Promise<{ userId: string; metadata: Record<string, unknown> } | null> {
    const tokenHash = hashToken(token);

    const record = await db.findOne({
        model: "authToken",
        where: [{ field: "tokenHash", value: tokenHash }],
    }) as Record<string, unknown> | null;

    if (!record) return null;

    const expiresAt = record.expiresAt as Date;
    if (expiresAt.getTime() <= Date.now()) {
        // 过期：删除记录
        await db.deleteOne({
            model: "authToken",
            where: [{ field: "tokenHash", value: tokenHash }],
        });
        return null;
    }

    // 确认用户存在（删号即天然失效）
    const user = await db.findOne({
        model: "user",
        where: [{ field: "id", value: record.userId as string }],
    });
    if (!user) {
        // 用户已删除，清理孤儿 token
        await db.deleteOne({
            model: "authToken",
            where: [{ field: "tokenHash", value: tokenHash }],
        });
        return null;
    }

    return {
        userId: record.userId as string,
        metadata: (record.metadata as Record<string, unknown>) ?? {},
    };
}

/** 吊销指定 token（校验 userId 归属） */
export async function revokeToken(
    db: DatabaseAdapter,
    userId: string,
    token: string,
): Promise<boolean> {
    const tokenHash = hashToken(token);
    const result = await db.deleteOne({
        model: "authToken",
        where: [
            { field: "tokenHash", value: tokenHash },
            { field: "userId", value: userId },
        ],
    });
    return result !== null;
}

/** 吊销用户全部 token（= 登出所有设备） */
export async function revokeAllTokens(
    db: DatabaseAdapter,
    userId: string,
): Promise<number> {
    const count = await db.deleteMany({
        model: "authToken",
        where: [{ field: "userId", value: userId }],
    });
    return count;
}

/** 清理过期 AuthToken 记录（供 instrumentation 定时调用） */
export async function cleanupExpiredTokens(db: DatabaseAdapter): Promise<number> {
    const now = new Date().toISOString();
    const count = await db.deleteMany({
        model: "authToken",
        where: [{ field: "expiresAt", value: now, operator: "lt" }],
    });
    return count;
}
