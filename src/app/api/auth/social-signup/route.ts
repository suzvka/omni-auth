import { NextResponse } from "next/server";
import { auth } from "@/modules/auth/config";
import { socialAccountRepo } from "@/modules/db";

// ============================================================
// POST /api/auth/social-signup
// 社交账户注册：Better Auth 创建 User + 绑定社交平台身份
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

    // 简单密码校验
    if (password.length < 6) {
      return NextResponse.json(
        { error: "密码长度不能少于 6 位" },
        { status: 400 }
      );
    }

    // ---------- 防重复注册 ----------
    const existingSocial = await socialAccountRepo.findByProvider(
      social.provider,
      social.providerOpenid
    );
    if (existingSocial) {
      return NextResponse.json(
        { error: "该社交账号已被其他用户绑定" },
        { status: 409 }
      );
    }

    // ---------- Better Auth 注册 ----------
    let signUpResult: { token: string | null; user: { id: string; email: string; name: string } };
    try {
      signUpResult = await auth.api.signUpEmail({
        body: {
          email,
          password,
          name,
        },
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `注册失败: ${message}` },
        { status: 422 }
      );
    }

    // ---------- 创建 SocialAccount ----------
    await socialAccountRepo.create({
      userId: signUpResult.user.id,
      provider: social.provider,
      providerOpenid: social.providerOpenid,
      accessToken: social.accessToken,
      refreshToken: social.refreshToken,
      tokenExpiresAt: social.tokenExpiresAt,
      profileData: social.profileData,
    });

    // ---------- 设置 Session Cookie ----------
    const response = NextResponse.json({
      success: true,
      user: {
        id: signUpResult.user.id,
        email: signUpResult.user.email,
        name: signUpResult.user.name,
      },
    });

    if (signUpResult.token) {
      response.cookies.set("better-auth.session_token", signUpResult.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 7, // 7 天
        path: "/",
      });
    }

    return response;
  } catch (err: unknown) {
    console.error("[social-signup] 未预期错误:", err);
    return NextResponse.json(
      { error: "服务器内部错误" },
      { status: 500 }
    );
  }
}
