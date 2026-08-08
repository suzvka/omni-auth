// POST /api/me/sessions/revoke-all
// 吊销当前用户除本次请求外的所有 Session（踢出所有其他设备）

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { nextjsRequestContext } from "omni-auth-nextjs";
import { UnauthorizedError } from "omni-auth";

export async function POST() {
  try {
    const ctx = nextjsRequestContext(await headers());
    const revokedCount = await auth.revokeAllSessions(ctx);

    return NextResponse.json({ success: true, revokedCount });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error("[me/sessions/revoke-all]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "服务器内部错误" },
      { status: 500 }
    );
  }
}
