// ============================================================
// 错误类型
//
// 所有 SDK 错误继承自 OmniAuthError（带机器可读 code），
// 消费方可按 instanceof / code 做程序化处理。
// ============================================================

/** SDK 错误基类（带机器可读 code） */
export class OmniAuthError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OmniAuthError";
  }
}

export class UnauthorizedError extends OmniAuthError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "UnauthorizedError";
  }
}

export class InvalidPasswordError extends OmniAuthError {
  constructor(message = "Invalid password") {
    super("INVALID_PASSWORD", message);
    this.name = "InvalidPasswordError";
  }
}

export class SocialAccountConflictError extends OmniAuthError {
  constructor(provider: string, providerOpenid: string) {
    super(
      "SOCIAL_ACCOUNT_CONFLICT",
      `社交账户 ${provider}:${providerOpenid} 已被其他用户绑定`
    );
    this.name = "SocialAccountConflictError";
  }
}

/** 超过速率限制 */
export class RateLimitedError extends OmniAuthError {
  /** 建议等待的秒数 */
  retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message: string) {
    super("RATE_LIMITED", message);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 用户已存在（如邮箱已注册） */
export class UserExistsError extends OmniAuthError {
  constructor(message = "该邮箱已被注册") {
    super("USER_EXISTS", message);
    this.name = "UserExistsError";
  }
}

/** 凭证无效或未按契约预先验证 */
export class CredentialInvalidError extends OmniAuthError {
  constructor(message: string) {
    super("CREDENTIAL_INVALID", message);
    this.name = "CredentialInvalidError";
  }
}

/** OAuth state 校验失败（缺失或不匹配） */
export class OAuthStateMismatchError extends OmniAuthError {
  constructor(message = "OAuth state 校验失败") {
    super("OAUTH_STATE_MISMATCH", message);
    this.name = "OAuthStateMismatchError";
  }
}

/** 数据库唯一约束冲突（由适配器转译） */
export class UniqueViolationError extends OmniAuthError {
  constructor(message: string) {
    super("UNIQUE_VIOLATION", message);
    this.name = "UniqueViolationError";
  }
}
