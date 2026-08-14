// ============================================================
// 占位邮箱工具
//
// user 表以 email 为唯一锚点（NOT NULL UNIQUE 约束）。
// 渠道模型下，手机 / OAuth 等非邮箱渠道统一使用占位邮箱接入:
//   {provider}_{openid}@oauth.usercenter（完整 openid，不截断）
// 邮箱渠道的标识符即用户邮箱（见 auth.ts _buildChannelEmail）。
//
// 渠道是否为真实登记由 SocialAccount.valid 字段标识:
//   0 = 系统占位（OAuth 自动生成等），忽略邮箱验证
//   1 = 用户真实登记
// ============================================================

import { randomBytes } from "crypto";

/** 占位邮箱域名 */
export const PLACEHOLDER_EMAIL_DOMAIN = "oauth.usercenter";

/**
 * 为无邮箱渠道构建占位邮箱（单一实现，供 auth / OAuth handler 共用）。
 *
 * 使用完整 openid，不做截断——截断会导致不同 openid 生成相同
 * 占位邮箱，触发 user.email 唯一约束冲突。
 */
export function buildPlaceholderEmail(provider: string, openid: string): string {
  return `${provider}_${openid}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

// ----------------------------------------------------------
// 密码工具
// ----------------------------------------------------------

/**
 * 为无密码渠道用户生成随机密码。
 *
 * 使 credential account 始终持有密码哈希，后续可通过渠道验证码
 * 重置 / 设置密码（password reset 流程要求账户已有密码）。
 */
export function generateRandomPassword(): string {
  return randomBytes(32).toString("hex");
}
