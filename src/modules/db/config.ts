/**
 * 数据库配置（kit 渠道抽象）
 *
 * 连接凭证经 yunzone-service-kit/config 的 resolveDatabaseUrl 按渠道解析：
 * - DATABASE_PROVIDER=postgres（默认）：标准 DATABASE_URL
 * - DATABASE_PROVIDER=coze：Coze 平台注入（PGDATABASE_URL / PG* 系列）
 * 显式声明禁止嗅探，与集群其他子项目一致。
 */

import { resolveDatabaseUrl } from "yunzone-service-kit/config";

export interface DbConfig {
  /** PostgreSQL 连接地址（渠道解析后） */
  url: string;
  /** 是否打印 SQL 查询日志（默认 false） */
  logQueries: boolean;
}

function loadDbConfig(): DbConfig {
  return {
    url: resolveDatabaseUrl(),
    logQueries: process.env.DB_LOG_QUERIES === "true",
  };
}

export const dbConfig = loadDbConfig();
