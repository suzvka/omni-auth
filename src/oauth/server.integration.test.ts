import { describe, it, expect, beforeEach } from "vitest";
import { newDb, type IMemoryDb } from "pg-mem";
import { syncSchema } from "../schema-sync";
import { PgAdapter, type PgPoolLike } from "../builtin/pg/adapter";
import { createOAuthServer, generateCodeChallenge, type TokenAuthorityClient } from "./server";

// ============================================================
// OAuth Server 与 autoSync 建表协同的集成冒烟（pg-mem 内存库）
//
// 回归场景（5.1.2 双缺陷）：
// 1. schema 建表名（oauth_token/oauth_client）与运行时 model 名
//    （oauthToken/oauthClient）不一致 → 全新库任何 OAuth 操作
//    报 relation "oauthToken" does not exist；
// 2. createOAuthClient 不传主键 id（autoSync 建出的 id 无 DB
//    DEFAULT）→ 签发凭证报 NOT NULL 违反。
// 若回归到任一种错误实现，本测试在真实约束下失败。
// ============================================================

function createMemPool(): { db: IMemoryDb; pool: PgPoolLike } {
  // noAstCoverageCheck: 容忍 CREATE TABLE IF NOT EXISTS 等未覆盖的 AST 分支
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as unknown as PgPoolLike;
  return { db, pool };
}

function createMockTokenAuthority(): TokenAuthorityClient {
  return {
    issueCertificate: async () => ({
      certificate: "cert-integration",
      token: "cert-integration",
      expiresAt: "2027-01-01T00:00:00Z",
      userId: "u-int",
      productId: "prod-default",
    }),
    introspectCertificate: async () => ({ active: true }),
    refreshCertificate: async () => ({
      success: true,
      token: "cert-renewed",
      expiresAt: "2028-01-01T00:00:00Z",
    }),
    revokeCertificate: async () => ({ success: true }),
    getDefaultProductId: () => "prod-default",
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("OAuth Server（autoSync 建表 + pg 适配器集成）", () => {
  beforeEach(() => {
    // 清掉 globalThis 上的客户端缓存，避免用例间相互污染
    delete (globalThis as Record<string, unknown>).__omniOAuthClientCache;
  });

  it("全新库：createOAuthClient 可成功落库（表名一致 + 主键生成），可回查命中", async () => {
    const { pool } = createMemPool();

    // 模拟 createQuickAuth({ autoSync: true })：空库执行幂等 DDL
    const result = await syncSchema(pool);
    expect(result.synced).toBe(true);

    const adapter = PgAdapter({ pool });
    const server = createOAuthServer(adapter, createMockTokenAuthority());

    // 签发客户端凭证（全新库真实写操作）
    const client = await server.createOAuthClient({
      clientName: "集成测试应用",
      redirectUris: ["https://app.example.com/cb"],
    });

    // 主键由应用层生成（autoSync 建出的 id 无 DB DEFAULT）
    expect(client.id).toMatch(UUID_RE);
    expect(client.client_id).toMatch(/^sk-client-/);
    expect(client.client_id).not.toBe(client.id);

    // 数据可经语义 API 回查（确认真实落库而非仅返回形状）
    const found = await server.getClientById(client.client_id);
    expect(found?.id).toBe(client.id);
    expect(found?.client_name).toBe("集成测试应用");
    // redirect_uris 经 jsonb 列往返后仍为 JS 数组
    expect(found?.redirect_uris).toEqual(["https://app.example.com/cb"]);
  });

  it("全新库：授权码 createCode → consumeCode 走通（oauthToken 表真实读写）", async () => {
    const { pool } = createMemPool();
    await syncSchema(pool);

    const server = createOAuthServer(PgAdapter({ pool }), createMockTokenAuthority());

    const verifier = "integration-verifier-42";
    const challenge = generateCodeChallenge(verifier);

    const code = await server.createCode({
      clientId: "client-a",
      userId: "user-1",
      codeChallenge: challenge,
      redirectUri: "https://app.example.com/cb",
    });
    expect(code).toBeTruthy();

    // 消费成功（PKCE / client_id / redirect_uri 全部匹配）
    const userId = await server.consumeCode({
      code,
      codeVerifier: verifier,
      clientId: "client-a",
      redirectUri: "https://app.example.com/cb",
    });
    expect(userId).toBe("user-1");

    // 消费即删除：二次消费必须失败（记录已不存在）
    await expect(
      server.consumeCode({
        code,
        codeVerifier: verifier,
        clientId: "client-a",
        redirectUri: "https://app.example.com/cb",
      })
    ).rejects.toThrow();
  });

  it("全新库：schema 同步幂等（二次执行 0 新增列）", async () => {
    const { pool } = createMemPool();
    await syncSchema(pool);
    const again = await syncSchema(pool);
    expect(again.synced).toBe(true);
    expect(again.addedColumns).toBe(0);
  });
});
