// ============================================================
// 密码管理（重置 & 修改）
// ============================================================

import type { BetterAuthInstance } from "../auth";
import type { EmailAdapter } from "../adapters/email";
import type { RequestContext } from "../adapters/request";
import type { BetterAuthSession, SignInEmailResult } from "./betterAuthTypes";
import { InvalidPasswordError } from "../errors";

export interface PasswordResetDeps {
  auth: BetterAuthInstance;
  email: EmailAdapter;
  baseUrl: string;
}

export function createPasswordReset(deps: PasswordResetDeps) {
  const { auth, email, baseUrl } = deps;

  return {
    /** 请求密码重置（发送重置邮件） */
    async requestReset(emailAddress: string): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (auth.api as any).forgetPassword({
        body: {
          email: emailAddress,
          redirectTo: `${baseUrl}/reset-password`,
        },
      });

      // Better Auth 内部已发送邮件（如果配置了 email 插件）
      // 若需要自定义邮件，可在此补充发送逻辑
    },

    /** 执行密码重置 */
    async reset(token: string, newPassword: string): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (auth.api as any).resetPassword({
        body: { token, newPassword },
      });
    },

    /** 自定义发送密码重置邮件 */
    async sendCustomResetEmail(
      emailAddress: string,
      token: string
    ): Promise<void> {
      const url = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
      await email.sendPasswordResetEmail({
        to: emailAddress,
        subject: "密码重置",
        url,
        token,
      });
    },

    /**
     * 修改密码（已知旧密码，修改为新密码）。
     * 通过 Better Auth changePassword API 完成。
     */
    async changePassword(
      ctx: RequestContext,
      oldPassword: string,
      newPassword: string
    ): Promise<void> {
      // 1. 获取当前 session，拿到用户邮箱
      const session = await auth.api.getSession({
        headers: ctx.asHeaders ? ctx.asHeaders() : {},
      }) as unknown as BetterAuthSession | null;

      if (!session?.user?.id) {
        throw new InvalidPasswordError("未登录，无法修改密码");
      }

      const user = session.user;

      // 2. 验证旧密码
      try {
        const signInResult = await auth.api.signInEmail({
          body: { email: user.email, password: oldPassword },
        }) as unknown as SignInEmailResult | { error: string };

        if ("error" in signInResult) {
          throw new InvalidPasswordError("当前密码错误");
        }
      } catch (err) {
        if (err instanceof InvalidPasswordError) throw err;
        throw new InvalidPasswordError("密码验证失败");
      }

      // 3. 修改密码
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (auth.api as any).changePassword({
          body: {
            newPassword,
            currentPassword: oldPassword,
          },
          headers: ctx.asHeaders ? ctx.asHeaders() : {},
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`密码修改失败: ${message}`);
      }
    },
  };
}
