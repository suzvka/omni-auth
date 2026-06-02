// ============================================================
// Better Auth 内部 API 类型定义
//
// 集中管理 Better Auth 的返回值类型，避免到处写 as 断言。
// ============================================================

/** Better Auth Session 中 user 字段的最小类型 */
export interface BetterAuthUser {
  id: string;
  email: string;
  name?: string;
  image?: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Better Auth Session 完整类型 */
export interface BetterAuthSession {
  user: BetterAuthUser;
  session: {
    id: string;
    token: string;
    userId: string;
    expiresAt: Date;
    createdAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
}

/** signUpEmail 返回值 */
export interface SignUpEmailResult {
  token: string | null;
  user: { id: string; email: string; name: string };
}

/** signInEmail 返回值 */
export interface SignInEmailResult {
  token: string | null;
  user: { id: string; email?: string; name?: string };
}

/** 数据库记录通用类型（用于 unknown → DTO 转换） */
export type DbRecord = Record<string, unknown>;
