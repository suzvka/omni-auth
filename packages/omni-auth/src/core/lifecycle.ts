// ============================================================
// 生命周期钩子
// ============================================================

export interface UserCreatedPayload {
  userId: string;
  name?: string;
}

export interface LifecycleHooks {
  /** 用户注册成功后触发 */
  onUserCreated?: (payload: UserCreatedPayload) => void | Promise<void>;
}
