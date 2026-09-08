import os from 'node:os';
import { inspectWorkerHealth } from './worker-health';
import { statfs } from 'node:fs/promises';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { sql } from 'drizzle-orm';

export function cpuCounters(cpus:readonly {times:{user:number;nice:number;sys:number;idle:number;irq:number}}[]) {
  return cpus.reduce((sum,cpu)=>({idle:sum.idle+cpu.times.idle,total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
}
export function cpuUsage(before:{idle:number;total:number},after:{idle:number;total:number}):number|null {
  const delta=after.total-before.total;
  return delta>0?Math.max(0,Math.min(100,100*(1-(after.idle-before.idle)/delta))):null;
}
const seriesSchema=z.object({metric:z.record(z.string(),z.string()),value:z.tuple([z.number(),z.string()])});
const prometheusSchema=z.object({status:z.literal('success'),data:z.object({resultType:z.literal('vector'),result:z.array(seriesSchema).max(1000)})});
const queries={
  cpu:'100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))',
  memory:'100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
  disk:'100 * (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"})',
  services:'up',
} as const;
async function prometheusMetrics() {
  if(!process.env.OPERATIONS_PROMETHEUS_URL)return {status:'unconfigured',message:'未配置集群监控数据源，当前仅展示本实例',groups:[]};
  try{
    const base=new URL(process.env.OPERATIONS_PROMETHEUS_URL);
    const allowed=(process.env.OPERATIONS_MONITOR_ALLOWED_HOSTS??'').split(',').map(value=>value.trim()).filter(Boolean);
    if(!['https:','http:'].includes(base.protocol)||base.username||base.password||!allowed.includes(base.hostname))throw new Error('MONITOR_ENDPOINT_NOT_ALLOWED');
    const groups=await Promise.all(Object.entries(queries).map(async([name,query])=>{
      try{
        const url=new URL('api/v1/query',base.href.replace(/\/?$/,'/'));url.searchParams.set('query',query);
        const response=await fetch(url,{signal:AbortSignal.timeout(3000),redirect:'error',cache:'no-store',headers:process.env.OPERATIONS_PROMETHEUS_TOKEN?{authorization:`Bearer ${process.env.OPERATIONS_PROMETHEUS_TOKEN}`}:{}});
        if(!response.ok)throw new Error();
        const reader=response.body?.getReader();if(!reader)throw new Error();
        let size=0;const chunks:Uint8Array[]=[];
        for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();throw new Error();}chunks.push(value);}
        const parsed=prometheusSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const rows=parsed.data.result.slice(0,100).map(item=>({labels:item.metric,value:Number.isFinite(Number(item.value[1]))?Number(item.value[1]):null,sampledAt:item.value[0],stale:Date.now()/1000-item.value[0]>120}));
        return {name,status:rows.length?'available':'empty',rows};
      }catch{return {name,status:'unavailable',rows:[]};}
    }));
    return {status:groups.some(group=>group.status!=='available')?'degraded':'available',message:'来自配置的Prometheus数据源，采样超过120秒标记为过期',groups};
  }catch{return {status:'unavailable',message:'监控数据源不可用，请检查允许的主机、连接和凭据',groups:[]};}
}
export async function inspectRuntime(){
  const workers = await inspectWorkerHealth();
  const before=cpuCounters(os.cpus());
  const [disk,database,cluster]=await Promise.all([
    statfs(process.cwd()).then(info=>({status:'available',totalBytes:info.blocks*info.bsize,availableBytes:info.bavail*info.bsize})).catch(()=>({status:'unavailable',totalBytes:null,availableBytes:null})),
    (async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([db.execute(sql`select 1`),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),2000);})]);return {name:'PostgreSQL',status:'healthy',message:'连接检查成功'};}catch{return {name:'PostgreSQL',status:'unavailable',message:'连接检查失败或超时'};}finally{if(timer)clearTimeout(timer);}})(),
    prometheusMetrics(),new Promise<void>(resolve=>setTimeout(resolve,120)),
  ]);
  return {sampledAt:new Date().toISOString(),site:process.env.GUARDLLM_SITE_ID??'未配置中心',instance:os.hostname(),scope:'当前进程可见主机资源；容器环境不代表整个集群',cpu:{count:os.cpus().length,usagePercent:cpuUsage(before,cpuCounters(os.cpus()))},memory:{totalBytes:os.totalmem(),availableBytes:os.freemem(),processRssBytes:process.memoryUsage().rss},disk,services:[{name:'应用进程',status:'healthy',message:`运行${Math.floor(process.uptime())}秒`},database,...workers],cluster};
}
