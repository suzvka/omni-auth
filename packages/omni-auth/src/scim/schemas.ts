// ============================================================
// SCIM Schema 定义（RFC 7643 §4.2）— 认证域私有
//
// 仅声明核心 User schema，不包含企业扩展（department 硬编码且未实现）。
// 供 /Schemas 与 /Schemas/{id} 端点共享（宿主 route 薄壳透传）。
// ============================================================

export const USER_SCHEMA_ID = "urn:ietf:params:scim:schemas:core:2.0:User";

/** User 资源 schema 定义 */
export const userSchema = {
  id: USER_SCHEMA_ID,
  name: "User",
  description: "User Account",
  attributes: [
    { name: "id", type: "string", required: true, caseExact: false, mutability: "readOnly", return: "always", uniqueness: "server" },
    { name: "userName", type: "string", required: true, caseExact: false, mutability: "readWrite", return: "default", uniqueness: "server" },
    { name: "displayName", type: "string", required: false, caseExact: false, mutability: "readWrite", return: "default", uniqueness: "none" },
    { name: "emails", type: "complex", required: false, mutability: "readWrite", return: "default", uniqueness: "none", subAttributes: [
      { name: "value", type: "string", required: true, caseExact: false, mutability: "readWrite", return: "default", uniqueness: "none" },
      { name: "primary", type: "boolean", required: false, mutability: "readWrite", return: "default", uniqueness: "none" },
    ]},
    { name: "active", type: "boolean", required: false, mutability: "readWrite", return: "default", uniqueness: "none" },
    { name: "meta", type: "complex", required: false, mutability: "readOnly", return: "always", subAttributes: [
      { name: "resourceType", type: "string", required: true, mutability: "readOnly", return: "always" },
      { name: "created", type: "dateTime", required: true, mutability: "readOnly", return: "always" },
      { name: "lastModified", type: "dateTime", required: true, mutability: "readOnly", return: "always" },
    ]},
  ],
  meta: { resourceType: "Schema", location: "/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User" },
} as const;

/** 全部已注册 schema */
export const allSchemas = [userSchema] as const;

/** 按 schema id 查找，未找到返回 null */
export function getSchemaById(id: string): (typeof allSchemas)[number] | null {
  return allSchemas.find((s) => s.id === id) ?? null;
}
