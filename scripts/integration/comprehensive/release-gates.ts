import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash}from'node:crypto';
import {evaluateMultiformatQuality}from'../../../src/lib/evaluation/multiformat-quality';
const out=process.env.COMPREHENSIVE_RUN_DIR!;
const identityPath=out+'/source-identity.json';const identity=existsSync(identityPath)?JSON.parse(readFileSync(identityPath,'utf8')):null;
const independent=process.env.COMPREHENSIVE_INDEPENDENT_CASES,development=process.env.COMPREHENSIVE_DEVELOPMENT_MANIFEST;
let report:ReturnType<typeof evaluateMultiformatQuality>|null=null;
if(independent&&development){const rows=readFileSync(independent,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as unknown);const dev=JSON.parse(readFileSync(development,'utf8')) as {sourceSha256:string[];lineageSha256:string[]};report=evaluateMultiformatQuality(rows,dev.sourceSha256,dev.lineageSha256);}
const blockers:string[]=[];
if(!identity)blockers.push('FROZEN_SOURCE_IDENTITY_REQUIRED');if(!independent||!development)blockers.push('DOUBLE_REVIEWED_INDEPENDENT_HOLDOUT_AND_DEVELOPMENT_LINEAGE_REQUIRED');
const readiness=existsSync(out+'/readiness.json')?JSON.parse(readFileSync(out+'/readiness.json','utf8')) as {productionQualified:boolean}:null;
if(!readiness?.productionQualified)blockers.push('EXACT_ASR_VLM_AUDIO_CLASSIFIER_JOINT_MODEL_QUALIFICATION_REQUIRED');
if(report&&report.status!=='PASS')blockers.push(...report.reasons);
const manifest=JSON.parse(readFileSync('输出/代码分析与升级/32_supplemental-repair.tasks.v1.json','utf8')) as {repairs:Array<{id:string;title:string;status:string}>};
const developmentDependencies=manifest.repairs.filter(task=>['R04','R05','R06','R07','R08','R09','R10','R11','R12'].includes(task.id)&&task.status!=='COMPLETED').map(task=>({id:task.id,title:task.title,status:task.status,acceptance:'REQUIRES_SEPARATE_EVIDENCE; upload acceptance does not close this dependency'}));
const status=blockers.length||developmentDependencies.length?'BLOCKED':report?.status??'BLOCKED';
writeFileSync(out+'/release-gates.json',JSON.stringify({status,sourceIdentitySha256:identity?createHash('sha256').update(JSON.stringify(identity)).digest('hex'):null,blockers,developmentDependencies,thresholds:{fprUpper95:0.01,fdrUpper95:0.1,recallLower95:0.95,accuracyLower95:0.95,fnrMaximum:0.05},quality:report,syntheticCasesUsedForQuality:false,baselineStarted:Boolean(report),productionDeployAllowed:status==='PASS'},null,2));
console.log(JSON.stringify({status,blockers,unfinishedDependencies:developmentDependencies.map(t=>t.id),baselineStarted:Boolean(report)}));if(status!=='PASS')process.exitCode=2;
