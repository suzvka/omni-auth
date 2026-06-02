import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { oauthCookieResponse } from "changfeng-auth-nextjs";

// ============================================================
// POST /api/auth/social-signup
// 社交账户注册：通过 SDK 的 signUpWithSocial 一行完成注册+绑定
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

    // ---------- 注册 + 社交绑定（SDK 原子操作） ----------
    const result = await auth.signUpWithSocial({
      email,
      password,
      name,
      social: {
        provider: social.provider,
        providerOpenid: social.providerOpenid,
        accessToken: social.accessToken,
        refreshToken: social.refreshToken,
        tokenExpiresAt: social.tokenExpiresAt,
        profileData: social.profileData,
      },
    });

    return oauthCookieResponse({
      token: result.token,
      userId: result.userId,
      isNewUser: true,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "服务器内部错误";
    const status = message.includes("已被其他用户绑定") ? 409 : 422;
    console.error("[social-signup]", err);
    return NextResponse.json({ error: message }, { status });
  }
}
