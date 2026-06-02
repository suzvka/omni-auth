// ============================================================
// 账号管理（注销 & 信息更新）
// ============================================================

import type { BetterAuthInstance } from "../auth";
import type { DatabaseAdapter } from "../adapters/database";
import type { RequestContext } from "../adapters/request";
import type { BetterAuthSession, DbRecord, SignInEmailResult } from "./betterAuthTypes";
import { InvalidPasswordError, UnauthorizedError } from "../errors";

export interface AccountDeletionDeps {
  auth: BetterAuthInstance;
  db: DatabaseAdapter;
}

/** 可更新的用户资料字段 */
export interface UpdateProfileInput {
  name?: string;
  image?: string;
}

export function createAccountDeletion(deps: AccountDeletionDeps) {
  const { auth, db } = deps;

  return {
    /**
     * 更新用户资料（name / image）。
     * 同步更新 Better Auth user 表和 BusinessAccount 的 displayName。
     */
    async updateProfile(
      ctx: RequestContext,
      input: UpdateProfileInput
    ): Promise<void> {
      // 1. 获取当前 session
      const session = await auth.api.getSession({
        headers: ctx.asHeaders ? ctx.asHeaders() : {},
      }) as unknown as BetterAuthSession | null;

      if (!session?.user?.id) {
        throw new UnauthorizedError("UNAUTHENTICATED", "请先登录");
      }

      const userId = session.user.id;
      const updateData: Record<string, unknown> = {};

      if (input.name !== undefined) {
        updateData.name = input.name;
      }
      if (input.image !== undefined) {
        updateData.image = input.image;
      }

      if (Object.keys(updateData).length === 0) return;

      // 2. 更新 Better Auth user 表
      try {
        await db.updateOne({
          model: "user",
          where: [{ field: "id", value: userId }],
          update: updateData,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`更新用户资料失败: ${message}`);
      }

      // 3. 如果 name 变更，同步更新 BusinessAccount.displayName
      if (input.name !== undefined) {
        try {
          await db.updateOne({
            model: "businessAccount",
            where: [{ field: "authUserId", value: userId }],
            update: { displayName: input.name },
          });
        } catch (err: unknown) {
          // businessAccount 可能不存在（例如未通过 databaseHooks 自动创建），
          // 此为非关键错误，忽略
          console.warn(
            `[updateProfile] 同步 businessAccount.displayName 失败 (userId=${userId}):`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    },

    /**
     * 注销账号。
     * 验证密码后级联删除用户及其所有关联数据
     * （session / businessAccount / socialAccount 通过外键 CASCADE 自动清理）。
     */
    async deleteAccount(
      ctx: RequestContext,
      password: string
    ): Promise<void> {
      // 1. 获取当前 session
      const session = await auth.api.getSession({
        headers: ctx.asHeaders ? ctx.asHeaders() : {},
      }) as unknown as BetterAuthSession | null;

      if (!session?.user?.id) {
        throw new InvalidPasswordError("未登录，无法注销账号");
      }

      const userId = session.user.id;

      // 2. 获取用户邮箱以验证密码
      const userRecord = await db.findOne({
        model: "user",
        where: [{ field: "id", value: userId }],
      }) as DbRecord | null;

      if (!userRecord) {
        throw new InvalidPasswordError("用户不存在");
      }

      const email = userRecord.email as string;

      // 3. 通过 Better Auth 验证密码（尝试 signIn）
      try {
        // 尝试登录来验证密码
        const signInResult = await auth.api.signInEmail({
          body: { email, password },
        }) as unknown as SignInEmailResult | { error: string };

        if ("error" in signInResult) {
          throw new InvalidPasswordError("密码错误");
        }
      } catch (err) {
        if (err instanceof InvalidPasswordError) throw err;
        throw new InvalidPasswordError("密码验证失败");
      }

      // 4. 删除用户（级联删除由数据库外键保证）
      await db.deleteOne({
        model: "user",
        where: [{ field: "id", value: userId }],
      });
    },
  };
}
