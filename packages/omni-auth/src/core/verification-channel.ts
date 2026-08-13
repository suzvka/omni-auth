// ============================================================
// 渠道验证码原语 — requestCode / exchangeCode
//
// 统一原语：注册/登录/重置密码/邮箱验证全部复用。
// identifier 命名空间：channel:{provider}:{providerOpenid}
// 验证码生成使用 crypto.randomInt（密码学安全）。
// exchangeCode 一次性消费（成功即删除）。
// requestCode 发送前清理同 identifier 过期记录。
// ============================================================

import { randomInt, randomUUID } from "crypto";
import type { DatabaseAdapter } from "../adapters/database";
import type { SocialAccountRef } from "../social/token";

// ---- 类型 ----

/** 验证码发送器：由 provider 实现方注册 */
export interface VerificationSender {
    /**
     * 向指定渠道发送验证码。
     *
     * @param channel  渠道引用（含 providerOpenid / accessToken 等）
     * @param code     生成的验证码
     */
    send(channel: SocialAccountRef, code: string): Promise<void>;
}

/** 验证码存储记录（复用 Better Auth verification 表结构） */
interface VerificationRecord {
    id: string;
    identifier: string;
    value: string;
    expiresAt: Date;
}

// ---- 常量 ----

/** 验证码 TTL：5 分钟 = 300 秒 */
const CODE_TTL_MS = 5 * 60 * 1000;

// ---- 注册表 ----

const senderRegistry = new Map<string, VerificationSender>();

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

// ---- 纯辅助 ----

/** 构造 identifier：channel:{provider}:{providerOpenid} */
function buildIdentifier(provider: string, providerOpenid: string): string {
    return `channel:${provider}:${providerOpenid}`;
}

/** 当调用方未提供完整渠道引用时，构造最小 SocialAccountRef 供 sender 使用 */
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
 * 向指定渠道请求验证码。
 *
 * 流程：
 * 1. 查找 provider 注册的 sender（未注册则抛错）
 * 2. 清理同 identifier 的过期记录（deleteMany expiresAt < now）
 * 3. crypto.randomInt 生成 6 位验证码（密码学安全）
 * 4. 存入 verification 表（TTL 5 分钟）
 * 5. 调用 sender.send() 发送
 *
 * @param db            数据库适配器
 * @param provider      渠道类型（email / phone / wechat 等）
 * @param providerOpenid 渠道标识符（邮箱地址、手机号、openid 等）
 * @param channelRef    可选完整渠道引用；不提供则构造最小引用
 */
export async function requestCode(
    db: DatabaseAdapter,
    provider: string,
    providerOpenid: string,
    channelRef?: SocialAccountRef
): Promise<void> {
    const sender = senderRegistry.get(provider);
    if (!sender) {
        throw new Error(`渠道 "${provider}" 未注册验证码发送器`);
    }

    const identifier = buildIdentifier(provider, providerOpenid);
    const now = new Date();

    // 清理同 identifier 的过期记录
    await db.deleteMany({
        model: "verification",
        where: [
            { field: "identifier", value: identifier },
            { field: "expiresAt", value: now, operator: "lt" },
        ],
    });

    // 密码学安全 6 位验证码 [100000, 1000000)
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);

    // 存入 verification 表
    await db.create({
        model: "verification",
        data: {
            id: randomUUID(),
            identifier,
            value: code,
            expiresAt,
        },
    });

    // 调度发送
    const ref = channelRef ?? buildMinimalRef(provider, providerOpenid);
    await sender.send(ref, code);
}

/**
 * 校验并消费验证码（一次性）。
 *
 * 流程：
 * 1. findOne 同时匹配 identifier + value（精确单条查询，非 findMany + 循环）
 * 2. 校验 expiresAt > now（过期则返回 false，不删除）
 * 3. 成功即删除该记录（一次性消费）→ 返回 true
 * 4. 不存在或过期 → 返回 false
 *
 * @param db            数据库适配器
 * @param provider      渠道类型
 * @param providerOpenid 渠道标识符
 * @param code          待校验的验证码
 * @returns 校验是否通过
 */
export async function exchangeCode(
    db: DatabaseAdapter,
    provider: string,
    providerOpenid: string,
    code: string
): Promise<boolean> {
    const identifier = buildIdentifier(provider, providerOpenid);
    const now = Date.now();

    // 精确匹配 identifier + value
    const record = await db.findOne({
        model: "verification",
        where: [
            { field: "identifier", value: identifier },
            { field: "value", value: code },
        ],
    }) as VerificationRecord | null;

    if (!record) return false;

    // 校验未过期
    const expiresAt = record.expiresAt as Date;
    if (expiresAt.getTime() <= now) return false;

    // 一次性消费：删除记录
    await db.deleteOne({
        model: "verification",
        where: [{ field: "id", value: record.id }],
    });

    return true;
}

// ---- 工厂（auth.ts 构造时使用，绑定 db 闭包） ----

export interface ChannelVerificationDeps {
    db: DatabaseAdapter;
}

export function createChannelVerification(deps: ChannelVerificationDeps) {
    const { db } = deps;

    return {
        /** 向指定渠道请求验证码 */
        requestCode(
            provider: string,
            providerOpenid: string,
            channelRef?: SocialAccountRef
        ): Promise<void> {
            return requestCode(db, provider, providerOpenid, channelRef);
        },

        /** 校验并消费验证码（一次性） */
        exchangeCode(
            provider: string,
            providerOpenid: string,
            code: string
        ): Promise<boolean> {
            return exchangeCode(db, provider, providerOpenid, code);
        },
    };
}
