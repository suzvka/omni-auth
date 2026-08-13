// ============================================================
// 密码重置与修改 — 验证码模式
//
// requestReset = requestCode（发到绑定渠道）
// reset = exchangeCode + hashPassword + 更新密码 + 吊销全部 token
// changePassword = verifyPassword 校验旧密码 + hashPassword + 更新 + 吊销全部 token
// ============================================================

import { hashPassword, verifyPassword } from "@better-auth/utils/password";
import type { DatabaseAdapter } from "../adapters/database";
import { requestCode, exchangeCode } from "./verification-channel";
import { revokeAllTokens } from "./token";
import { InvalidPasswordError } from "../errors";

// ---- 依赖 ----

export interface PasswordResetDeps {
    /** 数据库适配器（必填） */
    db: DatabaseAdapter;
    /** 验证码过期时间（预留，默认由 requestCode 决定 5 分钟） */
    expiresIn?: number;
}

// ---- 凭证账户类型 ----

interface CredentialAccount {
    id: string;
    userId: string;
    providerId: string;
    password: string;
}

interface SocialAccountRow {
    id: string;
    userId: string;
    provider: string;
    providerOpenid: string;
}

// ---- 工厂 ----

export function createPasswordReset(deps: PasswordResetDeps) {
    const { db } = deps;

    return {
        /**
         * 请求密码重置（通过渠道验证码）。
         *
         * 验证码通过 provider 注册的 sender 发送到 providerOpenid。
         * 调用方需提前通过 registerVerificationSender() 注册对应渠道的发码器。
         */
        async requestReset(
            provider: string,
            providerOpenid: string
        ): Promise<void> {
            await requestCode(db, provider, providerOpenid);
        },

        /**
         * 执行密码重置。
         *
         * 流程：exchangeCode（一次性消费）→ 查找用户 → hashPassword → 更新 → 吊销全部 token。
         *
         * @param provider       渠道类型
         * @param providerOpenid 渠道标识符
         * @param code           验证码
         * @param newPassword    新密码
         * @returns userId
         * @throws 验证码错误或已过期 / 未找到用户账户
         */
        async reset(
            provider: string,
            providerOpenid: string,
            code: string,
            newPassword: string
        ): Promise<string> {
            // 1. 校验并消费验证码（一次性）
            const ok = await exchangeCode(db, provider, providerOpenid, code);
            if (!ok) {
                throw new Error("验证码错误或已过期");
            }

            // 2. 通过 socialAccount 表查找用户
            const socialAccount = await db.findOne({
                model: "socialAccount",
                where: [
                    { field: "provider", value: provider },
                    { field: "providerOpenid", value: providerOpenid },
                ],
            }) as SocialAccountRow | null;

            if (!socialAccount) {
                throw new Error("未找到对应的用户账户");
            }

            const userId = socialAccount.userId;

            // 3. 查找 credential account（密码存放处）
            const account = await db.findOne({
                model: "account",
                where: [
                    { field: "userId", value: userId },
                    { field: "providerId", value: "credential" },
                ],
            }) as CredentialAccount | null;

            if (!account) {
                throw new Error("用户未设置密码");
            }

            // 4. 哈希新密码并更新
            const hashedPassword = await hashPassword(newPassword);
            await db.updateOne({
                model: "account",
                where: [{ field: "id", value: account.id }],
                update: {
                    password: hashedPassword,
                    updatedAt: new Date(),
                },
            });

            // 5. 吊销全部 token（重置密码后所有登录失效）
            await revokeAllTokens(db, userId);

            return userId;
        },

        /**
         * 修改密码（已知旧密码，修改为新密码）。
         *
         * 直接用 verifyPassword 校验旧密码，不再通过假登录验证。
         * 修改成功后吊销全部 token（D3）。
         *
         * @param userId      当前用户 ID（由调用方 requireContext 提供）
         * @param oldPassword 旧密码
         * @param newPassword 新密码
         * @throws InvalidPasswordError 旧密码错误
         */
        async changePassword(
            userId: string,
            oldPassword: string,
            newPassword: string
        ): Promise<void> {
            // 1. 查找 credential account
            const account = await db.findOne({
                model: "account",
                where: [
                    { field: "userId", value: userId },
                    { field: "providerId", value: "credential" },
                ],
            }) as CredentialAccount | null;

            if (!account) {
                throw new InvalidPasswordError("用户未设置密码");
            }

            // 2. 校验旧密码（verifyPassword: hash 在前，明文在后）
            const isValid = await verifyPassword(account.password, oldPassword);
            if (!isValid) {
                throw new InvalidPasswordError("当前密码错误");
            }

            // 3. 哈希新密码并更新
            const hashedPassword = await hashPassword(newPassword);
            await db.updateOne({
                model: "account",
                where: [{ field: "id", value: account.id }],
                update: {
                    password: hashedPassword,
                    updatedAt: new Date(),
                },
            });

            // 4. 吊销全部 token（修改密码后所有登录失效）
            await revokeAllTokens(db, userId);
        },
    };
}
