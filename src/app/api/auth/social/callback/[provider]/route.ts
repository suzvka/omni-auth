// POST /api/auth/social/callback/[provider]
// 通用 OAuth 回调端点。platform 由 URL 动态路由决定。

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { oauthCookieResponse } from "omni-auth-nextjs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    const { provider } = await params;

    const body = await request.json();
    const { code, redirectUri } = body as {
      code?: string;
      redirectUri?: string;
    };

    if (!code) {
      return NextResponse.json(
        { error: "缺少授权码 code" },
        { status: 400 }
      );
    }

    if (!redirectUri) {
      return NextResponse.json(
        { error: "缺少 redirectUri" },
        { status: 400 }
      );
    }

    const result = await auth.handleOAuthCallback(provider, code, redirectUri);
    return oauthCookieResponse(auth, {
      token: result.token,
      userId: result.userId,
      isNewUser: result.isNewUser,
    }, { channel: result.channel });
  } catch (err) {
    console.error("[social/callback]", err);
    const message = err instanceof Error ? err.message : "服务器内部错误";
    const status =
      message.includes("未注册的 OAuth 平台") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
