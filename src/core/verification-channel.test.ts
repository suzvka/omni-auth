import { describe, it, expect, beforeEach } from "vitest";
import {
    requestCode,
    verifyCode,
    registerVerificationSender,
    registerVerificationVerifier,
    getVerificationSender,
    getVerificationVerifier,
    createChannelVerification,
} from "./verification-channel";
import type { VerificationSender, VerificationVerifier } from "./verification-channel";
import type { SocialAccountRef } from "../social/token";
import { createRegistry, type OmniRegistry } from "../registry";

// ============================================================
// Mock 验证码投递器 / 验证器（委托模式：状态由实现方管理）
// ============================================================

let sentChannelRef: SocialAccountRef | null = null;
let sentCode: string | null = null;

const mockSender: VerificationSender = {
    async send(channel, code) {
        sentChannelRef = channel;
        sentCode = code;
    },
};

let verifiedChannelRef: SocialAccountRef | null = null;
let verifiedCode: string | null = null;
let verifyResult = true;

const mockVerifier: VerificationVerifier = {
    async verify(channel, code) {
        verifiedChannelRef = channel;
        verifiedCode = code;
        return verifyResult;
    },
};

// 3.0.0：原语接收实例注册表作为首个参数
let registry: OmniRegistry;

beforeEach(() => {
    sentChannelRef = null;
    sentCode = null;
    verifiedChannelRef = null;
    verifiedCode = null;
    verifyResult = true;
    registry = createRegistry();
    registry.senders.set("email", mockSender);
    registry.verifiers.set("email", mockVerifier);
});

// ---- requestCode ----

describe("requestCode", () => {
    it("返回密码学安全的 6 位数字种子码", async () => {
        for (let i = 0; i < 50; i++) {
            const code = await requestCode(registry, "email", `user${i}@example.com`);
            expect(code).toMatch(/^\d{6}$/);
            const num = Number(code);
            expect(num).toBeGreaterThanOrEqual(100000);
            expect(num).toBeLessThanOrEqual(999999);
        }
    });

    it("调用已注册的 sender 投递种子码", async () => {
        const code = await requestCode(registry, "email", "user@example.com");

        expect(sentChannelRef).not.toBeNull();
        expect(sentChannelRef!.provider).toBe("email");
        expect(sentChannelRef!.providerOpenid).toBe("user@example.com");
        expect(sentCode).toBe(code);
    });

    it("未注册 sender 时不抛错，仅返回种子码", async () => {
        const code = await requestCode(registry, "phone", "13800000000");

        expect(code).toMatch(/^\d{6}$/);
        expect(sentCode).toBeNull(); // 未触发投递
    });

    it("未传入 channelRef 时构造最小引用", async () => {
        await requestCode(registry, "email", "user@example.com");

        expect(sentChannelRef).not.toBeNull();
        expect(sentChannelRef!.id).toBe("");
        expect(sentChannelRef!.accessToken).toBeNull();
        expect(sentChannelRef!.refreshToken).toBeNull();
    });

    it("传入 channelRef 时原样传递给 sender", async () => {
        const fullRef: SocialAccountRef = {
            id: "ch-1",
            provider: "email",
            providerOpenid: "user@example.com",
            accessToken: "tok-abc",
            refreshToken: null,
            tokenExpiresAt: null,
            profileData: { name: "Test" },
        };

        await requestCode(registry, "email", "user@example.com", fullRef);

        expect(sentChannelRef).toEqual(fullRef);
    });
});

// ---- verifyCode ----

describe("verifyCode", () => {
    it("委托 verifier 并透传 true", async () => {
        verifyResult = true;
        const ok = await verifyCode(registry, "email", "user@example.com", "123456");
        expect(ok).toBe(true);
    });

    it("委托 verifier 并透传 false", async () => {
        verifyResult = false;
        const ok = await verifyCode(registry, "email", "user@example.com", "000000");
        expect(ok).toBe(false);
    });

    it("向 verifier 传入正确的 channel 与 code", async () => {
        await verifyCode(registry, "email", "user@example.com", "654321");

        expect(verifiedChannelRef).not.toBeNull();
        expect(verifiedChannelRef!.provider).toBe("email");
        expect(verifiedChannelRef!.providerOpenid).toBe("user@example.com");
        expect(verifiedCode).toBe("654321");
    });

    it("未注册 verifier 时抛错", async () => {
        await expect(
            verifyCode(registry, "phone", "13800000000", "123456")
        ).rejects.toThrow('渠道 "phone" 未注册验证码验证器');
    });

    it("传入 channelRef 时原样传递给 verifier", async () => {
        const fullRef: SocialAccountRef = {
            id: "ch-2",
            provider: "email",
            providerOpenid: "user@example.com",
            accessToken: "tok-xyz",
            refreshToken: null,
            tokenExpiresAt: null,
            profileData: {},
        };

        await verifyCode(registry, "email", "user@example.com", "111111", fullRef);

        expect(verifiedChannelRef).toEqual(fullRef);
    });
});

// ---- createChannelVerification（实例服务） ----

describe("createChannelVerification", () => {
    it("绑定实例注册表：requestCode 走注册的 sender", async () => {
        const service = createChannelVerification(registry);
        const code = await service.requestCode("email", "user@example.com");

        expect(code).toMatch(/^\d{6}$/);
        expect(sentCode).toBe(code);
    });

    it("绑定实例注册表：verifyCode 走注册的 verifier", async () => {
        verifyResult = false;
        const service = createChannelVerification(registry);
        const ok = await service.verifyCode("email", "user@example.com", "123456");
        expect(ok).toBe(false);
    });

    it("不同注册表互不干扰", async () => {
        const other = createRegistry(); // 空注册表成为活跃注册表
        const service = createChannelVerification(other);

        // other 未注册 verifier → 抛错；registry 中的 mockVerifier 不被误用
        await expect(
            service.verifyCode("email", "user@example.com", "123456")
        ).rejects.toThrow('渠道 "email" 未注册验证码验证器');
    });
});

// ---- 弃用全局注册函数（转发到活跃注册表） ----

describe("注册表（弃用全局函数）", () => {
    it("registerVerificationSender / getVerificationSender 往返一致", () => {
        registerVerificationSender("phone", mockSender);
        expect(getVerificationSender("phone")).toBe(mockSender);
    });

    it("registerVerificationVerifier / getVerificationVerifier 往返一致", () => {
        registerVerificationVerifier("phone", mockVerifier);
        expect(getVerificationVerifier("phone")).toBe(mockVerifier);
    });

    it("未注册渠道返回 undefined", () => {
        expect(getVerificationSender("wechat")).toBeUndefined();
        expect(getVerificationVerifier("wechat")).toBeUndefined();
    });
});
