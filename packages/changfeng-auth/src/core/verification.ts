// ============================================================
// 邮箱验证
// ============================================================

import type { BetterAuthInstance } from "../auth";
import type { RequestContext } from "../adapters/request";
import type { BetterAuthSession } from "./betterAuthTypes";
import { UnauthorizedError } from "../errors";

export interface EmailVerificationDeps {
  auth: BetterAuthInstance;
}

export function createEmailVerification(deps: EmailVerificationDeps) {
  const { auth } = deps;

  return {
    /** 请求发送验证邮件 */
    async requestVerification(ctx: RequestContext): Promise<void> {
      const session = await auth.api.getSession({
        headers: ctx.asHeaders ? ctx.asHeaders() : {},
      }) as unknown as BetterAuthSession | null;

      if (!session?.user?.id) {
        throw new UnauthorizedError(
          "UNAUTHENTICATED",
          "请先登录后再请求邮箱验证"
        );
      }

      // Better Auth 内置 API
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (auth.api as any).sendVerificationEmail({
        body: {
          email: session.user.email,
        },
        headers: ctx.asHeaders ? ctx.asHeaders() : {},
      });
    },

    /** 验证邮箱 token */
    async verify(token: string): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (auth.api as any).verifyEmail({
        query: { token },
      });
    },
  };
}
