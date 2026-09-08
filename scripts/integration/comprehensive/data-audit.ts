/** Read-only report: never deduplicate records without an operator-reviewed decision. */
import { Client } from 'pg';
import { writeFileSync } from 'node:fs';
async function main() {
 const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
 try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const groups = await client.query(`select tenant_id,application_id,policy_id,dimension,count(*)::int count,jsonb_agg(jsonb_build_object('id',id,'createdAt',created_at,'enabled',enabled,'warnThreshold',warn_threshold,'blockThreshold',block_threshold) order by created_at,id) candidates from policy_rules group by tenant_id,application_id,policy_id,dimension having count(*)>1 order by tenant_id,application_id,policy_id,dimension`);
  const events = await client.query(`select id,event,created_at from security_audit_events where event like 'policy.%' order by created_at desc limit 1000`);
  await client.query('COMMIT');
  const report = { status:'PASS',mode:'READ_ONLY_DRY_RUN',duplicateGroups:groups.rows,auditContext:events.rows,automaticDeletion:false,decision:'Review row differences and audit timestamps before proposing any data repair' };
  writeFileSync((process.env.COMPREHENSIVE_RUN_DIR ?? '.')+'/data-audit.json',JSON.stringify(report,null,2)); console.log(JSON.stringify({status:'PASS',duplicateGroups:groups.rowCount,mutated:false}));
 } finally { await client.end(); }
}
main().catch(() => { console.error('READ_ONLY_AUDIT_FAILED'); process.exitCode=1; });
