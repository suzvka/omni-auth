// ============================================================
// 账号管理 — 注销与资料更新
//
// deleteAccount: 直接 verifyPassword 校验密码（不再假登录）→ 删除用户
// updateProfile: 接收 userId（由调用方从 requireContext 获取）
// ============================================================

import { verifyPassword } from "@better-auth/utils/password";
import type { DatabaseAdapter } from "../adapters/database";
import { InvalidPasswordError } from "../errors";
import { revokeAllTokens } from "./token";

// ---- 类型 ----

export interface AccountDeletionDeps {
    /** 数据库适配器（必填） */
    db: DatabaseAdapter;
}

/** 可更新的用户资料字段 */
export interface UpdateProfileInput {
    name?: string;
    image?: string;
}

// ---- 工厂函数 ----

/**
 * 创建账号管理模块。
 *
 * 不再依赖 Better Auth 的 getSession / signInEmail，
 * 直接操作数据库完成密码校验、用户删除、资料更新。
 */
export function createAccountDeletion(deps: AccountDeletionDeps) {
    const { db } = deps;

    return {
        /**
         * 更新用户资料（name / image）。
         *
         * 同步更新 user 表和 BusinessAccount 的 displayName。
         * userId 由调用方从 requireContext 获取后传入。
         *
         * @param userId 用户 ID
         * @param input 待更新字段
         */
        async updateProfile(
            userId: string,
            input: UpdateProfileInput,
        ): Promise<void> {
            const updateData: Record<string, unknown> = {};

            if (input.name !== undefined) {
                updateData.name = input.name;
            }
            if (input.image !== undefined) {
                updateData.image = input.image;
            }

            // 无字段需要更新则直接返回
            if (Object.keys(updateData).length === 0) return;

            const now = new Date();
            updateData.updatedAt = now;

            // ---- 更新 user 表 ----
            try {
                await db.updateOne({
                    model: "user",
                    where: [{ field: "id", value: userId }],
                    update: updateData,
                });
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                throw new Error(`更新用户资料失败: ${message}`);
            }

            // ---- 同步更新 BusinessAccount.displayName（name 变更时）----
            if (input.name !== undefined) {
                try {
                    await db.updateOne({
                        model: "businessAccount",
                        where: [{ field: "authUserId", value: userId }],
                        update: { displayName: input.name, updatedAt: now },
                    });
                } catch (err: unknown) {
                    // businessAccount 可能不存在（例如未通过 databaseHooks 自动创建），
                    // 此为非关键错误，忽略
                    console.warn(
                        `[updateProfile] 同步 businessAccount.displayName 失败 (userId=${userId}):`,
                        err instanceof Error ? err.message : String(err),
                    );
                }
            }
        },

        /**
         * 注销账号。
         *
         * 直接 verifyPassword 校验密码（不再通过 signInEmail 假登录）→
         * 删除用户（级联删除 account / socialAccount / authToken）→
         * 显式吊销全部 AuthToken（安全兜底）。
         *
         * @param userId 用户 ID
         * @param password 明文密码
         * @throws InvalidPasswordError 密码错误或账号不存在时抛出
         */
        async deleteAccount(
            userId: string,
            password: string,
        ): Promise<void> {
            // ---- 查找 credential account ----
            const account = await db.findOne({
                model: "account",
                where: [
                    { field: "userId", value: userId },
                    { field: "providerId", value: "credential" },
                ],
            }) as Record<string, unknown> | null;

            if (!account) {
                throw new InvalidPasswordError("账号不存在");
            }

            // ---- 直接校验密码（不再通过 signInEmail 假登录）----
            const isValid = await verifyPassword(
                account.password as string,
                password,
            );
            if (!isValid) {
                throw new InvalidPasswordError("密码错误");
            }

            // ---- 吊销全部 AuthToken（安全兜底，FK CASCADE 也会清理）----
            await revokeAllTokens(db, userId);

            // ---- 删除用户（级联删除由数据库外键保证）----
            await db.deleteOne({
                model: "user",
                where: [{ field: "id", value: userId }],
            });
        },
    };
}
