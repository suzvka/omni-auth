// src/core/types.ts
// 业务对象类型定义

export interface SchemaDeclaration {
  tables: TableDeclaration[];
}

export interface TableDeclaration {
  name: string;
  columns: ColumnDeclaration[];
  indexes?: IndexDeclaration[];
}

export interface ColumnDeclaration {
  name: string;
  type: string;
  nullable?: boolean;
  primary?: boolean;
  unique?: boolean;
  default?: unknown;
}

export interface IndexDeclaration {
  columns: string[];
  unique?: boolean;
  name?: string;
}

export interface TableResult {
  name: string;
  status: "created" | "verified" | "failed";
  hash: string;
}

export interface Credentials {
  host: string;
  port: number;
  databaseName: string;
  username: string;
  password: string;
}

export interface SchemaResponse {
  declaration: {
    id: string;
    version: number;
    hash: string;
    status: string;
    tables: TableResult[];
  };
  database?: Credentials;
}
