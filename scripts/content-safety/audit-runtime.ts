import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { parse } from 'dotenv';
import { options, required, writeArtifact, sha256, fail } from './optimization-cli';

async function main() {
  const args = options(['out','database','scope']);
  if (args.help) { console.log('pnpm detection:audit-runtime --out <new.json> [--database local --scope all-local] (read-only; never exports secrets)'); return; }
  const git = (...values: string[]) => execFileSync('git', ['-c', 'safe.directory=' + process.cwd().replaceAll('\\','/'), ...values], { encoding: 'utf8' }).trim();
  const snapshot: Record<string, unknown> = {
    schemaVersion: '1.0', capturedAt: new Date().toISOString(), codeRevision: git('rev-parse','HEAD'),
    dirtyDiffDigest: sha256(git('diff','--no-ext-diff')), status: git('-c','core.quotepath=false','status','--short').split('\n'),
    node: process.version, databaseReadOnly: true, modelQuality: 'UNVERIFIED',
    limits: ['No production approval inferred', 'API connectivity is not model quality evidence', 'Formal standard clauses require independently sourced full text'],
  };
  if (args.database) {
    if (args.database !== 'local' || args.scope !== 'all-local') throw new Error('EXPLICIT_LOCAL_SCOPE_REQUIRED');
    let env: Record<string,string> = {};
    for (const file of ['.env','.env.local']) {
      try { env = { ...env, ...parse(await readFile(file)) }; } catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e; }
    }
    const loaded = { ...env, ...process.env };
    const connectionString = loaded.PGDATABASE_URL ?? loaded.COZE_SUPABASE_DB_URL ?? loaded.DATABASE_URL;
    if (!connectionString || !['localhost','127.0.0.1','[::1]'].includes(new URL(connectionString).hostname)) throw new Error('LOCAL_DATABASE_REQUIRED');
    const client = new Client({ connectionString, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    try {
      await client.connect(); await client.query('BEGIN READ ONLY');
      snapshot.transactionReadOnly = (await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only')).rows[0].transaction_read_only;
      snapshot.bundles = (await client.query(`SELECT id, version, state, content_hash,
        jsonb_array_length(canonical_json->'rules') AS rules,
        jsonb_array_length(canonical_json->'exceptions') AS exceptions,
        jsonb_array_length(canonical_json->'detectorDag'->'nodes') AS nodes,
        canonical_json ? 'semanticClassifier' AS semantic_configured,
        canonical_json ? 'judgeProfiles' AS judge_configured
        FROM policy_bundles WHERE state = 'active'`)).rows;
      snapshot.bindings = (await client.query('SELECT active_bundle_id, shadow_bundle_id, canary_bundle_id, generation FROM application_policy_bindings')).rows;
      snapshot.providers = (await client.query('SELECT provider_type, is_enabled, count(*)::int AS count FROM llm_providers GROUP BY provider_type, is_enabled')).rows;
      const counts: Record<string,number> = {};
      for (const table of ['dictionary_releases','keyword_rules','whitelist_rules','policy_judge_configs']) {
        counts[table] = Number((await client.query<{ count: string }>('SELECT count(*) FROM ' + table)).rows[0].count);
      }
      snapshot.governanceCounts = counts;
      await client.query('ROLLBACK');
    } finally { await client.end(); }
  } else snapshot.database = 'NOT_REQUESTED';
  try { snapshot.gpu = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total','--format=csv,noheader'], { encoding:'utf8', timeout:5000 }).trim(); }
  catch { snapshot.gpu = 'NOT_AVAILABLE_OR_NOT_DISCOVERED'; }
  await writeArtifact(required(args.out,'out'), snapshot); console.log(JSON.stringify(snapshot));
}
main().catch(error => { console.error('AUDIT_FAILED (credentials and connection details suppressed)'); if (error instanceof Error && error.message.startsWith('ARGUMENT_')) fail(error); else process.exitCode = 2; });
