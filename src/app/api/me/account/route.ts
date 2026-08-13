// DELETE /api/me/account
// 注销当前用户账号（需要密码验证），成功后清除 session cookie

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { nextjsRequestContext } from "omni-auth/nextjs";
import { InvalidPasswordError } from "omni-auth";
import { checkSameOrigin, CROSS_ORIGIN_ERROR } from "@/lib/csrf";

export async function DELETE(request: Request) {
  try {
    const ctx = nextjsRequestContext(await headers());

    // CSRF 同源校验（D13）
    if (!checkSameOrigin(ctx)) {
      return NextResponse.json({ error: CROSS_ORIGIN_ERROR }, { status: 403 });
    }

    const body = await request.json();
    const { password } = body as { password?: string };

    if (!password) {
      return NextResponse.json(
        { error: "缺少必填字段：password" },
        { status: 400 }
      );
    }

    await auth.deleteAccount(ctx, password);

    // 注销成功后清除 token cookie
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
    if (err instanceof InvalidPasswordError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error("[me/account]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "服务器内部错误" },
      { status: 500 }
    );
  }
}
