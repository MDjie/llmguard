import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
async function main() {
  const directory=path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment: Record<string,string> = JSON.parse(readFileSync(path.join(directory,'environment.json'),'utf8'));
  const url=new URL(environment.PGDATABASE_URL);
  if(url.hostname!=='127.0.0.1'||url.port!=='55447'||url.pathname!=='/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
  Object.assign(process.env,environment,{GATEWAY_V2_ENABLED:'true'});
  const [{ collectGatewayRuntimeMetrics,GATEWAY_RUNTIME_GAUGES },{renderPrometheusMetrics},{closeDatabaseConnection}]=await Promise.all([
    import('../../src/lib/observability/gateway-runtime-metrics'),import('../../src/lib/observability/metrics'),import('../../src/storage/database/shared/db')]);
  try {
    await collectGatewayRuntimeMetrics(); const rendered=renderPrometheusMetrics();
    const samples=GATEWAY_RUNTIME_GAUGES.map(name=>{const line=rendered.split('\n').find(item=>item.startsWith('guardllm_gateway_'+name+' '));assert.ok(line);const value=Number(line.split(' ')[1]);assert.ok(Number.isFinite(value)&&value>=0);return {name,value};});
    assert.equal(samples.length,11);
    writeFileSync(path.join(directory,'runtime-metrics-evidence.json'),JSON.stringify({capturedAt:new Date().toISOString(),status:'PASS',checks:['read-only bounded query executes against migrated PostgreSQL','all 11 fixed-label gauges present with finite values'],samples},null,2));
    console.log('Runtime metrics: PASS (11 PostgreSQL-backed gauges).');
  } finally {await closeDatabaseConnection();}
}
main().catch(()=>{console.error('RUNTIME_METRICS_CHECK_FAILED');process.exitCode=1;});
