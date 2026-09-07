import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
const file = process.argv[2];
if (!/^00\d\d_[a-z0-9_]+\.sql$/.test(file ?? '')) throw new Error('A named drizzle migration is required');
const root = path.resolve(import.meta.dirname, '../..');
const environment = JSON.parse(readFileSync(path.join(root, '.artifact-build/upgrade-implementation-20260907/environment/environment.json'), 'utf8'));
const url = new URL(environment.PGDATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
const db = new pg.Client({ connectionString: environment.PGDATABASE_URL, ssl: false, statement_timeout: 30000 });
await db.connect();
try {
  const sql = readFileSync(path.join(root, 'drizzle', file), 'utf8');
  for (let repeat = 0; repeat < 2; repeat++) {
    await db.query('BEGIN');
    try { await db.query(sql); await db.query('COMMIT'); } catch (error) { await db.query('ROLLBACK'); throw error; }
  }
  console.log('Isolated migration applied twice: ' + file);
} finally { await db.end(); }
