import { headers } from "next/headers";
import { auth } from "./config";
import { getAccountResolver } from "./resolver";
import { UnauthorizedError } from "./errors";
import type { AuthContext } from "./types";

export async function getAuthContext(): Promise<AuthContext> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user?.id) {
    return { account: null, authUserId: null };
  }

  const authUserId = session.user.id;
  const resolver = getAccountResolver();

  if (!resolver) {
    return { account: null, authUserId };
  }

  const account = await resolver.findByAuthUserId(authUserId);
  return { account, authUserId };
}

export async function requireAuthContext(): Promise<AuthContext> {
  const ctx = await getAuthContext();

  if (ctx.authUserId === null) {
    throw new UnauthorizedError(
      "UNAUTHENTICATED",
      "Authentication required. Please sign in."
    );
  }

  return ctx;
}
