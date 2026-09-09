import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../../src/storage/database/shared/schema';
import * as iamSchema from '../../../src/lib/iam/schema';
async function main() {
  const out = process.argv[2];
  const env = out ? JSON.parse(readFileSync(out + '/environment.private.json', 'utf8')) as Record<string, string> : process.env;
  const url = new URL(env.INTEGRATION_DATABASE_URL ?? env.DATABASE_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^\/guardllm_integration[_a-z0-9]*$/.test(url.pathname)) throw new Error('ISOLATION_REQUIRED');
  const client = new Client({ connectionString: url.href }); await client.connect();
  try {
    const result = await client.query<{ table_name: string; column_name: string; is_nullable: string; data_type: string; character_maximum_length: number | null }>("SELECT table_name,column_name,is_nullable,data_type,character_maximum_length FROM information_schema.columns WHERE table_schema='public'");
    const actual = new Map(result.rows.map(row => [row.table_name + '.' + row.column_name, row]));
    const tables = Object.values({...schema,...iamSchema}).filter(value => is(value, PgTable)).map(value => getTableConfig(value));
    const missing = tables.flatMap(table => table.columns.filter(column => !actual.has(table.name + '.' + column.name)).map(column => ({ table: table.name, column: column.name, type: column.getSQLType() })));
    const relevant = ['agent_traces.record_id', 'agent_traces.provider_id', 'agent_traces.workflow_name', 'agent_traces.request_payload', 'agent_traces.response_payload', 'agent_traces.latency_ms', 'agent_traces.success', 'agent_traces.error_message', 'judge_model_invocations.input_hash', 'judge_model_invocations.prompt_tokens', 'judge_model_invocations.completion_tokens', 'judge_model_invocations.total_tokens', 'whitelist_rules.proposed_by', 'whitelist_rules.revision', 'export_approval_requests.export_query', 'artifacts.purged_at', 'artifacts.hold_until', 'artifacts.upload_expires_at', 'artifact_purge_ledger.state', 'artifact_purge_ledger.lease_token', 'artifact_purge_ledger.lease_until', 'artifact_purge_ledger.versions', 'artifact_purge_ledger.not_before', 'artifact_purge_ledger.retry_at'];
    const shapeErrors: string[] = [];
    for (const table of tables) for (const column of table.columns) {
      const key = `${table.name}.${column.name}`; if (!relevant.includes(key)) continue;
      const found = actual.get(key); if (!found) continue;
      const expectedType = column.getSQLType().replace(/^varchar\(\d+\)$/, 'character varying');
      if (found.data_type !== expectedType || (found.is_nullable === 'NO') !== column.notNull) shapeErrors.push(key);
      const length = column.getSQLType().match(/^varchar\((\d+)\)$/)?.[1];
      if (length && found.character_maximum_length !== Number(length)) shapeErrors.push(key + ':length');
    }
    const fk = await client.query("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='agent_traces'::regclass and contype='f'");
    for (const field of ['record_id', 'provider_id']) if (!fk.rows.some(row => String(row.definition).includes(`(${field})`))) shapeErrors.push('agent_traces:' + field + ':foreign-key');
    for (const field of ['session_id', 'trace_type', 'trace_data']) if (actual.get('agent_traces.' + field)?.is_nullable === 'NO') shapeErrors.push('agent_traces:' + field + ':legacy-required');
    const states = await client.query<{definition:string}>("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='policy_bundles'::regclass and conname='policy_bundles_state_ck'");
    for (const state of ['draft','testing','pending_approval','approved','shadow','canary','active','retired','archived','revoked']) {
      if (!states.rows[0]?.definition.includes("'"+state+"'")) shapeErrors.push('policy_bundles:state:'+state);
    }
    const purgeConstraints=await client.query<{definition:string}>("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='artifact_purge_ledger'::regclass");
    if(!purgeConstraints.rows.some(row=>row.definition.includes('FOREIGN KEY (tenant_id, application_id, artifact_id) REFERENCES artifacts(tenant_id, application_id, id)')))shapeErrors.push('artifact_purge_ledger:scope-foreign-key');
    for(const state of ['PENDING','DELETING','PURGED'])if(!purgeConstraints.rows.some(row=>row.definition.includes("'"+state+"'")))shapeErrors.push('artifact_purge_ledger:state:'+state);
    const report = { status: missing.length || shapeErrors.length ? 'FAIL' : 'PASS', database: url.pathname.slice(1), tables: tables.length, expectedColumns: tables.reduce((n, table) => n + table.columns.length, 0), missing, shapeErrors };
    if (out) writeFileSync(out + '/schema-parity.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); if (report.status === 'FAIL') process.exitCode = 1;
  } finally { await client.end(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'SCHEMA_PARITY_FAILED'); process.exitCode = 1; });
