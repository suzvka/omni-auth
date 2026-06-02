// DELETE /api/auth/social/unbind
// 已登录用户解绑社交账户

import { NextResponse } from "next/server";
import { auth, routeHelpers } from "@/lib/auth";

export async function DELETE(request: Request) {
  try {
    await routeHelpers.requireContext();

    const body = await request.json();
    const { id } = body as { id?: string };

    if (!id) {
      return NextResponse.json(
        { error: "缺少社交账户 id" },
        { status: 400 }
      );
    }

    await auth.social.unbindFromUser(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[social/unbind]", err);
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
