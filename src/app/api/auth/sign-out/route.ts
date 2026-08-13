// ============================================================
// POST /api/auth/sign-out
// 登出：吊销当前 AuthToken + 清除 cookie
// ============================================================

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { nextjsRequestContext } from "omni-auth/nextjs";
import { checkSameOrigin, CROSS_ORIGIN_ERROR } from "@/lib/csrf";

export async function POST() {
    try {
        const ctx = nextjsRequestContext(await headers());

        // CSRF 同源校验（D13）
        if (!checkSameOrigin(ctx)) {
            return NextResponse.json({ error: CROSS_ORIGIN_ERROR }, { status: 403 });
        }

        await auth.signOut(ctx);

        const response = NextResponse.json({ success: true });
        response.cookies.set("omni-auth.token", "", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 0,
            path: "/",
        });
        return response;
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "服务器内部错误" },
            { status: 500 }
        );
    }
}
