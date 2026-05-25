import { NextResponse } from "next/server";
import { getAuthContext } from "@/modules/auth";

export async function GET() {
  const ctx = await getAuthContext();
  return NextResponse.json(ctx);
}
