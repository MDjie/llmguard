import { createHash } from 'node:crypto';
import { existsSync,readFileSync,writeFileSync,statSync } from 'node:fs';
import { resolve,relative,isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifySignedEvidence } from './evidence.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
function readJson(file){if(statSync(file).size>16*1048576)throw new Error('READINESS_FILE_TOO_LARGE');return JSON.parse(readFileSync(file,'utf8'));}
export function validateWeights(weights,pocs){
 if(!weights||typeof weights!=='object'||Array.isArray(weights)||Object.keys(weights).length!==pocs.length||
  pocs.some(p=>typeof weights[p.id]!=='number'||!Number.isFinite(weights[p.id])||weights[p.id]<=0)||
  Math.abs(Object.values(weights).reduce((sum,n)=>sum+n,0)-100)>0.000001)throw new Error('POC_WEIGHTS_MUST_COVER_ALL_CASES_AND_SUM_TO_100');
 return weights;
}
export function scorePocs(pocs,weights,statuses){
 if(!weights)return {status:'WEIGHTS_NOT_FROZEN',awardedLowerBound:null,unverifiedWeight:null};
 validateWeights(weights,pocs);
 let awardedLowerBound=0,unverifiedWeight=0;
 for(const poc of pocs){if(statuses[poc.id]==='VERIFIED_PASS')awardedLowerBound+=weights[poc.id];else unverifiedWeight+=weights[poc.id];}
 return {status:unverifiedWeight?'INCOMPLETE':'VERIFIED',awardedLowerBound,unverifiedWeight};
}
export function collectReadiness({root=process.cwd(),sourceCommit,evidence={},publicKey,weights,verify=verifySignedEvidence}){
 if(!/^[a-f0-9]{40}$/.test(sourceCommit??''))throw new Error('READINESS_SOURCE_COMMIT_REQUIRED');
 const manifest=readJson(resolve(root,'acceptance/incremental-v11/manifest.json'));
 if(manifest.schemaVersion!=='1.0'||manifest.targetJointModel!=='glm-5.3'||!Array.isArray(manifest.items)||
  new Set(manifest.items.map(item=>item.id)).size!==manifest.items.length)throw new Error('READINESS_MANIFEST_INVALID');
 const files=new Map(),statuses=new Map();
 const computeStatus=id=>{
  if(!evidence[id])return 'PENDING_EVIDENCE';
  if(!publicKey)return 'SIGNATURE_KEY_MISSING';
  try{const result=verify(resolve(root,evidence[id]),id,publicKey);
   if(result.report.bindings.sourceCommit!==sourceCommit)return 'SOURCE_MISMATCH';
   return 'VERIFIED_PASS';
  }catch{return 'INVALID_EVIDENCE';}
 };
 const statusFor=id=>{if(!statuses.has(id))statuses.set(id,computeStatus(id));return statuses.get(id);};
 const items=manifest.items.map(item=>{
  if(!['IMPLEMENTED','PARTIAL'].includes(item.implementationStatus)||!item.code?.length||!item.tests?.length||!item.blockingInputs?.length)throw new Error('READINESS_ITEM_INVALID');
  for(const file of [...item.code,...item.tests]){
   const target=resolve(root,file),rel=relative(resolve(root),target);
   if(isAbsolute(file)||rel.startsWith('..')||isAbsolute(rel)||!existsSync(target)||!statSync(target).isFile())throw new Error('READINESS_REFERENCED_FILE_MISSING');
   files.set(file,sha(readFileSync(target)));
  }
  const acceptanceStatus=statusFor(item.id);
  return {...item,acceptanceStatus:item.implementationStatus==='PARTIAL'&&acceptanceStatus==='VERIFIED_PASS'?'IMPLEMENTATION_INCOMPLETE':acceptanceStatus};
 });
 const requirements=readJson(resolve(root,'acceptance/generated/requirements.json')).requirements;
 const pocs=readJson(resolve(root,'acceptance/poc-manifest.json')).pocs;
 const pocStatuses=Object.fromEntries(pocs.map(poc=>[poc.id,statusFor(poc.id)]));
 const sourceFiles=[...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256}));
 return {version:'v11-readiness-1',sourceCommit,sourceFiles,sourceDigest:sha(JSON.stringify(sourceFiles)),
  digestAlgorithm:'sha256 over ordered file paths and raw-byte sha256 values; not a deployment signature',
  targetJointModel:manifest.targetJointModel,items,
  originalRequirements:requirements.map(row=>({id:row.id,upgradeRequirement:row.upgradeRequirement,acceptanceStatus:statusFor(row.id)})),
  pocStatuses,pocScore:scorePocs(pocs,weights,pocStatuses),
  acceptanceStatus:items.every(item=>item.acceptanceStatus==='VERIFIED_PASS')&&requirements.every(row=>statusFor(row.id)==='VERIFIED_PASS')&&
    pocs.every(poc=>pocStatuses[poc.id]==='VERIFIED_PASS')&&weights?'VERIFIED':'INCOMPLETE'};
}
function main(){
 const args=process.argv.slice(2),values={};
 for(let i=0;i<args.length;i+=2){if(!['--out','--evidence','--key','--weights'].includes(args[i])||!args[i+1]||Object.hasOwn(values,args[i]))throw new Error('READINESS_ARGUMENT_INVALID');values[args[i]]=args[i+1];}
 if(!values['--out'])throw new Error('READINESS_OUTPUT_REQUIRED');
 const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
 const result=collectReadiness({sourceCommit,evidence:values['--evidence']?readJson(values['--evidence']):{},publicKey:values['--key'],weights:values['--weights']?readJson(values['--weights']):undefined});
 result.workingTreeDirty=Boolean(execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8',windowsHide:true}).trim());
 if(result.workingTreeDirty&&result.acceptanceStatus==='VERIFIED')result.acceptanceStatus='DIRTY_SOURCE_NOT_ACCEPTED';
 writeFileSync(resolve(values['--out']),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({acceptanceStatus:result.acceptanceStatus,workPackages:result.items.length,requirements:result.originalRequirements.length,pocs:Object.keys(result.pocStatuses).length,pocScore:result.pocScore}));
 if(result.acceptanceStatus!=='VERIFIED')process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{main();}catch{console.error('READINESS_CHECK_FAILED');process.exitCode=1;}}
