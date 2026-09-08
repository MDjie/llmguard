import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { dockerCommand,inspectOwnedContainer,runResilience } from '../acceptance/runtime-resilience';
async function main(){
 const runId='resilience-'+randomUUID(),ids:string[]=[];
 const directory=resolve('.artifact-build/v11-remaining-20260908');await mkdir(directory,{recursive:true});
 const image=execFileSync('docker',['image','inspect','--format','{{.Id}}','guardllm-r0-media-analyzer:latest'],{encoding:'utf8',windowsHide:true}).trim();assert.match(image,/^sha256:[a-f0-9]{64}$/);
 try{
  for(let i=0;i<2;i++){
   const id=await dockerCommand(['run','-d','--network','none','--read-only','--cpus','0.25','--memory','64m','--pids-limit','32','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--label','io.guardllm.acceptance.run='+runId,'--entrypoint','node',image,'-e','setInterval(()=>{},1000)']);
   assert.match(id.trim(),/^[a-f0-9]{64}$/);ids.push(id.trim());
  }
  const report=await runResilience({version:'resilience-plan-1',runId,seconds:14,sampleIntervalMs:4000,containers:ids,
   faults:[{containerId:ids[0],atMs:3000,durationMs:2000,kind:'PAUSE'}]},resolve(directory,runId+'.json'),new AbortController().signal);
  assert.equal(report.engineeringStatus,'CAPTURED');assert.equal(report.faults.length,1);assert.equal(report.faults[0].completed,true);
  assert.equal(report.acceptanceStatus,'INSUFFICIENT_EVIDENCE');assert.ok(report.samples>=2);
  for(const id of ids)assert.deepEqual(await inspectOwnedContainer(id,runId,dockerCommand),{running:true,paused:false});
  console.log('PASS real owned-container pause, resource capture and recovery; not gateway HA or 24-hour acceptance');
 }finally{
  for(const id of ids){
   await inspectOwnedContainer(id,runId,dockerCommand);
   await dockerCommand(['rm','-f',id]);
  }
 }
}
main().catch(()=>{console.error('RESILIENCE_INTEGRATION_FAILED');process.exitCode=1;});
