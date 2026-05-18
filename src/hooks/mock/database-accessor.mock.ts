// src/hooks/mock/database-accessor.mock.ts
import type { DatabaseAccessor } from "@/hooks/types";

export const mockDatabaseAccessor: DatabaseAccessor = {
  async createDatabase(_dbName: string) {
    // Mock: 仅记录，不真实创建
  },

  async executeDDL(_dbName: string, _statements: string[]) {
    // Mock: 仅校验非空
    if (!_statements.length) {
      throw new Error("DDL statements cannot be empty");
    }
  },

  async verifyTable(
    _dbName: string,
    _tableName: string,
    _tableDDL: string,
  ) {
    // Mock: 假设结构一致
    return { match: true };
  },
};
