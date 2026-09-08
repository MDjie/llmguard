import { z } from 'zod';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const label='io.guardllm.acceptance.run';
const containerId=z.string().regex(/^[a-f0-9]{64}$/);
export const resiliencePlanSchema=z.object({
 version:z.literal('resilience-plan-1'),runId:z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/),
 seconds:z.number().int().min(1).max(86400),sampleIntervalMs:z.number().int().min(1000).max(60000),
 containers:z.array(containerId).min(1).max(20),
 faults:z.array(z.object({containerId,atMs:z.number().int().nonnegative(),durationMs:z.number().int().min(1000).max(60000),kind:z.literal('PAUSE')}).strict()).max(100),
}).strict().superRefine((plan,ctx)=>{
 if(new Set(plan.containers).size!==plan.containers.length)ctx.addIssue({code:'custom',message:'Duplicate container'});
 for(const fault of plan.faults)if(!plan.containers.includes(fault.containerId)||fault.atMs+fault.durationMs>=plan.seconds*1000)
  ctx.addIssue({code:'custom',message:'Fault outside measured interval'});
 const sorted=[...plan.faults].sort((a,b)=>a.atMs-b.atMs);
 if(sorted.some((f,i)=>i>0&&f.atMs<sorted[i-1].atMs+sorted[i-1].durationMs))ctx.addIssue({code:'custom',message:'Faults must not overlap'});
});
export type ResiliencePlan=z.infer<typeof resiliencePlanSchema>;
export type DockerCommand=(args:readonly string[])=>Promise<string>;
export const dockerCommand:DockerCommand=args=>new Promise((resolveCommand,reject)=>{
 execFile('docker',[...args],{windowsHide:true,timeout:15000,maxBuffer:1048576},(error,stdout)=>{
  if(error)reject(new Error('RESILIENCE_DOCKER_COMMAND_FAILED'));else resolveCommand(stdout);
 });
});
export async function inspectOwnedContainer(id:string,runId:string,command:DockerCommand){
 // Format exposes only identity, ownership and state, never the container environment.
 const text=await command(['inspect','--format','{{json .Id}} {{json .Config.Labels}} {{json .State.Running}} {{json .State.Paused}}',id]);
 const match=/^("[a-f0-9]{64}") (\{[^\r\n]*\}|null) (true|false) (true|false)\s*$/.exec(text);
 if(!match||JSON.parse(match[1])!==id)throw new Error('RESILIENCE_CONTAINER_IDENTITY_INVALID');
 const labels:unknown=JSON.parse(match[2]);
 if(!labels||typeof labels!=='object'||Reflect.get(labels,label)!==runId)throw new Error('RESILIENCE_CONTAINER_NOT_OWNED');
 return {running:match[3]==='true',paused:match[4]==='true'};
}
export function parseMemoryBytes(text:string){
 const match=/^([0-9]+(?:\.[0-9]+)?)\s*(B|kB|KB|MB|GB|KiB|MiB|GiB)$/.exec(text.trim());
 if(!match)throw new Error('RESILIENCE_MEMORY_FORMAT_INVALID');
 const unit:Record<string,number>={B:1,kB:1000,KB:1000,MB:1e6,GB:1e9,KiB:1024,MiB:1048576,GiB:1073741824};
 const bytes=Math.round(Number(match[1])*unit[match[2]]);
 if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error('RESILIENCE_MEMORY_FORMAT_INVALID');
 return bytes;
}
export async function captureContainerStats(plan:ResiliencePlan,command:DockerCommand){
 const raw=await command(['stats','--no-stream','--format','{{json .}}',...plan.containers]);
 const lines=raw.trim().split(/\r?\n/).filter(Boolean);
 const records=lines.map(line=>{
  const row=z.object({ID:z.string().regex(/^[a-f0-9]{12,64}$/),CPUPerc:z.string(),MemUsage:z.string(),PIDs:z.string()}).loose().parse(JSON.parse(line));
  const matches=plan.containers.filter(id=>id.startsWith(row.ID));if(matches.length!==1)throw new Error('RESILIENCE_STATS_IDENTITY_INVALID');
  const memory=row.MemUsage.split('/'),cpu=Number(row.CPUPerc.replace(/%$/,'')),pids=Number(row.PIDs);
  if(memory.length!==2||!row.CPUPerc.endsWith('%')||!Number.isFinite(cpu)||cpu<0||!Number.isSafeInteger(pids)||pids<0)throw new Error('RESILIENCE_STATS_VALUE_INVALID');
  return {containerId:matches[0],cpuPercent:cpu,memoryBytes:parseMemoryBytes(memory[0]),memoryLimitBytes:parseMemoryBytes(memory[1]),pids};
 });
 if(records.length!==plan.containers.length||new Set(records.map(r=>r.containerId)).size!==records.length)throw new Error('RESILIENCE_STATS_INCOMPLETE');
 return records;
}
export async function withPausedContainer(id:string,runId:string,during:()=>Promise<void>,command:DockerCommand=dockerCommand){
 const initial=await inspectOwnedContainer(id,runId,command);
 if(!initial.running||initial.paused)throw new Error('RESILIENCE_INITIAL_STATE_INVALID');
 let error:unknown;
 try{await command(['pause',id]);await during();}catch(caught){error=caught;}
 finally{
  // Even an ACK lost after pause must be reconciled; never resume by a reusable name.
  const current=await inspectOwnedContainer(id,runId,command);
  if(current.paused)await command(['unpause',id]);
  const restored=await inspectOwnedContainer(id,runId,command);
  if(!restored.running||restored.paused)throw new Error('RESILIENCE_RESTORE_FAILED');
 }
 if(error)throw error;
}
export async function runResilience(raw:unknown,output:string,signal:AbortSignal,command:DockerCommand=dockerCommand){
 const plan=resiliencePlanSchema.parse(raw),reportPath=resolve(output),seriesPath=reportPath+'.samples.jsonl';
 const reportHandle=await open(reportPath,'wx',0o600);
 const writer=await open(seriesPath,'wx',0o600).catch(async error=>{await reportHandle.close();throw error;});
 const startedAt=new Date().toISOString(),started=performance.now(),digest=createHash('sha256');
 let writtenBytes=0;
 const write=async(value:unknown)=>{const line=JSON.stringify(value)+'\n';writtenBytes+=Buffer.byteLength(line);if(writtenBytes>512*1048576)throw new Error('RESILIENCE_SAMPLE_STORAGE_BUDGET');await writer.writeFile(line);digest.update(line);};
 let samples=0,missing=0,next=0,stopped=false,faultFailure=false;
 const faults:{containerId:string;atMs:number;completed:boolean}[]=[];
 try{
  for(const id of plan.containers){const state=await inspectOwnedContainer(id,plan.runId,command);if(!state.running||state.paused)throw new Error('RESILIENCE_INITIAL_STATE_INVALID');}
  const schedule=[...plan.faults].sort((a,b)=>a.atMs-b.atMs);let faultIndex=0;
  while(performance.now()-started<plan.seconds*1000&&!signal.aborted){
   const elapsed=performance.now()-started,plannedFault=schedule[faultIndex];
   if(plannedFault&&elapsed>=plannedFault.atMs){
    const result={containerId:plannedFault.containerId,atMs:Math.round(elapsed),completed:false};faults.push(result);faultIndex++;
    try{await withPausedContainer(plannedFault.containerId,plan.runId,async()=>{
      const end=performance.now()+plannedFault.durationMs;
      while(performance.now()<end&&!signal.aborted){
        const values=await captureContainerStats(plan,command);samples++;await write({elapsedMs:Math.round(performance.now()-started),phase:'FAULT',values});
        await delay(Math.min(plan.sampleIntervalMs,Math.max(0,end-performance.now())),undefined,{signal}).catch(()=>{});
      }
      signal.throwIfAborted();
    },command);result.completed=true;}catch{faultFailure=true;if(!signal.aborted)throw new Error('RESILIENCE_FAULT_OR_RESTORE_FAILED');}
    await write({event:'fault',...result});next=performance.now()-started+plan.sampleIntervalMs;continue;
   }
   if(elapsed>=next){
    missing+=Math.max(0,Math.floor((elapsed-next)/plan.sampleIntervalMs));next=elapsed+plan.sampleIntervalMs;
    try{const values=await captureContainerStats(plan,command);samples++;await write({elapsedMs:Math.round(elapsed),phase:'BASELINE_OR_RECOVERY',values});}
    catch{missing++;await write({elapsedMs:Math.round(elapsed),errorCode:'RESOURCE_SAMPLE_UNAVAILABLE'});}
   }
   await delay(100,undefined,{signal}).catch(()=>{});
  }
  if(faultIndex!==schedule.length)faultFailure=true;
 }catch{stopped=true;}
 {
  stopped ||= signal.aborted;await writer.close();
  const elapsedSeconds=(performance.now()-started)/1000;
  const report={version:'resilience-run-1',runId:plan.runId,startedAt,completedAt:new Date().toISOString(),
   planDigest:createHash('sha256').update(JSON.stringify(plan)).digest('hex'),containers:plan.containers,requestedSeconds:plan.seconds,elapsedSeconds,
   samples,missing,stopped,faultFailure,faults,sampleSha256:digest.digest('hex'),
   engineeringStatus:stopped||faultFailure||missing||!samples?'INCOMPLETE':'CAPTURED',
   acceptanceStatus:'INSUFFICIENT_EVIDENCE',limitations:['BUSINESS_REQUEST_CORRELATION_REQUIRED','SIGNED_TARGET_DEPLOYMENT_REQUIRED',...(elapsedSeconds<86400?['24_HOURS_NOT_OBSERVED']:[])]};
  await reportHandle.writeFile(JSON.stringify(report,null,2));await reportHandle.close();
  return report;
 }
}
async function main(){
 const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--plan'||args[2]!=='--out')throw new Error('Use --plan <owned-test-container-plan.json> --out <new-report.json>');
 const bytes=await readFile(args[1]);if(bytes.length>1048576)throw new Error('RESILIENCE_PLAN_TOO_LARGE');
 const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
 const report=await runResilience(JSON.parse(bytes.toString('utf8')),args[3],controller.signal);
 console.log(JSON.stringify({engineeringStatus:report.engineeringStatus,acceptanceStatus:report.acceptanceStatus,samples:report.samples,missing:report.missing}));
 if(report.engineeringStatus!=='CAPTURED')process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('RESILIENCE_RUN_FAILED');process.exitCode=1;});
