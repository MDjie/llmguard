import { createReadStream, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const options=Object.fromEntries(process.argv.slice(2).map((arg,i,all)=>arg.startsWith('--')?[arg.slice(2),all[i+1]]:null).filter(Boolean));
if(!options.report||!options.upstream||!options.output)throw new Error('Use --report <load.json> --upstream <timings.jsonl> --output <new joined-report.json>');
const report=JSON.parse(readFileSync(options.report,'utf8')),spool=path.resolve(options.output+'.join.sqlite');
closeSync(openSync(spool,'wx'));
const db=new DatabaseSync(spool);db.exec('CREATE TABLE client(id TEXT PRIMARY KEY, ms REAL NOT NULL, outcome TEXT NOT NULL); CREATE TABLE upstream(id TEXT PRIMARY KEY, ms REAL NOT NULL);');
const insertClient=db.prepare('INSERT INTO client VALUES(?,?,?)'),insertUpstream=db.prepare('INSERT INTO upstream VALUES(?,?)');
async function ingest(file,client){
  const hash=createHash('sha256'),stream=createReadStream(file),decoder=new TextDecoder('utf-8',{fatal:true});let pending='',count=0;db.exec('BEGIN');
  function row(line){
    if(!line.trim())return;if(line.length>2048)throw new Error('TIMING_RECORD_TOO_LARGE');const record=JSON.parse(line);
    if(typeof record.requestId!=='string'||!/^[-_a-zA-Z0-9]{1,128}$/.test(record.requestId)||typeof record.elapsedMs!=='number'||!Number.isFinite(record.elapsedMs)||record.elapsedMs<0||record.elapsedMs>120000)throw new Error('TIMING_RECORD_INVALID');
    if(client){if(!['COMPLETED','DENIED','FAILED'].includes(record.outcome))throw new Error('TIMING_OUTCOME_INVALID');insertClient.run(record.requestId,record.elapsedMs,record.outcome);}else insertUpstream.run(record.requestId,record.elapsedMs);
    count++;if(count%2000===0){db.exec('COMMIT');db.exec('BEGIN');}
  }
  try{for await(const chunk of stream){hash.update(chunk);pending+=decoder.decode(chunk,{stream:true});let end;while((end=pending.indexOf('\n'))>=0){row(pending.slice(0,end));pending=pending.slice(end+1);}if(pending.length>2048)throw new Error('TIMING_RECORD_TOO_LARGE');}
    pending+=decoder.decode();if(pending)row(pending);db.exec('COMMIT');return{count,sha256:hash.digest('hex')};
  }catch(error){db.exec('ROLLBACK');throw error;}finally{stream.destroy();}
}

try{
  const client=await ingest(report.sampleFile,true),upstream=await ingest(options.upstream,false);const clientCount=client.count,upstreamCount=upstream.count;
  if(clientCount!==report.started||report.started!==report.completed+report.rejected+report.failed)throw new Error('LOAD_REPORT_COUNT_MISMATCH');
  const outcomes=Object.fromEntries(db.prepare('SELECT outcome,count(*) n FROM client GROUP BY outcome').all().map(row=>[row.outcome,row.n]));
  if((outcomes.COMPLETED??0)!==report.completed||(outcomes.DENIED??0)!==report.rejected||(outcomes.FAILED??0)!==report.failed)throw new Error('LOAD_REPORT_OUTCOME_MISMATCH');
  const histogram=new Float64Array(120001);let count=0,sum=0,maximum=0;
  for(const row of db.prepare("SELECT c.ms clientMs,u.ms upstreamMs FROM client c LEFT JOIN upstream u ON c.id=u.id WHERE c.outcome='COMPLETED'").iterate()){
    if(typeof row.upstreamMs!=='number'||row.upstreamMs>row.clientMs)throw new Error('MATCHING_UPSTREAM_DURATION_REQUIRED');
    const added=row.clientMs-row.upstreamMs;histogram[Math.min(120000,Math.ceil(added))]++;count++;sum+=added;maximum=Math.max(maximum,added);
  }
  if(count!==report.completed||count===0)throw new Error('SUCCESSFUL_TIMING_EVIDENCE_REQUIRED');
  function q(value){let total=0;for(let i=0;i<histogram.length;i++){total+=histogram[i];if(total>=Math.ceil(count*value))return i;}return null;}
  const joined={...report,limitations:report.limitations.filter(code=>code!=='UPSTREAM_TIMING_JOIN_REQUIRED'),
    gatewayAddedLatency:{method:'individual matched client duration minus upstream processing; 1ms histogram ceiling',matchedRequests:count,p50Ms:q(.5),p95Ms:q(.95),p99Ms:q(.99),meanMs:sum/count,maxMs:maximum},
    timingJoin:{clientCount,upstreamCount,clientSha256:client.sha256,upstreamSha256:upstream.sha256,unmatchedSuccessfulRequests:0,duplicateIdsAllowed:false}};
  writeFileSync(options.output,JSON.stringify(joined,null,2),{flag:'wx'});console.log(JSON.stringify({output:path.resolve(options.output),matched:count,gatewayAddedP99Ms:joined.gatewayAddedLatency.p99Ms,acceptanceStatus:joined.acceptanceStatus}));
}finally{db.close();}
