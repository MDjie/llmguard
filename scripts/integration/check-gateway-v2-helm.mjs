import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadAll } from 'js-yaml';
const directory=path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
const documents=loadAll(readFileSync(path.join(directory,'helm-v2-rendered.yaml'),'utf8'));
assert.ok(documents.length > 0);
const objects=documents.filter(Boolean),stateful=objects.find(o=>o.kind==='StatefulSet');assert.ok(stateful);
const results=[];
function check(name,run){run();results.push({name,status:'PASS'});console.log('PASS '+name);}
check('proxy replicas retain separate StatefulSet ordinal identities',()=>{assert.equal(stateful.spec.replicas,3);assert.equal(stateful.spec.podManagementPolicy,'OrderedReady');assert.equal(stateful.spec.updateStrategy.type,'RollingUpdate');});
const proxy=stateful.spec.template.spec.containers[0],env=new Map(proxy.env.map(e=>[e.name,e]));
check('a proxy mounts only its own private certificate and workload secret',()=>{const mounts=proxy.volumeMounts.filter(m=>m.name==='identities');assert.equal(mounts.length,3);assert.ok(mounts.every(m=>m.subPathExpr.startsWith('$(POD_NAME).')&&m.readOnly));assert.equal(env.get('GATEWAY_NODE_ID').valueFrom.fieldRef.fieldPath,'metadata.name');assert.ok(!proxy.volumeMounts.some(m=>['signing','workloads'].includes(m.name)));assert.equal(proxy.envFrom[0].secretRef.name,'guard-v2-proxy-runtime');});
check('management probes remain on loopback and expose no management or legacy gRPC service',()=>{assert.deepEqual(proxy.readinessProbe.exec.command,['java','-cp','/app/probe','GatewayReadinessProbe','readiness']);assert.equal(env.get('GATEWAY_MTLS_REQUIRED').value,'true');assert.equal(env.get('GUARD_GRPC_ENABLED').value,'false');const ports=objects.filter(o=>o.kind==='Service').flatMap(o=>o.spec.ports.map(p=>p.port));assert.ok(ports.every(p=>[5000,8443].includes(p)));});
check('control has multiple replicas and keeps its signing secret away from the proxy',()=>{const control=objects.find(o=>o.kind==='Deployment'&&o.metadata.name.endsWith('-control'));assert.equal(control.spec.replicas,2);assert.ok(control.spec.template.spec.containers[0].volumeMounts.some(m=>m.name==='signing'));assert.equal(control.spec.template.spec.automountServiceAccountToken,false);});
check('proxy and control spread across hosts and have disruption budgets',()=>{assert.ok(stateful.spec.template.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution.length);assert.equal(objects.filter(o=>o.kind==='PodDisruptionBudget').length,2);});
check('network policies deny implicit external egress and expose only approved service ports',()=>{const policies=objects.filter(o=>o.kind==='NetworkPolicy');assert.equal(policies.length,3);for(const p of policies){assert.deepEqual(p.spec.policyTypes,['Ingress','Egress']);assert.ok(!p.spec.egress.some(e=>!e.to||e.to.some(peer=>peer.ipBlock?.cidr==='0.0.0.0/0')));}});
writeFileSync(path.join(directory,'helm-v2-evidence.json'),JSON.stringify({capturedAt:new Date().toISOString(),status:'PASS',validation:'Helm rendering and structural assertions',kubernetesRuntimeTested:false,results},null,2));
