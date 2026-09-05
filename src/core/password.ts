// ============================================================
// 密码重置 — 验证码模式（委托模式）
//
// requestReset = requestCode（生成种子码，可选投递）
// reset = verifyCode（委托渠道验证）+ hashPassword + 更新密码
// ============================================================

import { hashPassword } from "@better-auth/utils/password";
import type { DatabaseAdapter } from "../adapters/database";
import { createDbFacade } from "../models";

// ---- 依赖 ----

/** 渠道验证码编排器（实例级，createChannelVerification 产物） */
export interface ChannelVerificationLike {
    requestCode(provider: string, providerOpenid: string): Promise<string>;
    verifyCode(
        provider: string,
        providerOpenid: string,
        code: string
    ): Promise<boolean>;
}

export interface PasswordResetDeps {
    /** 数据库适配器（必填） */
    db: DatabaseAdapter;
    /** 渠道验证码编排器（实例级，必填） */
    channelVerification: ChannelVerificationLike;
}

// ---- 工厂 ----

export function createPasswordReset(deps: PasswordResetDeps) {
    const { db, channelVerification } = deps;
    const dbf = createDbFacade(db);

    return {
        /**
         * 请求密码重置（通过渠道验证码）。
         *
         * 生成种子码；若已注册 sender 则投递到 providerOpenid，
         * 未注册则调用方自行投递。
         * 调用方需提前通过 auth.registerVerificationSender() 注册对应渠道的投递器。
         */
        async requestReset(
            provider: string,
            providerOpenid: string
        ): Promise<void> {
            await channelVerification.requestCode(provider, providerOpenid);
        },

        /**
         * 执行密码重置。
         *
         * 流程：verifyCode（委托渠道验证）→ 查找用户 → hashPassword → 更新 user.password。
         * 验证码的状态管理与一次性消费由渠道 verifier 实现方负责。
         * 用户可无密码（OAuth-only），重置即从无到有设置密码。
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
            // 1. 委托渠道验证验证码（结果由渠道实现方决定）
            const ok = await channelVerification.verifyCode(provider, providerOpenid, code);
            if (!ok) {
                throw new Error("验证码错误或已过期");
            }

            // 2. 通过 socialAccount 表查找用户
            const socialAccount = await dbf.socialAccount.findOne({
                where: [
                    { field: "provider", value: provider },
                    { field: "providerOpenid", value: providerOpenid },
                ],
            });

            if (!socialAccount) {
                throw new Error("未找到对应的用户账户");
            }

            const userId = socialAccount.userId;

            // 3. 哈希新密码并更新共享密码（user 表）
            const hashedPassword = await hashPassword(newPassword);
            await dbf.user.updateOne({
                where: [{ field: "id", value: userId }],
                update: {
                    password: hashedPassword,
                    updatedAt: new Date(),
                },
            });

            return userId;
        },
    };
}
