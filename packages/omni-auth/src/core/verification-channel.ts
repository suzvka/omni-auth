// ============================================================
// 渠道验证码原语 — requestCode / verifyCode（委托模式）
//
// 全渠道平权：库不内置任何渠道特化逻辑，只做编排——
// 1. requestCode：生成密码学安全的 6 位种子码，可选调用
//    sender 投递（未注册则仅返回码，由上层自行投递/派生 URL）。
// 2. verifyCode：委托渠道注册的 verifier 判定验证结果，库
//    无条件透传返回值，不做任何状态存储。
// 验证码的存储、TTL、一次性消费、防重放均由渠道实现方自行保证。
// ============================================================

import { randomInt } from "crypto";
import type { SocialAccountRef } from "../social/token";

// ---- 类型 ----

/** 验证码投递器（可选）：由 provider 实现方注册，负责把库生成的种子码投递给渠道 */
export interface VerificationSender {
    /**
     * 向指定渠道投递验证码。
     *
     * @param channel  渠道引用（含 providerOpenid / accessToken 等）
     * @param code     库生成的种子码
     */
    send(channel: SocialAccountRef, code: string): Promise<void>;
}

/** 验证码验证器（必须）：由 provider 实现方注册，渠道权威判定验证结果 */
export interface VerificationVerifier {
    /**
     * 验证用户提交的验证码。
     *
     * 验证码的状态（存储、TTL、一次性消费、防重放）由实现方自行管理，
     * 库无条件透传验证结果。
     *
     * @param channel  渠道引用（含 providerOpenid / accessToken 等）
     * @param code     用户提交的验证码
     * @returns 验证是否通过
     */
    verify(channel: SocialAccountRef, code: string): Promise<boolean>;
}

// ---- 注册表 ----

const senderRegistry = new Map<string, VerificationSender>();
const verifierRegistry = new Map<string, VerificationVerifier>();

export function registerVerificationSender(
    provider: string,
    sender: VerificationSender
): void {
    senderRegistry.set(provider, sender);
}

export function getVerificationSender(
    provider: string
): VerificationSender | undefined {
    return senderRegistry.get(provider);
}

export function registerVerificationVerifier(
    provider: string,
    verifier: VerificationVerifier
): void {
    verifierRegistry.set(provider, verifier);
}

export function getVerificationVerifier(
    provider: string
): VerificationVerifier | undefined {
    return verifierRegistry.get(provider);
}

// ---- 纯辅助 ----

/** 当调用方未提供完整渠道引用时，构造最小 SocialAccountRef 供实现方使用 */
function buildMinimalRef(
    provider: string,
    providerOpenid: string
): SocialAccountRef {
    return {
        id: "",
        provider,
        providerOpenid,
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
        profileData: {},
    };
}

// ---- 原语 ----

/**
 * 向指定渠道请求验证码（生成种子码）。
 *
 * 流程：
 * 1. crypto.randomInt 生成 6 位种子码（密码学安全）
 * 2. 若已注册 sender，则调用 sender.send() 投递
 * 3. 返回种子码（上层可用其派生 URL / token 等）
 *
 * sender 未注册时不抛错：仅返回码，投递由上层自行完成。
 *
 * @param provider       渠道类型（email / phone / wechat 等）
 * @param providerOpenid 渠道标识符（邮箱地址、手机号、openid 等）
 * @param channelRef     可选完整渠道引用；不提供则构造最小引用
 * @returns 生成的种子码
 */
export async function requestCode(
    provider: string,
    providerOpenid: string,
    channelRef?: SocialAccountRef
): Promise<string> {
    const code = randomInt(100000, 1000000).toString();
    const ref = channelRef ?? buildMinimalRef(provider, providerOpenid);

    const sender = senderRegistry.get(provider);
    if (sender) {
        await sender.send(ref, code);
    }

    return code;
}

/**
 * 委托渠道验证用户提交的验证码。
 *
 * 流程：
 * 1. 查找 provider 注册的 verifier（未注册则抛错）
 * 2. 调用 verifier.verify() 并透传验证结果
 *
 * @param provider       渠道类型
 * @param providerOpenid 渠道标识符
 * @param code           用户提交的验证码
 * @param channelRef     可选完整渠道引用；不提供则构造最小引用
 * @returns 渠道返回的验证结果
 */
export async function verifyCode(
    provider: string,
    providerOpenid: string,
    code: string,
    channelRef?: SocialAccountRef
): Promise<boolean> {
    const verifier = verifierRegistry.get(provider);
    if (!verifier) {
        throw new Error(`渠道 "${provider}" 未注册验证码验证器`);
    }
    const ref = channelRef ?? buildMinimalRef(provider, providerOpenid);
    return verifier.verify(ref, code);
}

// ---- 工厂（auth.ts 构造时使用） ----

/** 渠道验证码编排器：生成种子码 + 委托验证，无状态、无 db 依赖 */
export function createChannelVerification() {
    return {
        /** 生成种子码并（可选）投递，返回种子码 */
        requestCode(
            provider: string,
            providerOpenid: string,
            channelRef?: SocialAccountRef
        ): Promise<string> {
            return requestCode(provider, providerOpenid, channelRef);
        },

        /** 委托渠道验证验证码 */
        verifyCode(
            provider: string,
            providerOpenid: string,
            code: string,
            channelRef?: SocialAccountRef
        ): Promise<boolean> {
            return verifyCode(provider, providerOpenid, code, channelRef);
        },
    };
}
