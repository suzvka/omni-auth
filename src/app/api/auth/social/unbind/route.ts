// DELETE /api/auth/social/unbind
// 已登录用户解绑渠道

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { nextjsRequestContext } from "omni-auth/nextjs";

export async function DELETE(request: Request) {
  try {
    const ctx = nextjsRequestContext(await headers());
    await auth.requireContext(ctx);

    const body = await request.json();
    const { id } = body as { id?: string };

    if (!id) {
      return NextResponse.json(
        { error: "缺少渠道 id" },
        { status: 400 }
      );
    }

    await auth.unbindChannel(ctx, id);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[social/unbind]", err);
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
