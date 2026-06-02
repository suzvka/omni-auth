// GET /api/auth/social/list
// 获取当前用户已绑定的所有社交账户

import { NextResponse } from "next/server";
import { auth, routeHelpers } from "@/lib/auth";

export async function GET() {
  try {
    const { authUserId } = await routeHelpers.requireContext();

    const accounts = await auth.social.listByUser(authUserId!);

    return NextResponse.json({ socialAccounts: accounts });
  } catch (err) {
    console.error("[social/list]", err);
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
