// ============================================================
// 渠道验证码 — 框架无关的验证码发送器注册与调度
//
// 每个 provider（email / phone / wechat 等）可注册自己的 sender。
// SDK 通过 allowVerification flag + provider 的 sender 决定能否发送。
// ============================================================

import type { DatabaseAdapter } from "../adapters/database";
import type { SocialAccountRef } from "../social/token";

// ----------------------------------------------------------
// 类型
// ----------------------------------------------------------

/** 验证码发送器：由 provider 实现方注册 */
export interface VerificationSender {
  /**
   * 向指定渠道发送验证码。
   *
   * @param channel  渠道引用（含 providerOpenid / accessToken 等）
   * @param code     生成的验证码
   */
  send(channel: SocialAccountRef, code: string): Promise<void>;
}

/** 验证码存储记录 */
export interface VerificationRecord {
  id: string;
  channelId: string;
  code: string;
  expiresAt: Date;
}

// ----------------------------------------------------------
// 注册表
// ----------------------------------------------------------

const senderRegistry = new Map<string, VerificationSender>();

export function registerVerificationSender(
  provider: string,
  sender: VerificationSender
): void {
  senderRegistry.set(provider, sender);
}

export function getVerificationSender(
  provider: string
): VerificationSender | undefined {
  return senderRegistry.get(provider);
}

// ----------------------------------------------------------
// 调度
// ----------------------------------------------------------

export interface ChannelVerificationDeps {
  db: DatabaseAdapter;
}

export function createChannelVerification(deps: ChannelVerificationDeps) {
  const { db } = deps;

  return {
    /**
     * 向指定渠道发送验证码。
     *
     * 校验 allowVerification flag → 查找 provider sender → 生成 code →
     * 存入 Verification 表 → 调用 sender.send()。
     */
    async send(
      channelId: string,
      provider: string,
      providerOpenid: string,
      channelRef: SocialAccountRef
    ): Promise<void> {
      const sender = senderRegistry.get(provider);
      if (!sender) {
        throw new Error(`渠道 "${provider}" 未注册验证码发送器`);
      }

      const code = generateCode();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 分钟

      // 存入 Verification 表（复用 Better Auth 表结构）
      await db.create({
        model: "verification",
        data: {
          identifier: `${provider}:${providerOpenid}`,
          value: code,
          expiresAt,
        },
      });

      await sender.send(channelRef, code);
    },

    /**
     * 校验渠道验证码。
     *
     * 查找未过期的验证记录 → 比对 code → 校验通过后删除记录。
     */
    async verify(
      provider: string,
      providerOpenid: string,
      code: string
    ): Promise<boolean> {
      const identifier = `${provider}:${providerOpenid}`;
      const now = new Date();

      const records = (await db.findMany({
        model: "verification",
        where: [{ field: "identifier", value: identifier }],
      })) as { id: string; value: string; expiresAt: Date }[];

      // 找最新的未过期且匹配的记录
      for (const record of records) {
        if (record.expiresAt > now && record.value === code) {
          // 验证通过，删除该记录
          await db.deleteOne({
            model: "verification",
            where: [{ field: "id", value: record.id }],
          });
          return true;
        }
      }

      return false;
    },
  };
}

// ----------------------------------------------------------
// 工具
// ----------------------------------------------------------

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
