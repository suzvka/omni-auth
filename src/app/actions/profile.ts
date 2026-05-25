"use server";

import { requireAuthContext } from "@/modules/auth";

export async function getProfile() {
  const { account } = await requireAuthContext();
  return { displayName: account?.displayName ?? "未关联账户" };
}
