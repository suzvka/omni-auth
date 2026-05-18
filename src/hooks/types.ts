// src/hooks/types.ts
// Hook 接口合约定义 — Phase 1 核心契约

export interface DatabaseAccessor {
  createDatabase(dbName: string): Promise<void>;
  executeDDL(dbName: string, statements: string[]): Promise<void>;
  verifyTable(
    dbName: string,
    tableName: string,
    tableDDL: string,
  ): Promise<{ match: boolean; error?: string }>;
}

export interface AccountManager {
  createAccount(
    platformKey: string,
  ): Promise<{ username: string; password: string }>;
  grantAccess(username: string, dbName: string): Promise<void>;
}

export interface IdGenerator {
  generate(): string;
}

export interface HashComputer {
  compute(content: string): string;
}

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

export interface AuthGuard {
  verify(
    request: Request,
  ): Promise<{ authenticated: boolean; error?: string }>;
}

export interface HandlerDependencies {
  databaseAccessor: DatabaseAccessor;
  accountManager: AccountManager;
  idGenerator?: IdGenerator;
  hashComputer?: HashComputer;
  clock?: Clock;
  logger?: Logger;
  authGuard?: AuthGuard;
}
