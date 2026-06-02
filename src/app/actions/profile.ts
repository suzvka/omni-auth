"use server";

import { routeHelpers } from "@/lib/auth";

export async function getProfile() {
  const ctx = await routeHelpers.requireContext();
  return { displayName: ctx.account?.displayName ?? "未关联账户" };
}
