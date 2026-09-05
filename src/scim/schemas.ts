// ============================================================
// SCIM Schema 定义（RFC 7643 §4.2）— 认证域私有
//
// 仅声明核心 User schema 的最小属性子集（id / userName / displayName / active）。
// 不包含 emails / phoneNumbers 等渠道投影属性：SCIM 是目录生命周期入口，
// 登录渠道由宿主渠道 API 管理，二者以用户 id（uuid）对接。
// userName 承载唯一键本质：恒投影服务端 id（required + readOnly + server 唯一），
// 名字属性职责由 displayName 独立承担（对齐 OIDC sub/name 分工）。
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
    { name: "userName", type: "string", required: true, caseExact: false, mutability: "readOnly", return: "default", uniqueness: "server" },
    { name: "displayName", type: "string", required: false, caseExact: false, mutability: "readWrite", return: "default", uniqueness: "none" },
    { name: "active", type: "boolean", required: false, mutability: "readWrite", return: "default", uniqueness: "none" },
    { name: "meta", type: "complex", required: false, mutability: "readOnly", return: "always", subAttributes: [
      { name: "resourceType", type: "string", required: true, mutability: "readOnly", return: "always" },
      { name: "created", type: "dateTime", required: true, mutability: "readOnly", return: "always" },
      { name: "lastModified", type: "dateTime", required: true, mutability: "readOnly", return: "always" },
      { name: "location", type: "reference", required: false, mutability: "readOnly", return: "default" },
    ]},
  ],
  // meta（resourceType/location）依赖宿主部署路径，由宿主 /Schemas route 表现层注入
} as const;

/** 全部已注册 schema */
export const allSchemas = [userSchema] as const;

/** 按 schema id 查找，未找到返回 null */
export function getSchemaById(id: string): (typeof allSchemas)[number] | null {
  return allSchemas.find((s) => s.id === id) ?? null;
}
