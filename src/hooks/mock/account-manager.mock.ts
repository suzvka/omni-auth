// src/hooks/mock/account-manager.mock.ts
import type { AccountManager } from "@/hooks/types";

export const mockAccountManager: AccountManager = {
  async createAccount(_platformKey: string) {
    return {
      username: "test_user",
      password: "test_pass_123",
    };
  },

  async grantAccess(_username: string, _dbName: string) {
    // Mock: 无操作
  },
};
