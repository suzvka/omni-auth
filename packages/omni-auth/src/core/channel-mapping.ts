// ============================================================
// 合成邮箱映射工具
//
// Better Auth 以 email 为核心凭证，非邮箱渠道用户通过合成邮箱
// 接入。合成邮箱格式:
//   手机:  phone+{phone}@{domain}
//   OAuth: {provider}_{openid前12位}@oauth.usercenter
//
// valid 字段（SocialAccount 表）标识渠道是否为真实登记:
//   0 = 系统占位（OAuth 自动生成等），忽略邮箱验证
//   1 = 用户真实登记
// ============================================================

import { randomBytes } from "crypto";

/** 合成邮箱域名（不对外暴露） */
export const SYNTHETIC_EMAIL_DOMAIN = "@phone.omni.internal";

/** 合成邮箱前缀 */
const SYNTHETIC_PREFIX = "phone+";

// ----------------------------------------------------------
// 转换函数
// ----------------------------------------------------------

/** 手机号 -> 合成邮箱 */
export function phoneToSyntheticEmail(phone: string): string {
  return `${SYNTHETIC_PREFIX}${phone}${SYNTHETIC_EMAIL_DOMAIN}`;
}

/** 判断是否为合成邮箱（基于域名模式匹配） */
export function isSyntheticEmail(email: string): boolean {
  return email.endsWith(SYNTHETIC_EMAIL_DOMAIN);
}

/** 合成邮箱 -> 手机号 */
export function syntheticEmailToPhone(email: string): string {
  return email.replace(SYNTHETIC_PREFIX, "").replace(SYNTHETIC_EMAIL_DOMAIN, "");
}

// ----------------------------------------------------------
// 密码工具
// ----------------------------------------------------------

/** 为手机号/OAuth 用户生成随机密码（Better Auth email/password 模式下必须提供密码） */
export function generateRandomPassword(): string {
  return randomBytes(32).toString("hex");
}

// ----------------------------------------------------------
// 已废弃 — 请使用 SocialAccount.valid 字段替代 provider 类型判断
// ----------------------------------------------------------

/**
 * @deprecated 使用 SocialAccount.valid 字段替代 provider 硬编码判断。
 *             不再需要区分 "email"/"phone" 与其他 provider。
 */
export type ChannelProvider = "email" | "phone";

/**
 * @deprecated 使用 SocialAccount.valid 字段替代 provider 硬编码判断。
 *             不再需要区分 "email"/"phone" 与其他 provider。
 */
export function isChannelProvider(provider: string): provider is ChannelProvider {
  return provider === "email" || provider === "phone";
}
