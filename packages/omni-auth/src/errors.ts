// ============================================================
// 错误类型
// ============================================================

export class UnauthorizedError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "UnauthorizedError";
  }
}

export class InvalidPasswordError extends Error {
  constructor(message = "Invalid password") {
    super(message);
    this.name = "InvalidPasswordError";
  }
}

export class SocialAccountConflictError extends Error {
  constructor(provider: string, providerOpenid: string) {
    super(`社交账户 ${provider}:${providerOpenid} 已被其他用户绑定`);
    this.name = "SocialAccountConflictError";
  }
}
