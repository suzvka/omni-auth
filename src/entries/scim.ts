// omni-auth/scim — SCIM 2.0 目录管理面（高级能力子入口）
// ============================================================

export { createScimUserHandler } from "../scim/handler";
export type { ScimUserHandler } from "../scim/handler";
export { USER_SCHEMA_ID, userSchema, allSchemas, getSchemaById } from "../scim/schemas";
export {
  ScimError,
  notFound,
  invalidValue,
  invalidSyntax,
  unauthorized,
  conflict,
  internalError,
  parsePagination,
  buildListResponse,
  parseFilter,
} from "../scim/types";
export type {
  ScimUser,
  ScimListResponse,
  ScimErrorResponse,
  ScimCreateUserRequest,
  ScimPatchRequest,
  ScimPatchOperation,
  ScimServiceProviderConfig,
  PaginationParams,
} from "../scim/types";
