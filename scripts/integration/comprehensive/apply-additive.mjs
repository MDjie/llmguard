import { readFileSync, readdirSync } from 'node:fs';
import { Client } from 'pg';
const url = new URL(process.env.DATABASE_URL); if (url.hostname !== '127.0.0.1' || url.port !== '5438' || !/^\/guardllm_integration_full_[0-9]+$/.test(url.pathname)) throw new Error('ISOLATION_REQUIRED');
const client = new Client({ connectionString: url.href }); await client.connect();
try { for (const file of readdirSync('drizzle').filter(name => /^\d{4}_.+\.sql$/.test(name) && name >= '0065_').sort()) await client.query(readFileSync('drizzle/' + file, 'utf8')); console.log('ADDITIVE_MIGRATIONS_APPLIED'); } finally { await client.end(); }
