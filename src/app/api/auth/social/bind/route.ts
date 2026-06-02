// POST /api/auth/social/bind
// 已登录用户绑定新的社交账户

import { NextResponse } from "next/server";
import { auth, routeHelpers } from "@/lib/auth";
import { SocialAccountConflictError } from "changfeng-auth";

export async function POST(request: Request) {
  try {
    const { authUserId } = await routeHelpers.requireContext();

    const body = await request.json();
    const { provider, providerOpenid } = body as {
      provider?: string;
      providerOpenid?: string;
      accessToken?: string;
      refreshToken?: string;
      tokenExpiresAt?: number;
      profileData?: Record<string, unknown>;
    };

    if (!provider || !providerOpenid) {
      return NextResponse.json(
        { error: "缺少 provider 或 providerOpenid" },
        { status: 400 }
      );
    }

    const result = await auth.social.bindToUser(authUserId!, {
      provider,
      providerOpenid,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      tokenExpiresAt: body.tokenExpiresAt,
      profileData: body.profileData,
    });

    return NextResponse.json({ success: true, socialAccount: result });
  } catch (err) {
    if (err instanceof SocialAccountConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[social/bind]", err);
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
