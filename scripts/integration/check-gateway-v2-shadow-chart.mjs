import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadAll } from 'js-yaml';
const root = process.cwd(), candidate = '.artifact-build/upgrade-implementation-20260907/helm-shadow-candidate', results = [];
const digest = value => createHash('sha256').update(value).digest('hex');
function helm(chart, enabled) {
  const args = ['run','--rm','--pull=never','--network','none','-v',`${root}:/workspace:ro`,'-w','/workspace','alpine/helm:3.17.3','template','guard',chart,
    '--set-string',`images.app=example.invalid/app@sha256:${'a'.repeat(64)},images.gateway=example.invalid/gateway@sha256:${'b'.repeat(64)},images.worker=example.invalid/worker@sha256:${'c'.repeat(64)}`,
    '--set',`shadow.enabled=${enabled}`];
  const result=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,maxBuffer:3*1024*1024});assert.equal(result.status,0,result.stderr);
  return loadAll(result.stdout).filter(Boolean);
}
function test(name, run) { run(); results.push({ name, status:'PASS' }); console.log('PASS '+name); }
const original=helm('deploy/helm/guard-gateway-v2',false), disabled=helm(candidate,false), enabled=helm(candidate,true);
test('disabled candidate preserves the standard deployment and network objects',()=>{
  const scrub=objects=>objects.map(object=>{const copy=structuredClone(object);for(const container of copy.spec?.template?.spec?.containers??[])container.env=container.env.filter(entry=>entry.name!=='GATEWAY_SHADOW_EVALUATION_ENABLED');return copy;});
  assert.deepEqual(scrub(disabled),scrub(original));
});
test('enabled comparison has exactly one independent worker with strict resources and no ingress',()=>{
  const deployment=enabled.find(object=>object.kind==='Deployment'&&object.metadata.name==='guard-v2-shadow');assert.ok(deployment);assert.equal(deployment.spec.replicas,1);
  const pod=deployment.spec.template.spec,container=pod.containers[0];assert.deepEqual(container.command,['node','--import','tsx','scripts/gateway-shadow-worker.ts']);
  assert.ok(container.resources.limits.cpu&&container.resources.limits.memory);assert.equal(container.securityContext.readOnlyRootFilesystem,true);assert.equal(pod.automountServiceAccountToken,false);
  const network=enabled.find(object=>object.kind==='NetworkPolicy'&&object.metadata.name==='guard-v2-shadow');assert.deepEqual(network.spec.ingress,[]);
  assert.ok(network.spec.egress.every(rule=>rule.to&&!rule.to.some(peer=>peer.ipBlock?.cidr==='0.0.0.0/0')));
});
test('all control/worker roles agree on explicit enablement and existing proxy identity remains unchanged',()=>{
  for(const object of enabled.filter(object=>object.kind==='Deployment'))assert.equal(object.spec.template.spec.containers[0].env.find(entry=>entry.name==='GATEWAY_SHADOW_EVALUATION_ENABLED').value,'true');
  assert.deepEqual(enabled.find(object=>object.kind==='StatefulSet'),original.find(object=>object.kind==='StatefulSet'));
});
const hashes=Object.fromEntries(['values.yaml','templates/runtime.yaml','templates/network.yaml'].map(file=>[file,digest(readFileSync(path.join(candidate,file)))]));
writeFileSync('.artifact-build/upgrade-implementation-20260907/environment/shadow-chart-evidence.json',JSON.stringify({capturedAt:new Date().toISOString(),status:'PASS',candidate,hashes,kubernetesRuntimeTested:false,results},null,2));
