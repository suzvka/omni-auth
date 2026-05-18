// src/middleware.ts
// 预留中间件 — Phase 1 透传，Phase 3 启用 AuthGuard
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
