import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { oauthCookieResponse } from "changfeng-auth-nextjs";

// ============================================================
// POST /api/auth/social-signup
// 统一通道注册：通过 authenticateChannel 一行完成注册+绑定
// ============================================================

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const { email, password, name, social } = body as {
      email?: string;
      password?: string;
      name?: string;
      social?: {
        provider?: string;
        providerOpenid?: string;
        accessToken?: string;
        refreshToken?: string;
        tokenExpiresAt?: number;
        profileData?: Record<string, unknown>;
      };
    };

    // ---------- 校验 ----------
    if (!email || !password || !name) {
      return NextResponse.json(
        { error: "缺少必填字段：email, password, name" },
        { status: 400 }
      );
    }

    if (!social?.provider || !social?.providerOpenid) {
      return NextResponse.json(
        { error: "缺少 social.provider 或 social.providerOpenid" },
        { status: 400 }
      );
    }

    // ---------- 统一通道注册 ----------
    const result = await auth.authenticateChannel({
      provider: social.provider,
      providerOpenid: social.providerOpenid,
      credential: { type: "password", value: password },
      profile: { name },
      channelData: {
        accessToken: social.accessToken,
        refreshToken: social.refreshToken,
        tokenExpiresAt: social.tokenExpiresAt,
        profileData: social.profileData,
        valid: 1,
        allowPasswordUpdate: 0,
      },
    });

    return oauthCookieResponse(auth, {
      token: result.token,
      userId: result.userId,
      isNewUser: result.isNewUser,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "服务器内部错误";
    const status = message.includes("已被绑定") ? 409 : 422;
    console.error("[social-signup]", err);
    return NextResponse.json({ error: message }, { status });
  }
}
