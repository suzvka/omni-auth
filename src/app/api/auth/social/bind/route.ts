// POST /api/auth/social/bind
// 已登录用户绑定新的渠道

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { nextjsRequestContext } from "omni-auth-nextjs";
import { SocialAccountConflictError } from "omni-auth";

export async function POST(request: Request) {
  try {
    const ctx = nextjsRequestContext(await headers());
    const { authUserId } = await auth.requireContext(ctx);

    const body = await request.json();
    const { provider, providerOpenid } = body as {
      provider?: string;
      providerOpenid?: string;
      accessToken?: string;
      refreshToken?: string;
      tokenExpiresAt?: number;
      profileData?: Record<string, unknown>;
      valid?: number;
      allowPasswordUpdate?: number;
    };

    if (!provider || !providerOpenid) {
      return NextResponse.json(
        { error: "缺少 provider 或 providerOpenid" },
        { status: 400 }
      );
    }

    const result = await auth.bindChannel(ctx, {
      provider,
      providerOpenid,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      tokenExpiresAt: body.tokenExpiresAt,
      profileData: body.profileData,
      valid: body.valid,
      allowPasswordUpdate: body.allowPasswordUpdate,
    });

    return NextResponse.json({ success: true, channel: result });
  } catch (err) {
    if (err instanceof SocialAccountConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[social/bind]", err);
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
