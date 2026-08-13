// ============================================================
// Prisma Schema 生成器
//
// 从 schema.ts 的表定义生成 Prisma schema（仅 model 块）
// 由 bin/codegen.mjs 在运行时调用，输出 dist/schema.prisma
//
// App 端需将生成产物与自定义表合并到 prisma/schema.prisma
// ============================================================

import type { Schema, TableDef, ColumnBuilder } from "./schema-builder";

// ----------------------------------------------------------
// 列类型 → Prisma 类型
// ----------------------------------------------------------

function columnTypeToPrisma(type: string): string {
  switch (type) {
    case "text":
      return "String";
    case "boolean":
      return "Boolean";
    case "integer":
      return "Int";
    case "jsonb":
      return "Json";
    case "timestamptz":
    case "timestamp":
      return "DateTime";
    default:
      return "String";
  }
}

// ----------------------------------------------------------
// 默认值 → Prisma @default(...)
// ----------------------------------------------------------

function defaultValueToPrisma(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value === "NOW()" || value === "CURRENT_TIMESTAMP") {
      return "now()";
    }
    return `"${value}"`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    // JSONB 默认值：转为 JSON 字符串
    return `"${JSON.stringify(value).replace(/"/g, '\\"')}"`;
  }
  return String(value);
}

// ----------------------------------------------------------
// 关系收集
// ----------------------------------------------------------

interface Relation {
  fromTable: string;
  fromCol: string;
  toTable: string;
  onDelete?: string;
}

function collectRelations(schema: Schema): Relation[] {
  const relations: Relation[] = [];
  for (const [tableName, table] of Object.entries(schema)) {
    for (const [colName, col] of Object.entries(table.columns)) {
      if (col._def.relation) {
        relations.push({
          fromTable: tableName,
          fromCol: colName,
          toTable: col._def.relation.model,
          onDelete: col._def.relation.onDelete,
        });
      }
    }
  }
  return relations;
}

// ----------------------------------------------------------
// 单表 → Prisma model
// ----------------------------------------------------------

function buildModel(
  table: TableDef,
  relations: Relation[]
): string {
  const lines: string[] = [];
  lines.push(`model ${capitalize(table.name)} {`);

  // 列定义
  for (const [colName, col] of Object.entries(table.columns)) {
    const prismaType = columnTypeToPrisma(col._def.type);
    const optional = !col._def.required;
    const typeStr = optional ? `${prismaType}?` : prismaType;

    const attrs: string[] = [];

    if (col._def.primaryKey) {
      attrs.push("@id");
      // 默认 cuid() 主键
      if (colName === "id" && col._def.default === undefined) {
        attrs.push('@default(cuid())');
      }
    }

    if (col._def.unique && !col._def.primaryKey) {
      attrs.push("@unique");
    }

    if (col._def.default !== undefined) {
      attrs.push(`@default(${defaultValueToPrisma(col._def.default)})`);
    }

    if (colName === "updatedAt") {
      attrs.push("@updatedAt");
    }

    const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
    lines.push(`  ${colName} ${typeStr}${attrStr}`);
  }

  // 外键关系字段（从当前表出发的 relation）
  const outRelations = relations.filter((r) => r.fromTable === table.name);
  for (const rel of outRelations) {
    const refModel = capitalize(rel.toTable);
    const onDelete = rel.onDelete ? `, onDelete: ${capitalize(rel.onDelete)}` : "";
    lines.push(
      `  ${rel.toTable} ${refModel} @relation(fields: [${rel.fromCol}], references: [id]${onDelete})`
    );
  }

  // 反向关系字段（指向当前表的 relation）
  const inRelations = relations.filter((r) => r.toTable === table.name);
  for (const rel of inRelations) {
    const fromModel = capitalize(rel.fromTable);
    // 假设一对多：反向字段为数组
    lines.push(`  ${rel.fromTable} ${fromModel}[]`);
  }

  // 复合唯一约束
  if (table.uniqueConstraints) {
    for (const group of table.uniqueConstraints) {
      lines.push(`  @@unique([${group.join(", ")}])`);
    }
  }

  // 表名映射：Prisma model 名首字母大写，实际表名以 schema.ts 为准（小写保真）
  lines.push(`  @@map("${table.name}")`);

  lines.push("}");
  return lines.join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ----------------------------------------------------------
// Schema → 完整 Prisma schema
// ----------------------------------------------------------

/** 从 schema 对象生成 Prisma schema（仅 model 块，不含 generator/datasource） */
export function generatePrismaModels(schema: Schema): string {
  const relations = collectRelations(schema);
  const models: string[] = [];

  for (const table of Object.values(schema)) {
    models.push(buildModel(table, relations));
  }

  return models.join("\n\n") + "\n";
}

/** 从 schema 对象生成完整 Prisma schema（含 generator + datasource + models） */
export function generatePrismaSchema(
  schema: Schema,
  opts?: {
    generator?: string;
    datasource?: { provider?: string; url?: string };
  }
): string {
  const generator = opts?.generator ?? "prisma-client-js";
  const provider = opts?.datasource?.provider ?? "postgresql";
  const url = opts?.datasource?.url ?? 'env("DATABASE_URL")';

  const header = `// ============================================================
// omni-auth 生成的 Prisma schema（勿手动修改）
// 由 \`pnpm omni-auth codegen\` 生成
// ============================================================

generator client {
  provider = "${generator}"
}

datasource db {
  provider = "${provider}"
  url      = ${url}
}

`;

  return header + generatePrismaModels(schema);
}
