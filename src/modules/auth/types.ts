export interface Account {
  id: string;
  authUserId: string;
  displayName: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthContext {
  account: Account | null;
  authUserId: string | null;
}
