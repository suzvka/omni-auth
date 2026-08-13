// ============================================================
// 邮箱验证 — 自研实现
//
// requestVerification: 生成验证 token → 存入 Verification 表
//   （identifier: verify-email:{email}，TTL 1 小时）→ 发送验证邮件
// verify: 查找 token → 校验 → 更新 user.emailVerified → 删除记录
// ============================================================

import { randomBytes, randomUUID } from "crypto";
import type { DatabaseAdapter } from "../adapters/database";
import type { EmailAdapter } from "../adapters/email";

// ---- 类型 ----

export interface EmailVerificationDeps {
    /** 数据库适配器（必填） */
    db: DatabaseAdapter;
    /** 邮件适配器（可选，提供则自动发送验证邮件） */
    email?: EmailAdapter | null;
    /** 应用基础 URL（用于拼接验证链接） */
    baseUrl?: string;
}

// ---- 常量 ----

/** 验证 token 有效期：1 小时（毫秒） */
const VERIFICATION_TTL_MS = 60 * 60 * 1000;

/** Verification 表 identifier 前缀 */
const IDENTIFIER_PREFIX = "verify-email:";

// ---- 工厂函数 ----

/**
 * 创建邮箱验证模块。
 *
 * 直接操作 Verification 表完成 token 生成、存储、校验、清理的完整生命周期。
 */
export function createEmailVerification(deps: EmailVerificationDeps) {
    const { db, email, baseUrl } = deps;

    return {
        /**
         * 请求发送验证邮件。
         *
         * 1. 生成 256-bit 验证 token（base64url，43 字符）
         * 2. 清理同一邮箱的旧验证记录（防累积）
         * 3. 存入 Verification 表（TTL 1 小时）
         * 4. 若 EmailAdapter 可用，发送验证邮件
         *
         * @param userId 用户 ID
         * @param emailAddress 目标邮箱
         * @returns 明文验证 token（调用方可用其拼接自定义链接）
         */
        async requestVerification(
            userId: string,
            emailAddress: string,
        ): Promise<string> {
            const token = randomBytes(32).toString("base64url");
            const now = new Date();
            const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);
            const identifier = `${IDENTIFIER_PREFIX}${emailAddress}`;

            // ---- 清理同一邮箱的旧验证记录 ----
            await db.deleteMany({
                model: "verification",
                where: [{ field: "identifier", value: identifier }],
            });

            // ---- 存入 Verification 表 ----
            await db.create({
                model: "verification",
                data: {
                    id: randomUUID(),
                    identifier,
                    value: token,
                    expiresAt,
                    createdAt: now,
                    updatedAt: now,
                },
            });

            // ---- 发送验证邮件（若 EmailAdapter 可用）----
            if (email) {
                const verifyUrl = baseUrl
                    ? `${baseUrl}/verify-email?token=${encodeURIComponent(token)}`
                    : `?token=${encodeURIComponent(token)}`;

                await email.sendVerificationEmail({
                    to: emailAddress,
                    subject: "邮箱验证",
                    url: verifyUrl,
                    token,
                });
            }

            return token;
        },

        /**
         * 验证邮箱 token。
         *
         * 1. 查找 token 对应的 Verification 记录
         * 2. 校验有效期（过期则删除并抛错）
         * 3. 从 identifier 提取邮箱
         * 4. 更新 user.emailVerified = true
         * 5. 删除验证记录（一次性使用）
         *
         * @param token 验证 token
         * @returns 验证成功的邮箱地址
         * @throws token 无效或已过期时抛出 Error
         */
        async verify(token: string): Promise<string> {
            // ---- 查找验证记录 ----
            const record = await db.findOne({
                model: "verification",
                where: [{ field: "value", value: token }],
            }) as Record<string, unknown> | null;

            if (!record) {
                throw new Error("验证链接无效或已过期");
            }

            // ---- 校验有效期 ----
            const expiresAt = record.expiresAt as Date;
            if (expiresAt.getTime() <= Date.now()) {
                // 过期：删除记录后抛错
                await db.deleteOne({
                    model: "verification",
                    where: [{ field: "id", value: record.id }],
                });
                throw new Error("验证链接无效或已过期");
            }

            // ---- 从 identifier 提取邮箱 ----
            const identifier = record.identifier as string;
            const emailAddress = identifier.slice(IDENTIFIER_PREFIX.length);

            // ---- 更新用户 emailVerified ----
            const now = new Date();
            await db.updateOne({
                model: "user",
                where: [{ field: "email", value: emailAddress }],
                update: { emailVerified: true, updatedAt: now },
            });

            // ---- 删除验证记录（一次性使用）----
            await db.deleteOne({
                model: "verification",
                where: [{ field: "id", value: record.id }],
            });

            return emailAddress;
        },
    };
}
