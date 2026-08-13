// ============================================================
// POST /api/auth/sign-up
// 邮箱注册：创建用户，不建立会话
// ============================================================

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { RateLimitedError, UserExistsError } from "omni-auth";
import { nextjsRequestContext } from "omni-auth/nextjs";
import { auth } from "@/lib/auth";
import { checkSameOriginFromHeaders, CROSS_ORIGIN_ERROR } from "@/lib/csrf";

export async function POST(request: Request) {
    try {
        // CSRF 同源校验
        if (!(await checkSameOriginFromHeaders())) {
            return NextResponse.json({ error: CROSS_ORIGIN_ERROR }, { status: 403 });
        }

        const body = await request.json();
        const { email, password, name } = body as {
            email?: string;
            password?: string;
            name?: string;
        };

        if (!email || !password || !name) {
            return NextResponse.json(
                { error: "缺少必填字段" },
                { status: 400 }
            );
        }

        // 传入请求上下文：限流按客户端 IP 生效
        const ctx = nextjsRequestContext(await headers());
        const result = await auth.signUp({ email, password, name }, ctx);

        return NextResponse.json({ success: true, user: result.user });
    } catch (err) {
        if (err instanceof RateLimitedError) {
            return NextResponse.json(
                { error: err.message },
                {
                    status: 429,
                    headers: { "Retry-After": String(err.retryAfterSeconds) },
                }
            );
        }
        if (err instanceof UserExistsError) {
            return NextResponse.json({ error: err.message }, { status: 409 });
        }
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "服务器内部错误" },
            { status: 500 }
        );
    }
}
