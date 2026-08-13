// ============================================================
// POST /api/auth/sign-in
// 邮箱登录：仅凭证校验（用户存在 + 密码正确），不建立会话
// ============================================================

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkSameOriginFromHeaders, CROSS_ORIGIN_ERROR } from "@/lib/csrf";

export async function POST(request: Request) {
    try {
        // CSRF 同源校验
        if (!(await checkSameOriginFromHeaders())) {
            return NextResponse.json({ error: CROSS_ORIGIN_ERROR }, { status: 403 });
        }

        const body = await request.json();
        const { email, password } = body as {
            email?: string;
            password?: string;
        };

        if (!email || !password) {
            return NextResponse.json(
                { error: "缺少必填字段" },
                { status: 400 }
            );
        }

        const result = await auth.signIn({ email, password });

        return NextResponse.json({ success: true, user: result.user });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "服务器内部错误" },
            { status: 500 }
        );
    }
}
