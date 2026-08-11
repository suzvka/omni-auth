// PUT /api/me/profile
// 更新当前用户的个人资料（name / image）

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { nextjsRequestContext } from "omni-auth/nextjs";
import { UnauthorizedError } from "omni-auth";

export async function PUT(request: Request) {
  try {
    const ctx = nextjsRequestContext(await headers());

    const body = await request.json();
    const { name, image } = body as {
      name?: string;
      image?: string;
    };

    if (name === undefined && image === undefined) {
      return NextResponse.json(
        { error: "至少需要提供 name 或 image 字段" },
        { status: 400 }
      );
    }

    if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
      return NextResponse.json(
        { error: "name 不能为空" },
        { status: 400 }
      );
    }

    await auth.updateProfile(ctx, {
      name: name?.trim() || undefined,
      image: image || undefined,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error("[me/profile]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "服务器内部错误" },
      { status: 500 }
    );
  }
}
