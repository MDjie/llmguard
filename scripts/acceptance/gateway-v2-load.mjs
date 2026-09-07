import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { platform, arch, cpus, totalmem } from 'node:os';

const options=Object.fromEntries(process.argv.slice(2).map((arg,i,all)=>arg.startsWith('--')?[arg.slice(2),all[i+1]]:null).filter(Boolean));
const environmentFile=options.environment,output=options.output,profileId=options.profile??'G1';
if(!environmentFile||!output)throw new Error('Use --environment <private JSON> --output <report.json> --profile G0|G1|G2');
const profilesRaw=readFileSync(path.resolve(import.meta.dirname,'../../acceptance/gateway-v2/performance-profiles.json'),'utf8'),profiles=JSON.parse(profilesRaw),profile=profiles.profiles[profileId];
if(!profile||profileId==='SSE')throw new Error('The business-response runner supports G0/G1/G2; SSE requires the streaming runner');
const env=JSON.parse(readFileSync(environmentFile,'utf8'));
const endpoint=new URL(env.endpoint);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('FIXED_HTTPS_ENDPOINT_REQUIRED');
const duration=Number(options.seconds??60),targetRps=Number(options.rps??profile.rps),concurrency=Number(options.concurrency??profile.concurrency);
if(!Number.isFinite(duration)||duration<1||duration>86400||!Number.isFinite(targetRps)||targetRps<0.1||targetRps>10000||!Number.isInteger(concurrency)||concurrency<1||concurrency>10000)throw new Error('LOAD_BUDGET_INVALID');
if(typeof env.apiKey!=='string'||!env.apiKey||!env.model||!env.caFile||!env.certificateFile||!env.keyFile)throw new Error('PRIVATE_CLIENT_CONFIGURATION_REQUIRED');
const sha=value=>createHash('sha256').update(value).digest('hex');
const agent=new https.Agent({keepAlive:true,maxSockets:concurrency,maxFreeSockets:concurrency,ca:readFileSync(env.caFile),cert:readFileSync(env.certificateFile),key:readFileSync(env.keyFile),rejectUnauthorized:true});
const sampleFile=path.resolve(output+'.samples.jsonl'),sampleWriter=createWriteStream(sampleFile,{flags:'wx',highWaterMark:262144});
let sampleBackpressure=false,sampleFailure=false;sampleWriter.on('drain',()=>{sampleBackpressure=false;});sampleWriter.on('error',()=>{sampleFailure=true;stopping=true;});
const histogram=new Float64Array(120001);let sum=0,count=0,maximum=0,started=0,completed=0,rejected=0,failed=0,omitted=0,wrongOutputSize=0,inFlight=0,peakInFlight=0,stopping=false;
const statuses={},actions={},requests=new Map();
function latency(ms){const index=Math.min(histogram.length-1,Math.ceil(ms));histogram[index]++;sum+=ms;count++;maximum=Math.max(maximum,ms);}
function quantile(q){let seen=0;for(let i=0;i<histogram.length;i++){seen+=histogram[i];if(seen>=Math.ceil(count*q))return i;}return null;}
const startedAt=new Date(),t0=performance.now();
function dispatch(){
  const requestId=randomUUID(),tag='GATEWAY_BENCHMARK '+profileId+' '+requestId+' ',text=tag+'x'.repeat(Math.max(0,profile.inputBytes-Buffer.byteLength(tag)));
  const body=JSON.stringify({model:env.model,stream:false,messages:[{role:'user',content:text}]}),begin=performance.now();started++;inFlight++;peakInFlight=Math.max(peakInFlight,inFlight);
  const promise=new Promise(resolve=>{
    let settled=false,classification='FAILED',responseStatus=0,responseAction='UNKNOWN';const finish=()=>{if(settled)return;settled=true;const sample={requestId,elapsedMs:performance.now()-begin,outcome:classification,status:responseStatus,action:responseAction};if(!sampleFailure&&!sampleWriter.write(JSON.stringify(sample)+'\n'))sampleBackpressure=true;inFlight--;resolve();};
    const req=https.request(endpoint,{agent,method:'POST',signal:AbortSignal.timeout(65000),headers:{authorization:'Bearer '+env.apiKey,'content-type':'application/json','content-length':Buffer.byteLength(body),'x-request-id':requestId,'idempotency-key':requestId}},response=>{
      const buffers=[];let bytes=0;response.on('data',buffer=>{bytes+=buffer.length;if(bytes>4194304)response.destroy(new Error('RESPONSE_BUDGET_EXCEEDED'));else buffers.push(buffer);});response.on('error',()=>{if(!settled)failed++;finish();});
      response.on('end',()=>{
        if(settled)return;const status=response.statusCode??0;responseStatus=status;statuses[status]=(statuses[status]??0)+1;
        const action=String(response.headers['x-guard-output-action']??'UNKNOWN');actions[action]=(actions[action]??0)+1;responseAction=action;
        if(status===200){try{const value=JSON.parse(Buffer.concat(buffers).toString('utf8')),choice=value.choices?.[0];if(!choice||typeof choice.message?.content!=='string'||!['stop','length','content_filter'].includes(choice.finish_reason))throw new Error();
          if(['stop','length'].includes(choice.finish_reason)&&['ALLOW','WARN'].includes(action)){classification='COMPLETED';completed++;latency(performance.now()-begin);if(Buffer.byteLength(choice.message.content)!==profile.outputBytes)wrongOutputSize++;}else {classification='DENIED';rejected++;}
        }catch{failed++;}}else if([400,401,403,409,413,422,429].includes(status)){classification='DENIED';rejected++;}else failed++;
        finish();
      });
    });req.on('error',()=>{if(!settled)failed++;finish();});req.end(body);
  });requests.set(requestId,promise);promise.finally(()=>requests.delete(requestId));
}
process.once('SIGINT',()=>{stopping=true;});process.once('SIGTERM',()=>{stopping=true;});
let arrivals=0;
while(!stopping&&performance.now()-t0<duration*1000){
  const due=Math.floor((performance.now()-t0)*targetRps/1000)+1;
  while(arrivals<due){arrivals++;if(inFlight<concurrency&&!sampleBackpressure&&!sampleFailure)dispatch();else omitted++;}
  await new Promise(resolve=>setTimeout(resolve,1));
}
await Promise.allSettled([...requests.values()]);const elapsed=(performance.now()-t0)/1000;agent.destroy();if(!sampleFailure)await new Promise((resolve,reject)=>{sampleWriter.once('error',reject);sampleWriter.end(resolve);});
const limitations=['TARGET_HARDWARE_AND_FROZEN_POLICY_NOT_ATTESTED','UPSTREAM_TIMING_JOIN_REQUIRED','THREE_ACCEPTANCE_ROUNDS_REQUIRED'];
if(duration<profiles.measurement.minimumDurationSeconds)limitations.push('DURATION_BELOW_ACCEPTANCE_MINIMUM');
if(wrongOutputSize)limitations.push('UPSTREAM_OUTPUT_SIZE_MISMATCH');
if(targetRps!==profile.rps||concurrency!==profile.concurrency)limitations.push('ENGINEERING_LOAD_OVERRIDE');
if(stopping)limitations.push('INTERRUPTED');if(sampleFailure)limitations.push('SAMPLE_STORAGE_FAILED');
const report={version:'1.0',profile:profileId,profileManifestSha256:sha(profilesRaw),startedAt:startedAt.toISOString(),capturedAt:new Date().toISOString(),
  sampleFile,sampleStorageFailed:sampleFailure,evidenceKind:'ENGINEERING',acceptanceStatus:'INSUFFICIENT_EVIDENCE',limitations,targetVersion:env.targetVersion??null,targetConfigurationDigest:env.configurationDigest??null,
  loadGenerator:{platform:platform(),architecture:arch(),cpuModel:cpus()[0]?.model??null,logicalCpus:cpus().length,totalMemoryBytes:totalmem()},requestedSeconds:duration,elapsedSeconds:elapsed,targetRps,concurrency,
  arrivals,started,completed,rejected,failed,omitted,peakInFlight,successfulRps:completed/elapsed,completionRate:arrivals?completed/arrivals:0,statuses,actions,wrongOutputSize,
  latency:{scope:'client end-to-end',precision:'histogram ceil to 1ms; last bucket is overflow',p50Ms:count?quantile(.5):null,p95Ms:count?quantile(.95):null,p99Ms:count?quantile(.99):null,meanMs:count?sum/count:null,maxMs:count?maximum:null},gatewayAddedLatency:null};
writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({report:path.resolve(output),completed,rejected,failed,omitted,successfulRps:report.successfulRps,acceptanceStatus:report.acceptanceStatus}));
if(failed||omitted||stopping)process.exitCode=1;
