// POST /api/auth/social/callback/[provider]
// 通用 OAuth 回调端点。platform 由 URL 动态路由决定。
// 完成用户查找/创建与渠道绑定，不建立会话（不设置任何 cookie）。
//
// omni-auth 3.0.0：回调走对象形式参数，库内强制校验 state——
// expectedState 取自发起授权时写入的签名 cookie（oauth_state），
// 缺失或不匹配一律 403（fail-closed）。

import { NextResponse, type NextRequest } from "next/server";
import { OAuthStateMismatchError } from "omni-auth";
import { auth } from "@/lib/auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    const { provider } = await params;

    const body = await request.json();
    const { code, redirectUri, state } = body as {
      code?: string;
      redirectUri?: string;
      state?: string;
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

    // expectedState / codeVerifier 来自发起授权时服务端写入的签名 cookie
    const expectedState = request.cookies.get("oauth_state")?.value;
    const codeVerifier = request.cookies.get("oauth_code_verifier")?.value;

    const result = await auth.handleOAuthCallback(provider, code, redirectUri, {
      state,
      expectedState,
      codeVerifier,
    });
    return NextResponse.json({
      success: true,
      userId: result.userId,
      isNewUser: result.isNewUser,
      channel: result.channel,
    });
  } catch (err) {
    console.error("[social/callback]", err);
    const message = err instanceof Error ? err.message : "服务器内部错误";
    const status =
      err instanceof OAuthStateMismatchError
        ? 403
        : message.includes("未注册的 OAuth 平台")
          ? 400
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
