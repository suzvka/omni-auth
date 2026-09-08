// omni-auth/oauth-server — 自建 OAuth 2.0 Authorization Server（高级能力子入口）
// ============================================================

export {
  OAuthError,
  invalidGrant,
  invalidClient,
  invalidRequest,
  unsupportedGrantType,
  invalidScope,
  SUPPORTED_SCOPES,
  DEFAULT_SCOPE,
  parseScope,
  negotiateScope,
  hasScope,
  verifyPKCE,
  generateCodeChallenge,
} from "../oauth/server";
export type {
  OAuthServerService,
  TokenAuthorityClient,
  TokenIssueResult,
  TokenIntrospectResult,
  OAuthClientListParams,
} from "../oauth/server";
