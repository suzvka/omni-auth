// ============================================================
// POST /api/auth/reset-password
// 执行密码重置：校验验证码 + 更新密码 + 吊销全部 token
// ============================================================

import { auth } from "@/lib/auth";
import { checkSameOriginFromHeaders, CROSS_ORIGIN_ERROR } from "@/lib/csrf";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
    try {
        // CSRF 同源校验（D13）
        if (!(await checkSameOriginFromHeaders())) {
            return NextResponse.json({ error: CROSS_ORIGIN_ERROR }, { status: 403 });
        }

        const { provider, providerOpenid, code, newPassword } = await request.json();
        await auth.resetPassword(provider, providerOpenid, code, newPassword);
        return NextResponse.json({ success: true });
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 400 },
        );
    }
}
