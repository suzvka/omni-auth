// ============================================================
// POST /api/auth/forget-password
// 请求密码重置：向指定渠道发送验证码
// ============================================================

import { auth } from "@/lib/auth";
import { checkSameOriginFromHeaders, CROSS_ORIGIN_ERROR } from "@/lib/csrf";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
    try {
        // CSRF 同源校验
        if (!(await checkSameOriginFromHeaders())) {
            return NextResponse.json({ error: CROSS_ORIGIN_ERROR }, { status: 403 });
        }

        const { provider, providerOpenid } = await request.json();
        await auth.requestPasswordReset(provider, providerOpenid);
        return NextResponse.json({ success: true });
    } catch (e) {
        return NextResponse.json(
            { error: e instanceof Error ? e.message : String(e) },
            { status: 400 },
        );
    }
}
