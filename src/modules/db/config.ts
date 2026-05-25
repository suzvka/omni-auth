export interface DbConfig {
  /** PostgreSQL 连接地址（必填） */
  url: string;
  /** 是否打印 SQL 查询日志（默认 false） */
  logQueries: boolean;
}

function loadDbConfig(): DbConfig {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required. Set it via the DATABASE_URL environment variable."
    );
  }

  return {
    url,
    logQueries: process.env.DB_LOG_QUERIES === "true",
  };
}

export const dbConfig = loadDbConfig();
