// omni-auth/oauth — 外部 OAuth 登录：provider 工厂 + 处理器（高级能力子入口）
// ============================================================
// 说明：source 放在 entries/ 下，构建产物以 tsup key "oauth" 输出，
// 避免与内部 src/oauth/ 目录同名造成相对导入遮蔽。
// 内部 auth.registerOAuthProvider / auth.handleOAuthCallback 仍经 root 类型消费。

export { createOAuthHandler } from "../oauth/handler";
export type {
  OAuthHandler,
  OAuthInitiateResult,
  OAuthCallbackOptions,
} from "../oauth/handler";
export type { OAuthProviderConfig, OAuthCallbackResult } from "../oauth/types";

// 内置 Provider 工厂
export { createGoogleProvider } from "../oauth/providers/google";
export type { GoogleProviderConfig } from "../oauth/providers/google";
export { createGitHubProvider } from "../oauth/providers/github";
export type { GitHubProviderConfig } from "../oauth/providers/github";
export { createWechatProvider } from "../oauth/providers/wechat";
export type { WechatProviderConfig } from "../oauth/providers/wechat";
