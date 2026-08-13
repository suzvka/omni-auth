// ============================================================
// OAuth 模块导出
// ============================================================

export type { OAuthProviderConfig, OAuthCallbackResult } from "./types";
export { registerOAuthProvider, getOAuthProvider } from "./registry";
export {
    handleOAuthCallback,
    createOAuthHandler,
    initiateOAuth,
    setOAuthHandler,
} from "./handler";
export type { OAuthHandler, OAuthInitiateResult } from "./handler";

// 内置 Provider 工厂
export { createGoogleProvider } from "./providers/google";
export type { GoogleProviderConfig } from "./providers/google";
export { createGitHubProvider } from "./providers/github";
export type { GitHubProviderConfig } from "./providers/github";
export { createWechatProvider } from "./providers/wechat";
export type { WechatProviderConfig } from "./providers/wechat";
