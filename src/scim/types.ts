// ============================================================
// SCIM 2.0 — 类型 / 错误 / 分页（认证域私有）
//
// 迁移自宿主 user_center 的 lib/scim/*，协议翻译与错误生成
// 收敛到包内；宿主 route 仅做 HTTP 薄壳。
// ============================================================

// ----------------------------------------------------------
// 类型
// ----------------------------------------------------------

export interface ScimUser {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"];
  id: string;
  userName: string;
  displayName?: string;
  active: boolean;
  meta: {
    resourceType: "User";
    created: string;
    lastModified: string;
    /** 资源 URI；依赖宿主部署路径，由 route 表现层注入（包保持框架无关） */
    location?: string;
  };
}

export interface ScimListResponse {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: ScimUser[];
}

export interface ScimErrorResponse {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"];
  detail: string;
  status: number;
  scimType?: string;
}

export interface ScimCreateUserRequest {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"];
  /** 唯一键由服务端生成（响应中 userName 恒为 id）；客户端提供时仅作为名字写入诉求的兜底（displayName 缺失时落入 name 列） */
  userName?: string;
  displayName?: string;
  active?: boolean;
}

export interface ScimPatchOperation {
  op: "replace" | "add" | "remove";
  path?: string;
  value?: unknown;
}

export interface ScimPatchRequest {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"];
  Operations: ScimPatchOperation[];
}

export interface ScimServiceProviderConfig {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"];
  patch: { supported: true };
  bulk: { supported: false };
  filter: { supported: true; maxResults: number };
  changePassword: { supported: false };
  authenticationSchemes: {
    type: "oauthbearertoken";
    name: string;
    description: string;
  }[];
}

// ----------------------------------------------------------
// 错误（RFC 7644 §3.7）
// ----------------------------------------------------------

export type ScimErrorType =
  | "invalidSyntax"
  | "invalidFilter"
  | "tooMany"
  | "uniqueness"
  | "mutability"
  | "sensitive";

export class ScimError extends Error {
  constructor(
    public readonly detail: string,
    public readonly statusCode: number = 400,
    public readonly scimType?: ScimErrorType
  ) {
    super(detail);
    this.name = "ScimError";
  }

  toJSON(): ScimErrorResponse {
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail: this.detail,
      status: this.statusCode,
      ...(this.scimType ? { scimType: this.scimType } : {}),
    };
  }
}

export function notFound(detail = "Resource not found") {
  return new ScimError(detail, 404);
}

export function invalidValue(detail: string) {
  return new ScimError(detail, 400);
}

export function invalidSyntax(detail: string) {
  return new ScimError(detail, 400, "invalidSyntax");
}

export function unauthorized(detail = "Invalid or expired token") {
  return new ScimError(detail, 401);
}

export function conflict(detail: string) {
  return new ScimError(detail, 409);
}

export function internalError(detail = "Internal server error") {
  return new ScimError(detail, 500);
}

// ----------------------------------------------------------
// 分页与过滤（RFC 7644 §3.4.2 / §4.1.1）
// ----------------------------------------------------------

export interface PaginationParams {
  startIndex: number;
  count: number;
}

export function parsePagination(searchParams: URLSearchParams): PaginationParams {
  const startIndex = Math.max(1, parseInt(searchParams.get("startIndex") ?? "1", 10) || 1);
  const count = Math.min(100, Math.max(1, parseInt(searchParams.get("count") ?? "20", 10) || 20));
  return { startIndex, count };
}

export function buildListResponse<T>(
  resources: T[],
  totalResults: number,
  pagination: PaginationParams
) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"] as const,
    totalResults,
    startIndex: pagination.startIndex,
    itemsPerPage: pagination.count,
    Resources: resources,
  };
}

export function parseFilter(filter: string | null): { field: string; value: string } | null {
  if (!filter) return null;

  // 仅支持 userName（唯一键投影，匹配 id；未声明属性如 emails 不参与匹配）
  const match = filter.match(/^userName\s+eq\s+"(.+)"$/);
  if (!match) return null;

  return { field: match[1], value: match[2] };
}
