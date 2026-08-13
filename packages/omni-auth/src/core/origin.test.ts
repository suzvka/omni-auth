import { describe, it, expect } from "vitest";
import { isSameOrigin, createOriginCheck } from "./origin";
import { createRequestContext } from "../adapters/request";

const BASE = "http://localhost:3000";

// 构造 RequestContext 的辅助函数
function makeCtx(headers: Record<string, string>): ReturnType<typeof createRequestContext> {
    return createRequestContext(headers);
}

describe("isSameOrigin", () => {
    // ---- Origin header ----

    it("Origin 同源时应返回 true", () => {
        const ctx = makeCtx({ origin: "http://localhost:3000" });
        expect(isSameOrigin(ctx, BASE)).toBe(true);
    });

    it("Origin 跨源时应返回 false", () => {
        const ctx = makeCtx({ origin: "http://evil.com" });
        expect(isSameOrigin(ctx, BASE)).toBe(false);
    });

    it("Origin 大小写不敏感（header 名）", () => {
        const ctx = makeCtx({ Origin: "http://localhost:3000" });
        expect(isSameOrigin(ctx, BASE)).toBe(true);
    });

    // ---- Referer 回退 ----

    it("无 Origin 时 Referer 同源应返回 true", () => {
        const ctx = makeCtx({ referer: "http://localhost:3000" });
        expect(isSameOrigin(ctx, BASE)).toBe(true);
    });

    it("无 Origin 时 Referer 跨源应返回 false", () => {
        const ctx = makeCtx({ referer: "http://evil.com" });
        expect(isSameOrigin(ctx, BASE)).toBe(false);
    });

    it("Origin 优先于 Referer", () => {
        // Origin 跨源，Referer 同源 → 以 Origin 为准，返回 false
        const ctx = makeCtx({
            origin: "http://evil.com",
            referer: "http://localhost:3000",
        });
        expect(isSameOrigin(ctx, BASE)).toBe(false);
    });

    // ---- 缺失 header ----

    it("Origin 与 Referer 均缺失时应返回 false", () => {
        const ctx = makeCtx({});
        expect(isSameOrigin(ctx, BASE)).toBe(false);
    });

    // ---- URL 规范化 ----

    it("Origin 含 path/query 时仍应同源匹配", () => {
        const ctx = makeCtx({ origin: "http://localhost:3000/api/auth/sign-in?foo=bar" });
        expect(isSameOrigin(ctx, BASE)).toBe(true);
    });

    it("Referer 含完整路径时应同源匹配", () => {
        const ctx = makeCtx({ referer: "http://localhost:3000/dashboard/profile" });
        expect(isSameOrigin(ctx, BASE)).toBe(true);
    });

    it("端口不同时应返回 false", () => {
        const ctx = makeCtx({ origin: "http://localhost:8080" });
        expect(isSameOrigin(ctx, BASE)).toBe(false);
    });

    it("协议不同（http vs https）时应返回 false", () => {
        const ctx = makeCtx({ origin: "https://localhost:3000" });
        expect(isSameOrigin(ctx, BASE)).toBe(false);
    });

    it("host 不同时应返回 false", () => {
        const ctx = makeCtx({ origin: "http://api.example.com" });
        expect(isSameOrigin(ctx, "http://localhost:3000")).toBe(false);
    });

    it("无效 URL header 应返回 false（normalizeUrl 返回空串）", () => {
        const ctx = makeCtx({ origin: "not-a-valid-url" });
        expect(isSameOrigin(ctx, BASE)).toBe(false);
    });
});

describe("createOriginCheck", () => {
    it("应返回可复用的校验函数", () => {
        const check = createOriginCheck(BASE);
        expect(typeof check).toBe("function");

        // 同源通过
        const ok = makeCtx({ origin: "http://localhost:3000" });
        expect(check(ok)).toBe(true);

        // 跨源拒绝
        const bad = makeCtx({ origin: "http://evil.com" });
        expect(check(bad)).toBe(false);

        // 缺失拒绝
        const empty = makeCtx({});
        expect(check(empty)).toBe(false);
    });

    it("不同 baseUrl 生成独立校验器", () => {
        const check3000 = createOriginCheck("http://localhost:3000");
        const check8080 = createOriginCheck("http://localhost:8080");

        const ctx = makeCtx({ origin: "http://localhost:3000" });
        expect(check3000(ctx)).toBe(true);
        expect(check8080(ctx)).toBe(false);
    });
});
