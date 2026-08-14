// ============================================================
// 公共类型定义
// ============================================================

/** 对外暴露的 User 对象（不含敏感字段） */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}
