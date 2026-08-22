import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOAuthServer, OAuthError, verifyPKCE, generateCodeChallenge } from "./server";
import type { OAuthClientRow } from "./server";
import type { DatabaseAdapter } from "../adapters/database";
import type { TokenAuthorityClient } from "./server";

// ------------------------------------------------------------
// OAuth server 模块单测（mock DatabaseAdapter + TokenAuthorityClient）
// ------------------------------------------------------------

function createMockTokenAuthority() {
  return {
    issueCertificate: vi.fn(async () => ({
      certificate: "cert-123",
      token: "cert-123",
      expiresAt: "2027-01-01T00:00:00Z",
      userId: "u-1",
      productId: "prod-1",
    })),
    introspectCertificate: vi.fn(async () => ({
      active: true,
      userId: "u-1",
      productId: "prod-1",
      scope: ["openid", "profile"],
      claims: { type: "user" },
      expiresAt: "2027-01-01T00:00:00Z",
    })),
    refreshCertificate: vi.fn(async () => ({
      success: true,
      token: "cert-renewed",
      expiresAt: "2028-01-01T00:00:00Z",
    })),
    revokeCertificate: vi.fn(async () => ({ success: true })),
    getDefaultProductId: vi.fn(() => "prod-default"),
  } as unknown as TokenAuthorityClient;
}

/** 一条完整的 oauth_client 行（rowToClient 输入形状） */
function clientRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rec-1",
    client_id: "sk-client-abc",
    client_secret: "cert-123",
    client_name: "Test App",
    client_uri: "https://app.example.com",
    redirect_uris: ["https://app.example.com/callback", "http://localhost:3000/callback"],
    is_confidential: true,
    status: "active",
    description: "test",
    expires_at: "2027-01-01T00:00:00Z",
    revoked_at: null,
    issued_by: "admin",
    auto_renew: false,
    auto_renew_days: 30,
    renewal_count: 0,
    last_renewed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** 可编程 mock 适配器 */
function createMockAdapter() {
  const db = {
    create: vi.fn(async (params: { model: string; data: Record<string, unknown> }) => {
      return clientRow({ client_id: "sk-client-created" });
    }),
    findOne: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    updateOne: vi.fn(async () => ({})),
    count: vi.fn(async () => 0),
    deleteOne: vi.fn(async () => null),
    deleteMany: vi.fn(async () => 0),
  } as unknown as DatabaseAdapter;
  return db;
}

describe("verifyPKCE / generateCodeChallenge", () => {
  it("generateCodeChallenge 生成 S256 挑战且 verifyPKCE 通过", () => {
    const verifier = "abc-verifier-123";
    const challenge = generateCodeChallenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyPKCE(verifier, challenge)).toBe(true);
  });

  it("verifyPKCE：错误 verifier 不通过", () => {
    const challenge = generateCodeChallenge("right-verifier");
    expect(verifyPKCE("wrong-verifier", challenge)).toBe(false);
  });
});

describe("createOAuthServer — Client 校验与缓存", () => {
  beforeEach(() => {
    // 清掉 globalThis 上的客户端缓存，避免用例间相互污染
    delete (globalThis as Record<string, unknown>).__omniOAuthClientCache;
    vi.restoreAllMocks();
  });

  it("getClientById：未命中缓存时查库并缓存（二次调用不查库）", async () => {
    const db = createMockAdapter();
    const server = createOAuthServer(db, createMockTokenAuthority());

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(clientRow());

    const first = await server.getClientById("sk-client-abc");
    const second = await server.getClientById("sk-client-abc");

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(db.findOne).toHaveBeenCalledTimes(1); // 缓存命中
  });

  it("getClientById：不同 client_id 分别查库", async () => {
    const db = createMockAdapter();
    const server = createOAuthServer(db, createMockTokenAuthority());

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(clientRow());

    await server.getClientById("client-a");
    await server.getClientById("client-b");

    expect(db.findOne).toHaveBeenCalledTimes(2);
  });

  it("validateRedirectUri：精确匹配与 localhost 端口容忍", () => {
    const server = createOAuthServer(createMockAdapter(), createMockTokenAuthority());
    const client = server.getClientById as never; // 仅用类型占位

    const c = clientRow() as unknown as OAuthClientRow;

    expect(server.validateRedirectUri(c, "https://app.example.com/callback")).toBe(true);
    // localhost 端口不同仍视为同一回调（开发场景）
    expect(server.validateRedirectUri(c, "http://localhost:5173/callback")).toBe(true);
    expect(server.validateRedirectUri(c, "https://evil.example.com/callback")).toBe(false);
  });

  it("validateClientSecret：公开客户端（非机密）无需 secret", () => {
    const server = createOAuthServer(createMockAdapter(), createMockTokenAuthority());
    const pub = clientRow({ is_confidential: false }) as unknown as OAuthClientRow;
    const conf = clientRow() as unknown as OAuthClientRow;

    expect(server.validateClientSecret(pub, "")).toBe(true);
    expect(server.validateClientSecret(conf, "cert-123")).toBe(true);
    expect(server.validateClientSecret(conf, "wrong")).toBe(false);
  });
});

describe("createOAuthServer — 管理面", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__omniOAuthClientCache;
    vi.restoreAllMocks();
  });

  it("createOAuthClient：经 Token Authority 签发票证并落库", async () => {
    const db = createMockAdapter();
    const ta = createMockTokenAuthority();
    const server = createOAuthServer(db, ta);

    (db.create as ReturnType<typeof vi.fn>).mockResolvedValue(clientRow());

    const client = await server.createOAuthClient({
      clientName: "New App",
      redirectUris: ["https://new.example.com/cb"],
      expiresInDays: 30,
    });

    expect(ta.getDefaultProductId).toHaveBeenCalled();
    expect(ta.issueCertificate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: expect.stringMatching(/^sk-client-/),
        productId: "prod-default",
        scope: ["*"],
        ttl: 30 * 86400,
      })
    );
    const createData = (db.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(createData.client_secret).toBe("cert-123");
    expect(createData.status).toBe("active");
    expect(client.client_id).toBeTruthy();

    // id 由应用层生成（autoSync 建表的 oauthClient.id 无 DB DEFAULT）
    expect(createData.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    // 记录主键与业务凭证（client_id）是两回事
    expect(createData.id).not.toBe(createData.client_id);

    // jsonb 列需显式 JSON 序列化（pg 驱动会把 JS 数组序列化为 PG 数组文本）
    expect(createData.redirect_uris).toBe('["https://new.example.com/cb"]');
  });

  it("revokeOAuthClient：远端吊销成功后才落本地状态", async () => {
    const db = createMockAdapter();
    const ta = createMockTokenAuthority();
    const server = createOAuthServer(db, ta);

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(clientRow());

    await server.revokeOAuthClient("rec-1");

    expect(ta.revokeCertificate).toHaveBeenCalled();
    const update = (db.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0].update;
    expect(update.status).toBe("revoked");
  });

  it("revokeOAuthClient：已吊销凭证抛错且不重复吊销", async () => {
    const db = createMockAdapter();
    const ta = createMockTokenAuthority();
    const server = createOAuthServer(db, ta);

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(
      clientRow({ status: "revoked" })
    );

    await expect(server.revokeOAuthClient("rec-1")).rejects.toThrow(OAuthError);
    expect(ta.revokeCertificate).not.toHaveBeenCalled();
  });

  it("renewOAuthClient：远端续期成功则更新本地过期时间与续期计数", async () => {
    const db = createMockAdapter();
    const server = createOAuthServer(db, createMockTokenAuthority());

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(clientRow());

    const result = await server.renewOAuthClient("rec-1", 90);

    expect(result.expiresAt).toBe("2028-01-01T00:00:00Z");
    const update = (db.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0].update;
    expect(update.renewal_count).toBe(1);
  });
});

describe("createOAuthServer — 授权码与 refresh token", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__omniOAuthClientCache;
    vi.restoreAllMocks();
  });

  it("createCode：写入 authorization_code 记录并返回随机码", async () => {
    const db = createMockAdapter();
    const server = createOAuthServer(db, createMockTokenAuthority());

    const code = await server.createCode({
      clientId: "client-a",
      userId: "u-1",
      redirectUri: "https://app.example.com/callback",
      codeChallenge: "challenge-1",
    });

    expect(code.length).toBe(12);
    const data = (db.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data.type).toBe("authorization_code");
    expect(data.client_id).toBe("client-a");
    expect(data.code_challenge).toBe("challenge-1");
  });

  it("consumeCode：PKCE 校验通过后消费即删（一次性）并返回 userId", async () => {
    const db = createMockAdapter();
    const server = createOAuthServer(db, createMockTokenAuthority());
    const verifier = "verifier-abc";
    const challenge = generateCodeChallenge(verifier);

    const code = await server.createCode({
      clientId: "client-a",
      userId: "u-1",
      redirectUri: "https://app.example.com/callback",
      codeChallenge: challenge,
    });

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      token: code,
      type: "authorization_code",
      client_id: "client-a",
      user_id: "u-1",
      redirect_uri: "https://app.example.com/callback",
      code_challenge: challenge,
      status: "active",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const userId = await server.consumeCode({
      code,
      codeVerifier: verifier,
      clientId: "client-a",
      redirectUri: "https://app.example.com/callback",
    });

    expect(userId).toBe("u-1");
    // 消费即删除（oauth_token 记录不残留）
    expect(db.deleteOne).toHaveBeenCalledWith(
      expect.objectContaining({ model: "oauthToken" })
    );
  });

  it("consumeCode：PKCE verifier 不匹配抛 invalid_grant 且不删除", async () => {
    const db = createMockAdapter();
    const server = createOAuthServer(db, createMockTokenAuthority());
    const challenge = generateCodeChallenge("right-verifier");

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      token: "code-x",
      type: "authorization_code",
      code_challenge: challenge,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(
      server.consumeCode({
        code: "code-x",
        codeVerifier: "wrong-verifier",
        clientId: "client-a",
        redirectUri: "https://app.example.com/callback",
      })
    ).rejects.toThrow(OAuthError);
    expect(db.deleteOne).not.toHaveBeenCalled();
  });

  it("consumeCode：授权码不存在/已消费抛 invalid_grant（不可区分）", async () => {
    const db = createMockAdapter();
    const server = createOAuthServer(db, createMockTokenAuthority());

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      server.consumeCode({
        code: "consumed-code",
        codeVerifier: "v",
        clientId: "client-a",
        redirectUri: "https://app.example.com/callback",
      })
    ).rejects.toThrow("Authorization code not found");
  });

  it("consumeRefreshToken：一次性（消费后置 revoked）并返回 userId/clientId", async () => {
    const db = createMockAdapter();
    const server = createOAuthServer(db, createMockTokenAuthority());

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      token: "rt-1",
      type: "refresh_token",
      client_id: "client-a",
      user_id: "u-1",
      status: "active",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const result = await server.consumeRefreshToken("rt-1");

    expect(result).toEqual({ userId: "u-1", clientId: "client-a" });
    const update = (db.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0].update;
    expect(update.status).toBe("revoked");
  });

  it("consumeRefreshToken：已消费（revoked）再消费抛 invalid_grant", async () => {
    const db = createMockAdapter();
    const server = createOAuthServer(db, createMockTokenAuthority());

    (db.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(server.consumeRefreshToken("used-rt")).rejects.toThrow(OAuthError);
  });
});

describe("createOAuthServer — Access Token 委托", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__omniOAuthClientCache;
    vi.restoreAllMocks();
  });

  it("verifyUserAccessToken：委托 Token Authority introspectCertificate", async () => {
    const db = createMockAdapter();
    const ta = createMockTokenAuthority();
    const server = createOAuthServer(db, ta);

    const result = await server.verifyUserAccessToken("jwt-token");

    // 用户令牌校验限定 openid+profile scope
    expect(ta.introspectCertificate).toHaveBeenCalledWith("jwt-token", ["openid", "profile"]);
    expect(result?.userId).toBe("u-1");
  });

  it("issueUserAccessToken：签发委托 issueCertificate", async () => {
    const db = createMockAdapter();
    const ta = createMockTokenAuthority();
    const server = createOAuthServer(db, ta);

    const result = await server.issueUserAccessToken("u-1", ["openid"], { foo: "bar" });

    expect(ta.issueCertificate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        scope: ["openid"],
        // claims 附加 source 标记（嵌套断言用 objectContaining）
        claims: expect.objectContaining({ foo: "bar" }),
      })
    );
    expect(result.token).toBe("cert-123");
  });

  it("refreshAccessToken：委托 refreshCertificate 续期（保持原 token，更新过期时间）", async () => {
    const db = createMockAdapter();
    const ta = createMockTokenAuthority();
    const server = createOAuthServer(db, ta);

    const result = await server.refreshAccessToken("old-token");

    expect(ta.refreshCertificate).toHaveBeenCalledWith(
      expect.objectContaining({ certificate: "old-token" })
    );
    // 续期语义：令牌不变，仅更新过期时间（refreshCertificate 返回的新 token 被忽略）
    expect(result.token).toBe("old-token");
    expect(result.expiresAt).toBe("2028-01-01T00:00:00Z");
  });
});
