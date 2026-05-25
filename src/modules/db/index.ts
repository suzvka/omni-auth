export { prisma } from "./client";
export { dbConfig } from "./config";
export type { DbConfig } from "./config";
export { initializeDatabase, ensureDatabaseSchema } from "./sync";
export type { ColumnDecl, TableDecl, SchemaDeclaration } from "./sync";
export { businessAccountRepo } from "./repositories/businessAccount";
