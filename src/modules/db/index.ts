export { prisma } from "./client";
export { dbConfig } from "./config";
export type { DbConfig } from "./config";
export { initializeDatabase } from "./sync";
export { socialAccountRepo } from "./repositories/socialAccount";
export type { CreateSocialAccountInput } from "./repositories/socialAccount";
