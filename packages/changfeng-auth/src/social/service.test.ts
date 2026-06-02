import { describe, it, expect, beforeEach } from "vitest";
import { createSocialService } from "./service";
import { clearTokenRefreshers, registerTokenRefresher } from "./token";
import { SocialAccountConflictError } from "../errors";
import type { DatabaseAdapter } from "../adapters/database";
import type { SocialAccountDTO } from "./types";

// ============================================================
// In-memory mock DatabaseAdapter
// ============================================================
function createInMemoryDb(): DatabaseAdapter {
  const store = new Map<string, Map<string, Record<string, unknown>>>();

  function ensureModel(model: string): Map<string, Record<string, unknown>> {
    if (!store.has(model)) {
      store.set(model, new Map());
    }
    return store.get(model)!;
  }

  let nextId = 1;

  return {
    async create({ model, data }) {
      const table = ensureModel(model);
      const id = (data.id as string) ?? String(nextId++);
      const now = new Date();
      const record = { ...data, id, createdAt: now, updatedAt: now };
      table.set(id, record);
      return record;
    },

    async findOne({ model, where }) {
      const table = ensureModel(model);
      for (const [, record] of table) {
        if (where.every((w) => record[w.field] === w.value)) {
          return record;
        }
      }
      return null;
    },

    async findMany({ model, where, limit, offset }) {
      const table = ensureModel(model);
      const results: Record<string, unknown>[] = [];

      for (const [, record] of table) {
        if (!where || where.every((w) => record[w.field] === w.value)) {
          results.push(record);
        }
      }

      let sliced = results;
      if (offset) sliced = sliced.slice(offset);
      if (limit) sliced = sliced.slice(0, limit);
      return sliced;
    },

    async updateOne({ model, where, update }) {
      const table = ensureModel(model);
      for (const [, record] of table) {
        if (where.every((w) => record[w.field] === w.value)) {
          Object.assign(record, update, { updatedAt: new Date() });
          return record;
        }
      }
      throw new Error(`Record not found in ${model}`);
    },

    async updateMany({ model, where, update }) {
      const table = ensureModel(model);
      let count = 0;
      for (const [, record] of table) {
        if (where.every((w) => {
          if (w.operator === "neq") return record[w.field] !== w.value;
          return record[w.field] === w.value;
        })) {
          Object.assign(record, update);
          count++;
        }
      }
      return count;
    },

    async deleteOne({ model, where }) {
      const table = ensureModel(model);
      for (const [id, record] of table) {
        if (where.every((w) => record[w.field] === w.value)) {
          table.delete(id);
          return record;
        }
      }
      throw new Error(`Record not found in ${model}`);
    },

    async deleteMany({ model, where }) {
      const table = ensureModel(model);
      let count = 0;
      const toDelete: string[] = [];
      for (const [id, record] of table) {
        if (where.every((w) => {
          if (w.operator === "neq") return record[w.field] !== w.value;
          return record[w.field] === w.value;
        })) {
          toDelete.push(id);
        }
      }
      for (const id of toDelete) {
        table.delete(id);
        count++;
      }
      return count;
    },
  };
}

// ============================================================
// Tests
// ============================================================

describe("createSocialService", () => {
  let db: DatabaseAdapter;
  let service: ReturnType<typeof createSocialService>;

  beforeEach(() => {
    clearTokenRefreshers();
    db = createInMemoryDb();
    service = createSocialService(db);
  });

  // ---- bindToUser ----

  describe("bindToUser", () => {
    it("应成功绑定社交账户", async () => {
      const result = await service.bindToUser("user_1", {
        provider: "wechat",
        providerOpenid: "oid_abc",
        accessToken: "at_001",
      });

      expect(result.userId).toBe("user_1");
      expect(result.provider).toBe("wechat");
      expect(result.providerOpenid).toBe("oid_abc");
      expect(result.accessToken).toBe("at_001");
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it("同一 provider+openid 重复绑定应抛 SocialAccountConflictError", async () => {
      await service.bindToUser("user_1", {
        provider: "wechat",
        providerOpenid: "oid_dup",
      });

      await expect(
        service.bindToUser("user_2", {
          provider: "wechat",
          providerOpenid: "oid_dup",
        })
      ).rejects.toThrow(SocialAccountConflictError);
    });

    it("同一 provider 不同 openid 可绑定不同用户", async () => {
      const r1 = await service.bindToUser("user_1", {
        provider: "wechat",
        providerOpenid: "oid_a",
      });
      const r2 = await service.bindToUser("user_2", {
        provider: "wechat",
        providerOpenid: "oid_b",
      });

      expect(r1.userId).toBe("user_1");
      expect(r2.userId).toBe("user_2");
    });

    it("应正确处理 tokenExpiresAt 为 Date 类型", async () => {
      const expires = new Date("2026-12-31");
      const result = await service.bindToUser("user_1", {
        provider: "wechat",
        providerOpenid: "oid_exp",
        tokenExpiresAt: expires,
      });

      expect(result.tokenExpiresAt).toEqual(expires);
    });

    it("应正确处理 tokenExpiresAt 为 number 类型", async () => {
      const ts = Date.now() + 3600000;
      const result = await service.bindToUser("user_1", {
        provider: "wechat",
        providerOpenid: "oid_ts",
        tokenExpiresAt: ts,
      });

      expect(result.tokenExpiresAt).toBeInstanceOf(Date);
      expect(result.tokenExpiresAt!.getTime()).toBe(ts);
    });

    it("应正确处理 profileData", async () => {
      const result = await service.bindToUser("user_1", {
        provider: "wechat",
        providerOpenid: "oid_profile",
        profileData: { nickname: "test", avatar: "url" },
      });

      expect(result.profileData).toEqual({ nickname: "test", avatar: "url" });
    });
  });

  // ---- unbindFromUser ----

  describe("unbindFromUser", () => {
    it("应成功解绑社交账户", async () => {
      const created = await service.bindToUser("user_1", {
        provider: "wechat",
        providerOpenid: "oid_unbind",
      });

      await service.unbindFromUser(created.id);

      const found = await service.findByProvider("wechat", "oid_unbind");
      expect(found).toBeNull();
    });

    it("删除不存在的账户应抛异常", async () => {
      await expect(
        service.unbindFromUser("nonexistent_id")
      ).rejects.toThrow();
    });
  });

  // ---- listByUser ----

  describe("listByUser", () => {
    it("应列出用户的所有社交账户", async () => {
      await service.bindToUser("user_1", {
        provider: "wechat",
        providerOpenid: "oid_1",
      });
      await service.bindToUser("user_1", {
        provider: "google",
        providerOpenid: "oid_2",
      });

      const list = await service.listByUser("user_1");
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.provider).sort()).toEqual(["google", "wechat"]);
    });

    it("无社交账户时应返回空数组", async () => {
      const list = await service.listByUser("user_empty");
      expect(list).toEqual([]);
    });
  });

  // ---- findByProvider ----

  describe("findByProvider", () => {
    it("应找到已绑定的社交账户", async () => {
      await service.bindToUser("user_1", {
        provider: "wechat",
        providerOpenid: "oid_find",
      });

      const found = await service.findByProvider("wechat", "oid_find");
      expect(found).not.toBeNull();
      expect(found!.userId).toBe("user_1");
    });

    it("未绑定的应返回 null", async () => {
      const found = await service.findByProvider("wechat", "nonexistent");
      expect(found).toBeNull();
    });
  });

  // ---- Token 自动刷新 ----

  describe("listByUser 自动 Token 刷新", () => {
    it("未过期 token 不触发刷新", async () => {
      const future = new Date(Date.now() + 3600000); // 1 小时后过期
      const created = await service.bindToUser("user_1", {
        provider: "wechat",
        providerOpenid: "oid_fresh",
        accessToken: "old_token",
        tokenExpiresAt: future,
      });

      let refreshCalled = false;
      registerTokenRefresher("wechat", async () => {
        refreshCalled = true;
        return { accessToken: "new_token" };
      });

      const list = await service.listByUser("user_1");
      expect(refreshCalled).toBe(false);
      expect(list[0].accessToken).toBe("old_token");
    });

    it("已过期 token 应触发自动刷新", async () => {
      const past = new Date(Date.now() - 3600000); // 1 小时前已过期
      const created = await service.bindToUser("user_1", {
        provider: "wechat",
        providerOpenid: "oid_expired",
        accessToken: "old_token",
        refreshToken: "old_refresh",
        tokenExpiresAt: past,
      });

      registerTokenRefresher("wechat", async (account) => ({
        accessToken: "new_token_for_" + account.id,
        refreshToken: "new_refresh",
        expiresAt: new Date("2026-12-31"),
      }));

      const list = await service.listByUser("user_1");
      expect(list[0].accessToken).toContain("new_token_for_");
      expect(list[0].refreshToken).toBe("new_refresh");
    });

    it("无 refresher 时过期 token 不刷新（原样返回）", async () => {
      const past = new Date(Date.now() - 3600000);
      await service.bindToUser("user_1", {
        provider: "github",
        providerOpenid: "oid_no_refresher",
        accessToken: "old_gh_token",
        tokenExpiresAt: past,
      });

      // 未注册 github refresher
      const list = await service.listByUser("user_1");
      expect(list[0].accessToken).toBe("old_gh_token");
    });
  });
});
