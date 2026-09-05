// ============================================================
// OAuth 2.0 Server — 认证域私有（宿主请使用 auth.oauth.* 语义 API）
//
// 迁移自宿主 user_center 的 lib/oauth/*（client/code/token/scope/pkce/errors），
// 表操作全部收敛到注入的 DatabaseAdapter；access token 的签发/校验
// 委托 Token Authority Service（经 TokenAuthorityClient 注入，宿主提供实现）。
// ============================================================

import { randomUUID } from "node:crypto";
import type { DatabaseAdapter } from "../adapters/database";

// ----------------------------------------------------------
// 行类型（宽松形状；与 schema 物理列一致，供内部读取映射）
// ----------------------------------------------------------

export interface OAuthTokenRow {
  token: string;
  type: "authorization_code" | "refresh_token";
  client_id: string;
  user_id: string;
  code_challenge: string | null;
  redirect_uri: string | null;
  scope: string | null;
  status: "active" | "revoked";
  expires_at: Date;
  created_at: Date;
}

export interface OAuthClientRow {
  id: string;
  client_id: string;
  client_secret: string | null;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string[] | string;
  is_confidential: boolean;
  status: string;
  description: string;
  expires_at: string | null;
  revoked_at: string | null;
  issued_by: string;
  auto_renew: boolean;
  auto_renew_days: number | null;
  renewal_count: number;
  last_renewed_at: string | null;
  created_at: Date;
}

// ----------------------------------------------------------
// Token Authority Client（宿主注入）
// ----------------------------------------------------------

/** 令牌权威服务客户端契约（宿主实现；如 user_center 的 token-authority/client） */
export interface TokenAuthorityClient {
  issueCertificate(params: {
    userId: string;
    productId?: string;
    scope?: string[];
    claims?: Record<string, unknown>;
    ttl?: number;
  }): Promise<{
    certificate: string;
    token: string;
    expiresAt: string;
    userId: string;
    productId: string;
    scope?: string[];
  }>;
  introspectCertificate(
    certificate: string,
    scope?: string[]
  ): Promise<{
    active: boolean;
    userId?: string;
    productId?: string;
    scope?: string[];
    claims?: Record<string, unknown>;
    expiresAt?: string;
  }>;
  refreshCertificate(params: {
    certificate: string;
    ttl?: number;
  }): Promise<{ success: boolean; token: string; expiresAt: string }>;
  revokeCertificate(params: {
    certificate?: string;
    userId?: string;
    productId: string;
  }): Promise<{ success: boolean }>;
  getDefaultProductId(): string;
}

// ----------------------------------------------------------
// OAuth 2.0 错误（RFC 6749 §5.2）
// ----------------------------------------------------------

export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly errorDescription: string,
    public readonly statusCode: number = 400
  ) {
    super(errorDescription);
    this.name = "OAuthError";
  }

  toJSON() {
    return {
      error: this.error,
      error_description: this.errorDescription,
    };
  }
}

export function invalidGrant(detail = "Authorization code not found") {
  return new OAuthError("invalid_grant", detail);
}

export function invalidClient(detail = "Client authentication failed") {
  return new OAuthError("invalid_client", detail, 400);
}

export function invalidRequest(detail: string) {
  return new OAuthError("invalid_request", detail);
}

export function unsupportedGrantType(detail = "The authorization grant type is not supported") {
  return new OAuthError("unsupported_grant_type", detail);
}

export function invalidScope(detail = "The requested scope is invalid") {
  return new OAuthError("invalid_scope", detail);
}

// ----------------------------------------------------------
// Scope 协商
// ----------------------------------------------------------

export const SUPPORTED_SCOPES = ["openid", "profile", "email", "scim"] as const;
export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<SupportedScope, string> = {
  openid: "验证你的身份标识（OpenID Connect）",
  profile: "查看你的基本信息（头像、昵称）",
  email: "查看你的邮箱地址",
  scim: "通过 SCIM 协议管理用户目录",
};

export const DEFAULT_SCOPE = "openid profile";

export function parseScope(scope: string | null | undefined): string[] {
  if (!scope) return [];
  const parts = scope.trim().split(/\s+/).filter(Boolean);
  return Array.from(new Set(parts));
}

export function negotiateScope(
  requested: string | null | undefined
): { scopeString: string; scopes: string[] } {
  const parsed = parseScope(requested);
  const supported = parsed.filter((s): s is SupportedScope =>
    (SUPPORTED_SCOPES as readonly string[]).includes(s)
  );

  const scopes = supported.length > 0 ? supported : parseScope(DEFAULT_SCOPE);
  return { scopeString: scopes.join(" "), scopes };
}

export function hasScope(scopes: string[] | undefined, scope: SupportedScope): boolean {
  return Array.isArray(scopes) && scopes.includes(scope);
}

// ----------------------------------------------------------
// PKCE（RFC 7636，仅 S256）
// ----------------------------------------------------------

import crypto from "node:crypto";

export function verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
  const hash = sha256Base64Url(codeVerifier);
  return hash === codeChallenge;
}

export function generateCodeChallenge(codeVerifier: string): string {
  return sha256Base64Url(codeVerifier);
}

function sha256Base64Url(input: string): string {
  const hash = crypto.createHash("sha256").update(input).digest();
  return hash
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ----------------------------------------------------------
// OAuth Server 服务
// ----------------------------------------------------------

export interface TokenIssueResult {
  token: string;
  expiresAt: string;
}

export interface TokenIntrospectResult {
  userId: string;
  productId: string;
  scope: string[];
  claims: Record<string, unknown>;
  expiresAt: string;
}

export interface OAuthClientListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
}

export interface OAuthServerService {
  // ---- Client 校验与缓存 ----
  getClientById(clientId: string): Promise<OAuthClientRow | null>;
  getOAuthClientByRecordId(id: string): Promise<OAuthClientRow | null>;
  clearClientCache(clientId?: string): void;
  validateRedirectUri(client: OAuthClientRow, redirectUri: string): boolean;
  validateClientSecret(client: OAuthClientRow, secret: string): boolean;

  // ---- 管理面 ----
  createOAuthClient(params: {
    clientName: string;
    description?: string;
    productId?: string;
    expiresInDays?: number;
    autoRenew?: boolean;
    autoRenewDays?: number;
    clientUri?: string;
    redirectUris?: string[];
    isConfidential?: boolean;
    issuedBy?: string;
  }): Promise<OAuthClientRow>;
  listOAuthClients(params: OAuthClientListParams): Promise<{
    clients: Omit<OAuthClientRow, "client_secret">[];
    total: number;
    page: number;
    pageSize: number;
  }>;
  updateOAuthClient(
    id: string,
    patch: {
      client_name?: string;
      description?: string;
      client_uri?: string;
      redirect_uris?: string[];
      auto_renew?: boolean;
      auto_renew_days?: number;
    }
  ): Promise<void>;
  revokeOAuthClient(id: string): Promise<void>;
  renewOAuthClient(id: string, expiresInDays?: number): Promise<{ expiresAt: string }>;

  // ---- 授权码 ----
  createCode(params: {
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
  }): Promise<string>;
  consumeCode(params: {
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
  }): Promise<string>;

  // ---- Refresh Token（本地管理） ----
  issueRefreshToken(clientId: string, userId: string): Promise<string>;
  consumeRefreshToken(token: string): Promise<{ userId: string; clientId: string }>;
  revokeRefreshToken(token: string): Promise<void>;

  // ---- Access Token（Token Authority 委托） ----
  issueUserAccessToken(
    userId: string,
    scope?: string[],
    claims?: Record<string, unknown>
  ): Promise<TokenIssueResult>;
  verifyUserAccessToken(token: string): Promise<TokenIntrospectResult | null>;
  issueClientAccessToken(clientId: string, productId?: string): Promise<TokenIssueResult>;
  verifyClientAccessToken(token: string): Promise<TokenIntrospectResult | null>;
  revokeAccessToken(token: string): Promise<void>;
  refreshAccessToken(token: string): Promise<TokenIssueResult>;
  getExpiresIn(expiresAt: string): number;

  // ---- 清理（定时任务） ----
  cleanupExpiredTokens(): Promise<void>;
}

/** 授权码 TTL（5 分钟，与历史行为一致） */
const CODE_TTL_MS = 5 * 60 * 1000;
/** Refresh Token TTL（30 天，与历史行为一致） */
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseJsonArray(val: unknown): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val ? [val] : [];
    }
  }
  return [];
}

/** 生成随机授权码（12 位字母数字，避免易混淆字符） */
function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  const array = new Uint8Array(12);
  crypto.getRandomValues(array);
  for (let i = 0; i < 12; i++) {
    code += chars[array[i] % chars.length];
  }
  return code;
}

export function createOAuthServer(
  db: DatabaseAdapter,
  tokenAuthority: TokenAuthorityClient
): OAuthServerService {
  // ---- client 缓存（globalThis 惰性，构建时跳过） ----
  const globalForClients = globalThis as unknown as {
    __omniOAuthClientCache?: Map<string, OAuthClientRow>;
  };

  function getCache(): Map<string, OAuthClientRow> {
    if (!globalForClients.__omniOAuthClientCache) {
      globalForClients.__omniOAuthClientCache = new Map();
    }
    return globalForClients.__omniOAuthClientCache;
  }

  function rowToClient(row: Record<string, unknown>): OAuthClientRow {
    return {
      id: String(row.id),
      client_id: String(row.client_id),
      client_secret: row.client_secret ? String(row.client_secret) : null,
      client_name: String(row.client_name),
      client_uri: row.client_uri ? String(row.client_uri) : null,
      redirect_uris: row.redirect_uris as string[] | string,
      is_confidential: Boolean(row.is_confidential),
      status: String(row.status),
      description: String(row.description),
      expires_at: row.expires_at ? String(row.expires_at) : null,
      revoked_at: row.revoked_at ? String(row.revoked_at) : null,
      issued_by: String(row.issued_by),
      auto_renew: Boolean(row.auto_renew),
      auto_renew_days: row.auto_renew_days != null ? Number(row.auto_renew_days) : null,
      renewal_count: Number(row.renewal_count ?? 0),
      last_renewed_at: row.last_renewed_at ? String(row.last_renewed_at) : null,
      created_at: new Date(String(row.created_at)),
    };
  }

  function stripSecret(client: OAuthClientRow): Omit<OAuthClientRow, "client_secret"> {
    const { client_secret: _secret, ...rest } = client;
    return rest;
  }

  return {
    // ---- Client 校验与缓存 ----

    async getClientById(clientId) {
      const cache = getCache();
      const cached = cache.get(clientId);
      if (cached) return cached;

      const row = await db.findOne({
        model: "oauthClient",
        where: [{ field: "client_id", value: clientId }],
      });
      if (!row) return null;
      const client = rowToClient(row as Record<string, unknown>);
      cache.set(clientId, client);
      return client;
    },

    async getOAuthClientByRecordId(id) {
      const row = await db.findOne({
        model: "oauthClient",
        where: [{ field: "id", value: id }],
      });
      return row ? rowToClient(row as Record<string, unknown>) : null;
    },

    clearClientCache(clientId) {
      const cache = getCache();
      if (clientId) {
        cache.delete(clientId);
      } else {
        cache.clear();
      }
    },

    validateRedirectUri(client, redirectUri) {
      const uris = parseJsonArray(client.redirect_uris);
      return uris.some((uri) => {
        if (uri === redirectUri) return true;
        // 允许端口号不同（localhost 开发场景）
        if (uri.startsWith("http://localhost:") && redirectUri.startsWith("http://localhost:")) {
          const uriPath = uri.split("/", 4)[3] ?? "";
          const redirectPath = redirectUri.split("/", 4)[3] ?? "";
          return uriPath === redirectPath;
        }
        return false;
      });
    },

    validateClientSecret(client, secret) {
      if (!client.is_confidential) return true; // 公开客户端不需要 secret
      return client.client_secret === secret;
    },

    // ---- 管理面 ----

    async createOAuthClient(params) {
      const clientId = `sk-client-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const productId = params.productId ?? tokenAuthority.getDefaultProductId();
      const ttl = (params.expiresInDays ?? 365) * 86400;

      // 通过 Token Authority Service 签发票证
      const certResult = await tokenAuthority.issueCertificate({
        userId: clientId,
        productId,
        scope: ["*"],
        claims: { type: "oauth_client", client_name: params.clientName },
        ttl,
      });

      const row = await db.create({
        model: "oauthClient",
        data: {
          // id 由应用层生成（与 user/socialAccount 插入一致）：autoSync 建表的
          // oauthClient.id 无 DB DEFAULT（text PK，非序列），插入必须显式提供。
          id: randomUUID(),
          client_id: clientId,
          client_secret: certResult.certificate,
          client_name: params.clientName,
          client_uri: params.clientUri || null,
          // jsonb 列需显式 JSON 序列化：pg 驱动会把 JS 数组参数序列化为
          // PG 数组文本（{...}），jsonb 解析失败或存成对象（空数组时）
          redirect_uris: JSON.stringify(params.redirectUris ?? []),
          is_confidential: params.isConfidential ?? true,
          status: "active",
          description: params.description ?? "",
          expires_at: certResult.expiresAt,
          issued_by: params.issuedBy ?? "admin",
          auto_renew: params.autoRenew ?? false,
          auto_renew_days: params.autoRenewDays ?? 30,
          renewal_count: 0,
          created_at: new Date(),
        },
      });

      return rowToClient(row as Record<string, unknown>);
    },

    async listOAuthClients(params) {
      const page = Math.max(1, params.page ?? 1);
      const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
      const offset = (page - 1) * pageSize;

      const where: Array<{ field: string; operator?: string; value: unknown }> = [];
      if (params.search) {
        where.push({ field: "client_name", operator: "search", value: params.search });
      }
      if (params.status) {
        where.push({ field: "status", value: params.status });
      }

      // 搜索跨三列（client_name / client_id / description），逐条 OR 并集后取交集
      const total = await countMatchingClients(db, params);
      const rows = await findMatchingClients(db, params, pageSize, offset);

      return {
        clients: rows.map((r) => stripSecret(rowToClient(r))),
        total,
        page,
        pageSize,
      };
    },

    async updateOAuthClient(id, patch) {
      if (patch.auto_renew_days !== undefined) {
        const days = Number(patch.auto_renew_days);
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          throw new OAuthError("invalid_request", "自动续期天数需在 1~365 之间");
        }
      }

      const update: Record<string, unknown> = {};
      if (patch.client_name !== undefined) update.client_name = patch.client_name;
      if (patch.description !== undefined) update.description = patch.description;
      if (patch.client_uri !== undefined) update.client_uri = patch.client_uri || null;
      if (patch.redirect_uris !== undefined) {
        // 与 createOAuthClient 一致：jsonb 列需显式 JSON 序列化
        update.redirect_uris = JSON.stringify(patch.redirect_uris);
      }
      if (patch.auto_renew !== undefined) update.auto_renew = Boolean(patch.auto_renew);
      if (patch.auto_renew_days !== undefined) update.auto_renew_days = patch.auto_renew_days;

      if (Object.keys(update).length === 0) {
        throw new OAuthError("invalid_request", "没有需要更新的字段");
      }

      await db.updateOne({
        model: "oauthClient",
        where: [{ field: "id", value: id }],
        update,
      });

      // 更新后失效缓存（client_id 可能未变，稳妥起见全量失效）
      this.clearClientCache();
    },

    async revokeOAuthClient(id) {
      const client = await this.getOAuthClientByRecordId(id);
      if (!client) {
        throw new OAuthError("invalid_client", "凭证不存在", 404);
      }
      if (client.status === "revoked") {
        throw new OAuthError("invalid_client", "凭证已吊销", 400);
      }

      // 远端吊销失败则阻断本地操作，保证状态一致
      await tokenAuthority.revokeCertificate({
        userId: client.client_id,
        productId: tokenAuthority.getDefaultProductId(),
      });

      await db.updateOne({
        model: "oauthClient",
        where: [{ field: "id", value: id }],
        update: { status: "revoked", revoked_at: new Date() },
      });

      this.clearClientCache(client.client_id);
    },

    async renewOAuthClient(id, expiresInDays) {
      const client = await this.getOAuthClientByRecordId(id);
      if (!client) {
        throw new OAuthError("invalid_client", "凭证不存在", 404);
      }
      if (client.status !== "active") {
        throw new OAuthError("invalid_client", "仅活跃状态的凭证可续期", 400);
      }

      const ttl = (expiresInDays ?? 365) * 86400;

      // 远端续期失败则阻断本地操作
      const refreshResult = await tokenAuthority.refreshCertificate({
        certificate: client.client_secret ?? "",
        ttl,
      });

      await db.updateOne({
        model: "oauthClient",
        where: [{ field: "id", value: id }],
        update: {
          expires_at: refreshResult.expiresAt,
          renewal_count: client.renewal_count + 1,
          last_renewed_at: new Date(),
        },
      });

      this.clearClientCache(client.client_id);
      return { expiresAt: refreshResult.expiresAt };
    },

    // ---- 授权码 ----

    async createCode(params) {
      const code = generateCode();
      const expiresAt = new Date(Date.now() + CODE_TTL_MS);
      await db.create({
        model: "oauthToken",
        data: {
          token: code,
          type: "authorization_code",
          client_id: params.clientId,
          user_id: params.userId,
          code_challenge: params.codeChallenge,
          redirect_uri: params.redirectUri,
          status: "active",
          expires_at: expiresAt,
          created_at: new Date(),
        },
      });
      return code;
    },

    async consumeCode(params) {
      const row = await db.findOne({
        model: "oauthToken",
        where: [
          { field: "token", value: params.code },
          { field: "type", value: "authorization_code" },
        ],
      });
      const record = row as OAuthTokenRow | null;

      if (!record) {
        throw invalidGrant();
      }

      // TTL 检查：过期则删除并返回相同错误（客户端无法区分过期与已消费）
      if (new Date(record.expires_at).getTime() < Date.now()) {
        await db.deleteOne({
          model: "oauthToken",
          where: [
            { field: "token", value: params.code },
            { field: "type", value: "authorization_code" },
          ],
        });
        throw invalidGrant();
      }

      // PKCE 校验
      if (!verifyPKCE(params.codeVerifier, record.code_challenge ?? "")) {
        throw invalidGrant("Code verifier mismatch");
      }

      // client_id 校验
      if (record.client_id !== params.clientId) {
        throw invalidGrant("Client ID mismatch");
      }

      // redirect_uri 校验
      if (record.redirect_uri !== params.redirectUri) {
        throw invalidGrant("Redirect URI mismatch");
      }

      // 消费即删除
      await db.deleteOne({
        model: "oauthToken",
        where: [
          { field: "token", value: params.code },
          { field: "type", value: "authorization_code" },
        ],
      });

      return record.user_id;
    },

    // ---- Refresh Token ----

    async issueRefreshToken(clientId, userId) {
      const token = randomUUID();
      const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
      await db.create({
        model: "oauthToken",
        data: {
          token,
          type: "refresh_token",
          client_id: clientId,
          user_id: userId,
          code_challenge: null,
          redirect_uri: null,
          scope: null,
          status: "active",
          expires_at: expiresAt,
          created_at: new Date(),
        },
      });
      return token;
    },

    async consumeRefreshToken(token) {
      const row = await db.findOne({
        model: "oauthToken",
        where: [
          { field: "token", value: token },
          { field: "type", value: "refresh_token" },
          { field: "status", value: "active" },
        ],
      });
      const record = row as OAuthTokenRow | null;

      if (!record) {
        throw invalidGrant("Refresh token not found or expired");
      }

      // 过期检查
      if (new Date(record.expires_at).getTime() < Date.now()) {
        throw invalidGrant("Refresh token not found or expired");
      }

      // 一次性：消费后置为 revoked
      await db.updateOne({
        model: "oauthToken",
        where: [
          { field: "token", value: token },
          { field: "type", value: "refresh_token" },
        ],
        update: { status: "revoked" },
      });

      return { userId: record.user_id, clientId: record.client_id };
    },

    async revokeRefreshToken(token) {
      await db.updateMany({
        model: "oauthToken",
        where: [
          { field: "token", value: token },
          { field: "type", value: "refresh_token" },
        ],
        update: { status: "revoked" },
      });
    },

    // ---- Access Token（Token Authority 委托） ----

    async issueUserAccessToken(userId, scope, claims) {
      const productId = tokenAuthority.getDefaultProductId();
      const result = await tokenAuthority.issueCertificate({
        userId,
        productId,
        scope: scope ?? ["openid", "profile"],
        claims: { ...claims, source: "oauth" },
        ttl: 86400,
      });
      return { token: result.token, expiresAt: result.expiresAt };
    },

    async verifyUserAccessToken(token) {
      try {
        const result = await tokenAuthority.introspectCertificate(token, ["openid", "profile"]);
        if (!result.active) return null;
        return {
          userId: result.userId!,
          productId: result.productId!,
          scope: result.scope ?? [],
          claims: (result.claims as Record<string, unknown>) ?? {},
          expiresAt: result.expiresAt!,
        };
      } catch {
        return null;
      }
    },

    async issueClientAccessToken(clientId, productId) {
      const pid = productId ?? tokenAuthority.getDefaultProductId();
      const result = await tokenAuthority.issueCertificate({
        userId: clientId,
        productId: pid,
        scope: ["scim"],
        claims: { type: "client_credentials" },
        ttl: 3600,
      });
      return { token: result.token, expiresAt: result.expiresAt };
    },

    async verifyClientAccessToken(token) {
      try {
        const result = await tokenAuthority.introspectCertificate(token, ["scim"]);
        if (!result.active) return null;
        return {
          userId: result.userId!,
          productId: result.productId!,
          scope: result.scope ?? [],
          claims: (result.claims as Record<string, unknown>) ?? {},
          expiresAt: result.expiresAt!,
        };
      } catch {
        return null;
      }
    },

    async revokeAccessToken(token) {
      await tokenAuthority.revokeCertificate({
        certificate: token,
        productId: tokenAuthority.getDefaultProductId(),
      });
    },

    async refreshAccessToken(token) {
      const result = await tokenAuthority.refreshCertificate({ certificate: token, ttl: 86400 });
      return { token, expiresAt: result.expiresAt };
    },

    getExpiresIn(expiresAt) {
      return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
    },

    // ---- 清理 ----

    async cleanupExpiredTokens() {
      const now = new Date();
      // 过期授权码（消费即删，防漏网）
      await db.deleteMany({
        model: "oauthToken",
        where: [
          { field: "type", value: "authorization_code" },
          { field: "expires_at", operator: "lt", value: now },
        ],
      });
      // 过期 refresh_token（含已吊销，TTL 到期统一清理）
      await db.deleteMany({
        model: "oauthToken",
        where: [
          { field: "type", value: "refresh_token" },
          { field: "expires_at", operator: "lt", value: now },
        ],
      });
    },
  };
}

// ----------------------------------------------------------
// Client 列表搜索（跨列 LIKE：client_name / client_id / description）
// ----------------------------------------------------------

async function countMatchingClients(
  db: DatabaseAdapter,
  params: OAuthClientListParams
): Promise<number> {
  const rows = await findMatchingClientRows(db, params);
  return rows.length;
}

async function findMatchingClients(
  db: DatabaseAdapter,
  params: OAuthClientListParams,
  limit: number,
  offset: number
): Promise<Array<Record<string, unknown>>> {
  let rows = await findMatchingClientRows(db, params);
  rows = rows.slice(offset, offset + limit);
  return rows;
}

/** 用三条 OR 查询的并集模拟跨列 ILIKE（适配器无 OR 语义时的兜底） */
async function findMatchingClientRows(
  db: DatabaseAdapter,
  params: OAuthClientListParams
): Promise<Array<Record<string, unknown>>> {
  const conditions: Array<{ field: string; operator?: string; value: unknown }> = [];
  if (params.search) {
    conditions.push({ field: "client_name", operator: "search", value: params.search });
  }
  if (params.status) {
    conditions.push({ field: "status", value: params.status });
  }

  // 无搜索条件：直接全量（status 条件仍走 where）
  if (!params.search) {
    const where = params.status
      ? [{ field: "status" as const, value: params.status }]
      : undefined;
    return (await db.findMany({
      model: "oauthClient",
      where,
      orderBy: { field: "created_at", direction: "desc" },
      limit: 10000,
    })) as Array<Record<string, unknown>>;
  }

  // 有搜索：三列分别 search 取并集，再与 status 过滤取交集
  const nameHits = (await db.findMany({
    model: "oauthClient",
    search: { fields: ["client_name"], value: params.search },
    limit: 10000,
  })) as Array<Record<string, unknown>>;
  const idHits = (await db.findMany({
    model: "oauthClient",
    search: { fields: ["client_id"], value: params.search },
    limit: 10000,
  })) as Array<Record<string, unknown>>;
  const descHits = (await db.findMany({
    model: "oauthClient",
    search: { fields: ["description"], value: params.search },
    limit: 10000,
  })) as Array<Record<string, unknown>>;

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...nameHits, ...idHits, ...descHits]) {
    byId.set(String(row.id), row);
  }

  let merged = Array.from(byId.values());
  if (params.status) {
    merged = merged.filter((r) => String(r.status) === params.status);
  }
  merged.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return merged;
}
