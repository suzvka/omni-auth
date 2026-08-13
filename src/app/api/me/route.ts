import { NextResponse } from "next/server";
import { routeHelpers } from "@/lib/auth";

export async function GET() {
  const ctx = await routeHelpers.getContext();
  // ---- 直接返回完整 AuthContext（含 account, tokenMetadata 等），与 client.getContext() 类型一致
  return NextResponse.json(ctx);
}
