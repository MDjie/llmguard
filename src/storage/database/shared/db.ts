/**
 * Drizzle ORM 数据库连接
 * 延迟初始化以支持构建时无需数据库配置
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config as loadDotEnv } from 'dotenv';
import * as schema from './schema';
import { logger } from '@/lib/observability/logger';
import { resolveDatabaseTls } from './tls';

// 加载环境变量（原 supabase-client 中的 dotenv 加载逻辑内联于此）
if (process.env.NEXT_PHASE !== 'phase-production-build') {
  loadDotEnv({ quiet: true });
}

// 获取数据库连接 URL
function getDatabaseUrl(): string | null {
  // 优先使用 PGDATABASE_URL（正确的数据库连接字符串）
  if (process.env.PGDATABASE_URL) {
    return process.env.PGDATABASE_URL;
  }

  // 其次使用 COZE_SUPABASE_DB_URL
  if (process.env.COZE_SUPABASE_DB_URL) {
    return process.env.COZE_SUPABASE_DB_URL;
  }

  // 最后使用 DATABASE_URL
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // 构建时可能没有数据库配置，返回 null
  return null;
}

// 延迟初始化的数据库实例
let _db: ReturnType<typeof drizzle> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

// 获取数据库实例（延迟初始化）
function getDb() {
  if (!_db) {
    const connectionString = getDatabaseUrl();
    
    if (!connectionString) {
      throw new Error('未找到数据库连接配置，请设置 PGDATABASE_URL 或 DATABASE_URL 环境变量');
    }

    const databaseUrl = new URL(connectionString);
    logger.info('database.connecting', {
      host: databaseUrl.hostname,
      port: databaseUrl.port || '5432',
      database: databaseUrl.pathname.replace(/^\//, ''),
    });

    // 创建 postgres-js 客户端
    _client = postgres(connectionString, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: resolveDatabaseTls(connectionString, {
        sslMode: process.env.DATABASE_SSL_MODE,
        caCertificate: process.env.DATABASE_CA_CERT,
        nodeEnv: process.env.NODE_ENV,
        plaintextAllowedHosts: process.env.DATABASE_PLAINTEXT_ALLOWED_HOSTS,
      }),
    });

    _db = drizzle(_client, { schema });
  }
  
  return _db;
}

// 导出 db 作为 getter，支持延迟初始化
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_, prop) {
    return Reflect.get(getDb(), prop);
  },
});

export async function closeDatabaseConnection(): Promise<void> {
  const client = _client;
  _client = null;
  _db = null;
  if (client) {
    await client.end({ timeout: 5 });
  }
}

// 导出 schema
export * from './schema';
