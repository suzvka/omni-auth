// GET /api/me/sessions
// 列出当前用户所有活跃 Session

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { nextjsRequestContext } from "omni-auth/nextjs";
import { UnauthorizedError } from "omni-auth";

export async function GET() {
  try {
    const ctx = nextjsRequestContext(await headers());
    const sessions = await auth.listSessions(ctx);

    return NextResponse.json({ sessions });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error("[me/sessions]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "服务器内部错误" },
      { status: 500 }
    );
  }
}
