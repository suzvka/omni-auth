// ============================================================
// 合成邮箱映射工具
//
// Better Auth 以 email 为核心凭证，手机号用户通过合成邮箱
// 接入。合成邮箱格式: phone+{phone}@{domain}
//
// 对外 API 通过 SocialAccount 暴露真实联系方式，
// 合成邮箱对开发者完全透明。
// ============================================================

import { randomBytes } from "crypto";

/** 合成邮箱域名（不对外暴露） */
export const SYNTHETIC_EMAIL_DOMAIN = "@phone.changfeng.internal";

/** 合成邮箱前缀 */
const SYNTHETIC_PREFIX = "phone+";

// ----------------------------------------------------------
// 转换函数
// ----------------------------------------------------------

/** 手机号 → 合成邮箱 */
export function phoneToSyntheticEmail(phone: string): string {
  return `${SYNTHETIC_PREFIX}${phone}${SYNTHETIC_EMAIL_DOMAIN}`;
}

/** 判断是否为合成邮箱 */
export function isSyntheticEmail(email: string): boolean {
  return email.endsWith(SYNTHETIC_EMAIL_DOMAIN);
}

/** 合成邮箱 → 手机号 */
export function syntheticEmailToPhone(email: string): string {
  return email.replace(SYNTHETIC_PREFIX, "").replace(SYNTHETIC_EMAIL_DOMAIN, "");
}

// ----------------------------------------------------------
// 密码工具
// ----------------------------------------------------------

/** 为手机号用户生成随机密码（Better Auth email/password 模式下必须提供密码） */
export function generateRandomPassword(): string {
  return randomBytes(32).toString("hex");
}

// ----------------------------------------------------------
// 社交账户通道类型
// ----------------------------------------------------------

/** 通道类型（复用 SocialAccount.provider 字段） */
export type ChannelProvider = "email" | "phone";

/** 判断是否为通信通道（非社交 OAuth provider） */
export function isChannelProvider(provider: string): provider is ChannelProvider {
  return provider === "email" || provider === "phone";
}
