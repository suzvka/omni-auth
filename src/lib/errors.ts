// src/lib/errors.ts
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  invalidInput: (msg: string) => new AppError("INVALID_INPUT", msg, 400),
  notFound: (msg: string) => new AppError("ENTITY_NOT_FOUND", msg, 404),
  conflict: (msg: string) => new AppError("ENTITY_CONFLICT", msg, 409),
  platformKeyExists: () => new AppError("PLATFORM_KEY_EXISTS", "platform_key already exists", 409),
  resourceKeyExists: () => new AppError("RESOURCE_KEY_EXISTS", "resource_key already exists under this platform", 409),
  dbCreateFailed: (msg: string) => new AppError("DATABASE_CREATE_FAILED", msg, 500),
  schemaInvalid: (msg: string) => new AppError("SCHEMA_INVALID", msg, 400),
  schemaMismatch: (msg: string) => new AppError("SCHEMA_MISMATCH", msg, 422),
  schemaApplyFailed: (msg: string) => new AppError("SCHEMA_APPLY_FAILED", msg, 500),
  internal: (msg: string) => new AppError("INTERNAL_ERROR", msg, 500),
};
