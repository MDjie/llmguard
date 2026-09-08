import { spawn,spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,readdirSync,existsSync,openSync,closeSync } from 'node:fs';
import {resolve,relative}from'node:path';import{createHash}from'node:crypto';import net from'node:net';
const [source,directory]=process.argv.slice(2);if(!source||!directory)throw new Error('Usage: pnpm test:comprehensive <private-environment-source> <new-directory>');
const out=resolve(directory),steps=[];let ready=false,initialized=false;
if(existsSync(out))throw new Error('RUN_ALREADY_EXISTS');
const fileHash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const collect=(dir)=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?collect(dir+'/'+e.name):[dir+'/'+e.name]);
async function command(id,args,options={}){
 console.log('STEP '+id);const started=new Date().toISOString();const fd=existsSync(out)?openSync(out+'/'+id+'.private.log','a'):null;
 const child=spawn(options.program??process.execPath,args,{env:{...process.env,...options.env},windowsHide:true,stdio:fd===null?'inherit':['ignore',fd,fd]});const heartbeat=setInterval(()=>console.log('RUNNING '+id),30000);
 const exitCode=await new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('exit',code=>resolve(code??1));});clearInterval(heartbeat);if(fd!==null)closeSync(fd);
 const status=exitCode===0?'PASS':exitCode===2&&options.allowBlocked?'BLOCKED':'FAIL';steps.push({id,status,exitCode,started,finished:new Date().toISOString()});if(existsSync(out))writeFileSync(out+'/commands.json',JSON.stringify({steps},null,2));console.log(JSON.stringify(steps.at(-1)));return status==='PASS';
}
const envRun=(mode,...args)=>['scripts/integration/comprehensive/run-with-env.mjs',out,mode,...args];
try{
 for(const port of[58089,59090])await new Promise((done,fail)=>{const s=net.createServer();s.once('error',()=>fail(new Error('PORT_IN_USE_'+port)));s.listen(port,'127.0.0.1',()=>s.close(done));});
 if(!await command('initialize',['scripts/integration/comprehensive/initialize.mjs',source,out]))throw new Error('INITIALIZATION_FAILED');initialized=true;
 const files=[...collect('src'),...collect('scripts'),...collect('tests'),...collect('drizzle'),...collect('services/media-analyzer/src'),'package.json','pnpm-lock.yaml','next.config.ts','services/media-analyzer/tsup.config.ts','playwright.comprehensive.config.ts','vitest.config.mts'].filter(p=>/\.(ts|tsx|mts|js|mjs|json|sql|yaml|py)$/.test(p)).sort().map(path=>({path,sha256:fileHash(path)}));
 const head=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).stdout.trim();writeFileSync(out+'/source-identity.json',JSON.stringify({head,workingTree:true,sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),files,node:process.version,analyzerImage:process.env.COMPREHENSIVE_ANALYZER_IMAGE},null,2));
 const pages=collect('src/app').filter(p=>p.endsWith('/page.tsx')).map(p=>'/'+relative('src/app',p).replaceAll('\\','/').replace(/\/page.tsx$/,''));const routes=collect('src/app/api').filter(p=>p.endsWith('/route.ts')).map(p=>({path:'/api/'+relative('src/app/api',p).replaceAll('\\','/').replace(/\/route.ts$/,''),methods:[...readFileSync(p,'utf8').matchAll(/export const (GET|POST|PUT|PATCH|DELETE)/g)].map(m=>m[1])}));writeFileSync(out+'/surface-inventory.json',JSON.stringify({pages,routes,coverage:'OBSERVED_REQUESTS_ARE_NOT_EXHAUSTIVE_ROUTE_COVERAGE'},null,2));
 if(!await command('database',['scripts/integration/comprehensive/schema-check.mjs',out]))throw new Error('SCHEMA_REQUIRED');
 if(!await command('fixture',envRun('tsx','scripts/integration/comprehensive/prepare.ts')))throw new Error('FIXTURE_REQUIRED');
 if(!await command('analyzer-build',['node_modules/tsup/dist/cli-default.js','--config','services/media-analyzer/tsup.config.ts']))throw new Error('ANALYZER_BUILD_REQUIRED');
 if(!await command('provision',['scripts/integration/comprehensive/provision.mjs',out]))throw new Error('PROVISION_REQUIRED');
 if(!await command('build',envRun('next','build')))throw new Error('BUILD_REQUIRED');
 await command('unit',['node_modules/vitest/vitest.mjs','run','--reporter=json','--outputFile='+out+'/unit-results.json']);
 if(!await command('start',['scripts/integration/comprehensive/start.mjs',out]))throw new Error('START_REQUIRED');ready=true;
 for(let n=0;n<60;n++){try{if((await fetch('http://127.0.0.1:58089/api/health/db')).status===200)break;}catch{}if(n===59)throw new Error('HEALTH_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,1000));}
 await command('schema-parity',envRun('tsx','scripts/integration/comprehensive/schema-parity.ts',out));
 await command('policy-mutations',envRun('tsx','scripts/integration/comprehensive/policy-mutations.ts'));
 await command('trace-fixture',envRun('tsx','scripts/integration/comprehensive/trace-fixture.ts'));
 await command('format-fixture',['scripts/integration/multiformat/generate-fixtures.py',out+'/format-fixtures'],{program:process.env.COMPREHENSIVE_PYTHON??'python'});
 await command('format-generate',['scripts/integration/comprehensive/generate-media.mjs',out]);
 await command('crawl',['scripts/integration/comprehensive/crawl.mjs',out]);
 const common={REUSE_SESSION:'1'};
 await command('journeys',['scripts/integration/comprehensive/journeys.mjs',out],{env:{...common,JOURNEY_IDS:'J02,J03,J04,J05,J06,J07,J08,J09,J10,J11,J12,J13,J14,J15,J16,J17'}});
 await command('repair-workflows',['scripts/integration/comprehensive/repair-workflows.mjs',out]);
 await command('extended',['scripts/integration/comprehensive/extended-journeys.mjs',out],{env:{...common,JOURNEY_IDS:'J19,J20,J21,J22,J23,J24,J25,J26',JOURNEY_OUTPUT:'extended'}});
 await command('diagnostics',['scripts/integration/comprehensive/diagnostics.mjs',out],{env:{...common,JOURNEY_IDS:'J27,J28,J29,J30',JOURNEY_OUTPUT:'diagnostics'}});
 await command('final',['scripts/integration/comprehensive/final-journeys.mjs',out],{env:{...common,JOURNEY_OUTPUT:'final'}});
 await command('evidence-workflow',['scripts/integration/comprehensive/evidence-workflow.mjs',out]);
 await command('security',envRun('tsx','scripts/integration/comprehensive/security.ts',out));
 await command('uploads',envRun('tsx','scripts/integration/multiformat/upload-matrix.ts',out));
 await command('media-stages',['scripts/integration/comprehensive/media-stages.mjs',out],{allowBlocked:true});
 await command('layered-evidence',envRun('tsx','scripts/integration/comprehensive/layered-evidence.ts'));
 await command('data-audit',envRun('tsx','scripts/integration/comprehensive/data-audit.ts'));
 await command('archive-boundaries',envRun('tsx','scripts/integration/comprehensive/archive-boundaries.ts'));
 await command('auth-workflows',['scripts/integration/comprehensive/auth-workflows.mjs',out]);
 await command('single-audit',['scripts/integration/comprehensive/single-audit.mjs',out]);
 await command('health-recovery',['scripts/integration/comprehensive/health-recovery.mjs',out]);
 await command('release-gates',envRun('tsx','scripts/integration/comprehensive/release-gates.ts'),{allowBlocked:true});
}catch(e){steps.push({id:'runner',status:'FAIL',message:e.message});process.exitCode=1;console.error(JSON.stringify(steps.at(-1)));if(!initialized)writeFileSync(resolve('.artifact-build','comprehensive-preflight-'+Date.now()+'.json'),JSON.stringify({status:'FAIL',requestedDirectory:out,steps},null,2));}
finally{if(initialized){await command('cleanup',['scripts/integration/comprehensive/stop.mjs',out]);writeFileSync(out+'/commands.json',JSON.stringify({steps},null,2));const status=steps.some(x=>x.status==='FAIL')?'FAIL':steps.some(x=>x.status==='BLOCKED')?'BLOCKED':'PASS';writeFileSync(out+'/run-result.json',JSON.stringify({status,coldRun:true,steps,engineeringScope:'SYNTHETIC_REAL_BROWSER_HTTP_DB_OBJECT_STORE',semanticQualification:'SEPARATE_GATE',startedServices:ready},null,2));process.exitCode=status==='FAIL'?1:status==='BLOCKED'?2:0;if(!await command('aggregate',['scripts/integration/comprehensive/aggregate.mjs',out+'/aggregate.json',out])){process.exitCode=1;writeFileSync(out+'/run-result.json',JSON.stringify({status:'FAIL',coldRun:true,steps,engineeringScope:'SYNTHETIC_REAL_BROWSER_HTTP_DB_OBJECT_STORE',semanticQualification:'SEPARATE_GATE',startedServices:ready},null,2));}console.log('COMPREHENSIVE_RESULT '+status);}}
