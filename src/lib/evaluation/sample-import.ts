import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createTestCaseSchema } from '@/contracts/http/test-cases';

export const MAX_IMPORT_BYTES=5*1024*1024;
export const MAX_IMPORT_ROWS=1000;
export const importSamplesSchema=z.object({fileName:z.string().min(1).max(255),content:z.string().max(MAX_IMPORT_BYTES),preview:z.boolean().default(true)}).strict();
export type ImportedSample=z.infer<typeof createTestCaseSchema>;
export interface ImportIssue { line:number;message:string }
export function sampleIdentity(sample:{inputText:string;outputText?:string|null;category:string;expectedAction?:string|null}) {
  return createHash('sha256').update(JSON.stringify([sample.inputText,sample.outputText??'',sample.category,sample.expectedAction??'allow'])).digest('hex');
}
export function parseSampleImport(fileName:string,raw:string) {
  const errors:ImportIssue[]=[],rows:Array<{line:number;sample:ImportedSample}>=[];
  if(Buffer.byteLength(raw,'utf8')>MAX_IMPORT_BYTES)return {rows,errors:[{line:0,message:'文件不能超过5MiB'}],duplicates:0};
  const content=raw.replace(/^\uFEFF/,'');
  const extension=fileName.split('.').at(-1)?.toLowerCase();
  let candidates:Array<{line:number;value:unknown}>=[];
  if(extension==='json'){
    try {const value:unknown=JSON.parse(content);if(!Array.isArray(value))throw new Error();candidates=value.map((value,index)=>({line:index+1,value}));}
    catch {errors.push({line:0,message:'JSON必须是样本对象数组'});}
  } else if(extension==='txt'||extension==='jsonl'){
    for(const [index,line] of content.split(/\r?\n/).entries()){
      if(!line.trim())continue;
      if(candidates.length+errors.length>=MAX_IMPORT_ROWS){errors.push({line:index+1,message:'单次最多导入1000条'});break;}
      if(extension==='txt')candidates.push({line:index+1,value:{title:'文本样本 '+line.slice(0,60),category:'prompt_injection',inputText:line,expectedAction:'block'}});
      else try{candidates.push({line:index+1,value:JSON.parse(line)});}catch{errors.push({line:index+1,message:'此行不是有效的JSON对象'});}
    }
  } else errors.push({line:0,message:'仅支持UTF-8编码的TXT、JSON和JSONL文件'});
  if(candidates.length>MAX_IMPORT_ROWS){errors.push({line:0,message:'单次最多导入1000条'});candidates=candidates.slice(0,MAX_IMPORT_ROWS);}
  const seen=new Set<string>();let duplicates=0;
  for(const item of candidates){
    const parsed=createTestCaseSchema.safeParse(item.value);
    if(!parsed.success){errors.push({line:item.line,message:parsed.error.issues.map(issue=>`${issue.path.join('.')}：${issue.message}`).join('；')});continue;}
    const sample=parsed.data;
    if(sample.title.length>200||sample.category.length>50||!sample.inputText.trim()||sample.inputText.includes('\u0000')||sample.outputText?.includes('\u0000')){errors.push({line:item.line,message:'标题最多200字符，分类最多50字符，输入不能为空或包含空字节'});continue;}
    const key=sampleIdentity(sample);if(seen.has(key)){duplicates++;continue;}seen.add(key);rows.push({line:item.line,sample});
  }
  if(!candidates.length&&!errors.length)errors.push({line:0,message:'文件中没有可导入的样本'});
  return {rows,errors,duplicates};
}
