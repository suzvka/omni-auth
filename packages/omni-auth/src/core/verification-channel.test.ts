import { describe, it, expect, beforeEach } from "vitest";
import {
    requestCode,
    verifyCode,
    registerVerificationSender,
    registerVerificationVerifier,
    getVerificationSender,
    getVerificationVerifier,
} from "./verification-channel";
import type { VerificationSender, VerificationVerifier } from "./verification-channel";
import type { SocialAccountRef } from "../social/token";

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

beforeEach(() => {
    sentChannelRef = null;
    sentCode = null;
    verifiedChannelRef = null;
    verifiedCode = null;
    verifyResult = true;
    registerVerificationSender("email", mockSender);
    registerVerificationVerifier("email", mockVerifier);
});

// ---- requestCode ----

describe("requestCode", () => {
    it("返回密码学安全的 6 位数字种子码", async () => {
        for (let i = 0; i < 50; i++) {
            const code = await requestCode("email", `user${i}@example.com`);
            expect(code).toMatch(/^\d{6}$/);
            const num = Number(code);
            expect(num).toBeGreaterThanOrEqual(100000);
            expect(num).toBeLessThanOrEqual(999999);
        }
    });

    it("调用已注册的 sender 投递种子码", async () => {
        const code = await requestCode("email", "user@example.com");

        expect(sentChannelRef).not.toBeNull();
        expect(sentChannelRef!.provider).toBe("email");
        expect(sentChannelRef!.providerOpenid).toBe("user@example.com");
        expect(sentCode).toBe(code);
    });

    it("未注册 sender 时不抛错，仅返回种子码", async () => {
        const code = await requestCode("phone", "13800000000");

        expect(code).toMatch(/^\d{6}$/);
        expect(sentCode).toBeNull(); // 未触发投递
    });

    it("未传入 channelRef 时构造最小引用", async () => {
        await requestCode("email", "user@example.com");

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

        await requestCode("email", "user@example.com", fullRef);

        expect(sentChannelRef).toEqual(fullRef);
    });
});

// ---- verifyCode ----

describe("verifyCode", () => {
    it("委托 verifier 并透传 true", async () => {
        verifyResult = true;
        const ok = await verifyCode("email", "user@example.com", "123456");
        expect(ok).toBe(true);
    });

    it("委托 verifier 并透传 false", async () => {
        verifyResult = false;
        const ok = await verifyCode("email", "user@example.com", "000000");
        expect(ok).toBe(false);
    });

    it("向 verifier 传入正确的 channel 与 code", async () => {
        await verifyCode("email", "user@example.com", "654321");

        expect(verifiedChannelRef).not.toBeNull();
        expect(verifiedChannelRef!.provider).toBe("email");
        expect(verifiedChannelRef!.providerOpenid).toBe("user@example.com");
        expect(verifiedCode).toBe("654321");
    });

    it("未注册 verifier 时抛错", async () => {
        await expect(
            verifyCode("phone", "13800000000", "123456")
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

        await verifyCode("email", "user@example.com", "111111", fullRef);

        expect(verifiedChannelRef).toEqual(fullRef);
    });
});

// ---- 注册表 ----

describe("注册表", () => {
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
