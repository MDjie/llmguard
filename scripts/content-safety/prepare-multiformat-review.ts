import {createReadStream} from 'node:fs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
const recordSchema=z.object({caseId:z.string(),dataset:z.string(),split:z.string(),role:z.string(),expectedRisk:z.boolean().nullable(),textSha256:z.string().regex(/^[a-f0-9]{64}$/),labelBasis:z.string().optional(),action:z.string().optional(),oldAction:z.string().optional(),newAction:z.string().optional(),oldFault:z.boolean().optional(),newFault:z.boolean().optional(),sourcePath:z.string().optional(),sourceRow:z.union([z.number(),z.string()]).optional(),reasonCodes:z.array(z.string()).optional()}).passthrough();
async function main(){
 const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Usage: prepare-multiformat-review.ts <frozen-replay-directory> <new-output-directory>');
 const selected=new Map<string,Record<string,unknown>>(),reasons:Record<string,number>={},sources:Record<string,string>={};
 for(const name of ['candidate-failures.jsonl','changed-cases.jsonl']){
  const path=join(input,name);sources[name]=createHash('sha256').update(await readFile(path)).digest('hex');
  const lines=createInterface({input:createReadStream(path),crlfDelay:Infinity});
  for await(const line of lines){if(!line.trim())continue;const row=recordSchema.parse(JSON.parse(line));
   const candidateFp=row.expectedRisk===false&&(row.action??row.newAction)==='BLOCK';
   const regression=row.expectedRisk===true&&row.oldAction==='BLOCK'&&row.newAction!==undefined&&row.newAction!=='BLOCK'&&!row.oldFault&&!row.newFault;
   if(!candidateFp&&!regression)continue;
   const prior=selected.get(row.caseId);
   selected.set(row.caseId,{...prior,caseId:row.caseId,dataset:row.dataset,sourceSplit:row.split,role:row.role,sourceSha256:row.textSha256,sourcePath:row.sourcePath??prior?.sourcePath,sourceRow:row.sourceRow??prior?.sourceRow,selection:candidateFp?'SOURCE_LABEL_FP':'STRICT_BLOCK_REGRESSION',sourceExpectedRisk:row.expectedRisk,sourceLabelBasis:row.labelBasis??prior?.sourceLabelBasis,oldAction:row.oldAction,newAction:row.newAction??row.action,reasonCodes:row.reasonCodes??[],reviewState:'UNREVIEWED',reviewerIds:[],reviewedRisk:null,reviewedReason:null,taskPurpose:null,sourceInstructionAuthority:'FORBIDDEN',split:'DEVELOPMENT_REVIEW_ONLY'});
  }
 }
 for(const row of selected.values())for(const code of row.reasonCodes as string[])reasons[code]=(reasons[code]??0)+1;
 await mkdir(output,{recursive:true});await writeFile(join(output,'review-queue.jsonl'),[...selected.values()].map(row=>JSON.stringify(row)).join('\n')+'\n',{flag:'wx'});
 const summary={version:'multiformat-review-queue-1',sourceArtifacts:sources,total:selected.size,bySelection:Object.fromEntries(['SOURCE_LABEL_FP','STRICT_BLOCK_REGRESSION'].map(kind=>[kind,[...selected.values()].filter(row=>row.selection===kind).length])),reasonCounts:Object.fromEntries(Object.entries(reasons).sort((a,b)=>b[1]-a[1])),humanReviewed:false,independentHoldout:false,semanticLabelsChanged:false};
 await writeFile(join(output,'review-summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({total:summary.total,bySelection:summary.bySelection,humanReviewed:false}));
}main().catch(error=>{console.error(error instanceof Error?error.message:'REVIEW_QUEUE_FAILED');process.exitCode=1;});
