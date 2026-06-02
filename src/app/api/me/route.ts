import { NextResponse } from "next/server";
import { routeHelpers } from "@/lib/auth";

export async function GET() {
  const ctx = await routeHelpers.getContext();
  return NextResponse.json({
    user: ctx.account
      ? {
          id: ctx.account.id,
          displayName: ctx.account.displayName,
          status: ctx.account.status,
          createdAt: ctx.account.createdAt,
        }
      : null,
    authUserId: ctx.authUserId,
    roles: ctx.roles,
    socialAccounts: ctx.socialAccounts,
  });
}
