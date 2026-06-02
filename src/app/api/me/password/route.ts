// PUT /api/me/password
// 修改当前用户密码（需要旧密码验证）

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { nextjsRequestContext } from "changfeng-auth-nextjs";
import { UnauthorizedError, InvalidPasswordError } from "changfeng-auth";

export async function PUT(request: Request) {
  try {
    const ctx = nextjsRequestContext(await headers());

    const body = await request.json();
    const { oldPassword, newPassword } = body as {
      oldPassword?: string;
      newPassword?: string;
    };

    if (!oldPassword || !newPassword) {
      return NextResponse.json(
        { error: "缺少必填字段：oldPassword, newPassword" },
        { status: 400 }
      );
    }

    if (newPassword.length < 6) {
      return NextResponse.json(
        { error: "新密码长度不能少于 6 位" },
        { status: 400 }
      );
    }

    await auth.changePassword(ctx, oldPassword, newPassword);

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof InvalidPasswordError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error("[me/password]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "服务器内部错误" },
      { status: 500 }
    );
  }
}
