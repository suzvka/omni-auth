import { setAccountResolver } from "./resolver";
import { businessAccountRepo } from "@/modules/db";
import type { Account } from "./types";

export function initAuthModule(): void {
  setAccountResolver({
    async findByAuthUserId(authUserId: string): Promise<Account | null> {
      const record = await businessAccountRepo.findByAuthUserId(authUserId);
      if (!record) return null;
      return {
        id: record.id,
        authUserId: record.authUserId,
        displayName: record.displayName,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    },
  });
}

// 模块导入时自动初始化，确保 API 路由和页面组件均可使用
initAuthModule();
