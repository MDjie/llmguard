import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createTestCaseSchema } from '@/contracts/http/test-cases';

export const MAX_IMPORT_BYTES=5*1024*1024;
export const MAX_IMPORT_ROWS=1000;
const textDefaultsSchema=z.object({expectedAction:z.enum(['allow','warn','block','mask','rewrite']),category:z.string().regex(/^[a-z][a-z0-9_]{0,49}$/)}).strict();
export const importSamplesSchema=z.object({textDefaults:textDefaultsSchema.optional(),fileName:z.string().min(1).max(255),content:z.string().max(MAX_IMPORT_BYTES),preview:z.boolean().default(true)}).strict();
export type ImportedSample=z.infer<typeof createTestCaseSchema>;
export interface ImportIssue { line:number;message:string }
export function sampleIdentity(sample:{inputText:string;outputText?:string|null;category:string;expectedAction?:string|null}) {
  return createHash('sha256').update(JSON.stringify([sample.inputText,sample.outputText??'',sample.category,sample.expectedAction??'allow'])).digest('hex');
}
export function parseSampleImport(fileName:string,raw:string,textDefaults?:z.infer<typeof textDefaultsSchema>) {
  const errors:ImportIssue[]=[],rows:Array<{line:number;sample:ImportedSample}>=[];
  if(Buffer.byteLength(raw,'utf8')>MAX_IMPORT_BYTES)return {rows,errors:[{line:0,message:'文件不能超过5MiB'}],duplicates:0};
  const content=raw.replace(/^\uFEFF/,'');
  const extension=fileName.split('.').at(-1)?.toLowerCase();
  let candidates:Array<{line:number;value:unknown}>=[];
  if(extension==='json'){
    try {const value:unknown=JSON.parse(content);if(!Array.isArray(value))throw new Error();candidates=value.map((value,index)=>({line:index+1,value}));}
    catch {errors.push({line:0,message:'JSON必须是样本对象数组'});}
  } else if(extension==='csv'||extension==='tsv'){
    try{const table=parseDelimitedSamples(content,extension==='csv'?',':'\t');const headers=table.shift()??[];if(!headers.includes('inputText')||!headers.includes('expectedAction')||new Set(headers).size!==headers.length)throw new Error('表头必须包含 inputText 和 expectedAction，且不能重复');candidates=table.map((values,index)=>{if(values.length!==headers.length)throw new Error('列数不一致');const value:Record<string,unknown>={};headers.forEach((key,column)=>{if(values[column])value[key]=key==='expectedDimensions'?JSON.parse(values[column]):['expectedScoreMin','expectedScoreMax'].includes(key)?Number(values[column]):key==='enabled'?values[column]==='true':values[column];});return{line:index+2,value};});}catch(cause){errors.push({line:0,message:cause instanceof Error?cause.message:'表格解析失败'});}
  } else if(['txt','md','log','jsonl','ndjson'].includes(extension??'')){
    for(const [index,line] of content.split(/\r?\n/).entries()){
      if(!line.trim())continue;
      if(candidates.length+errors.length>=MAX_IMPORT_ROWS){errors.push({line:index+1,message:'单次最多导入1000条'});break;}
      if(['txt','md','log'].includes(extension??'')){if(!textDefaults){errors.push({line:index+1,message:'无标签文本必须显式选择预期动作和分类，禁止自动标为攻击'});break;}candidates.push({line:index+1,value:{title:'文本样本 '+line.slice(0,60),...textDefaults,inputText:line}});}
      else try{candidates.push({line:index+1,value:JSON.parse(line)});}catch{errors.push({line:index+1,message:'此行不是有效的JSON对象'});}
    }
  } else errors.push({line:0,message:'支持TXT、MD、LOG、JSON、JSONL、NDJSON、CSV、TSV；必须提供明确标签'});
  if(candidates.length>MAX_IMPORT_ROWS){errors.push({line:0,message:'单次最多导入1000条'});candidates=candidates.slice(0,MAX_IMPORT_ROWS);}
  const seen=new Set<string>();let duplicates=0;
  for(const item of candidates){
    if(typeof item.value!=='object'||item.value===null||!('expectedAction' in item.value)){errors.push({line:item.line,message:'缺少 expectedAction 标签'});continue;}
    const parsed=createTestCaseSchema.safeParse(item.value);
    if(!parsed.success){errors.push({line:item.line,message:parsed.error.issues.map(issue=>`${issue.path.join('.')}：${issue.message}`).join('；')});continue;}
    const sample=parsed.data;
    if(sample.title.length>200||sample.category.length>50||!sample.inputText.trim()||sample.inputText.includes('\u0000')||sample.outputText?.includes('\u0000')){errors.push({line:item.line,message:'标题最多200字符，分类最多50字符，输入不能为空或包含空字节'});continue;}
    const key=sampleIdentity(sample);if(seen.has(key)){duplicates++;continue;}seen.add(key);rows.push({line:item.line,sample});
  }
  if(!candidates.length&&!errors.length)errors.push({line:0,message:'文件中没有可导入的样本'});
  return {rows,errors,duplicates};
}

/** RFC-style quoted cells; formulas remain inert strings and are never executed. */
export function parseDelimitedSamples(input:string,delimiter:','|'\t'):string[][]{
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
 const endCell=()=>{row.push(cell);cell='';closed=false;};
 const endRow=()=>{endCell();if(row.some(value=>value.length))rows.push(row);row=[];if(rows.length>MAX_IMPORT_ROWS+1)throw new Error('单次最多导入1000条');};
 for(let i=0;i<input.length;i++){
  const c=input[i];
  if(quoted){if(c==='"'){if(input[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
  if(c===delimiter){endCell();continue;}
  if(c==='\n'||c==='\r'){if(c==='\r'&&input[i+1]==='\n')i++;endRow();continue;}
  if(closed)throw new Error('引号后出现非法字符');
  if(c==='"'){if(cell)throw new Error('引号必须位于单元格开头');quoted=true;}else cell+=c;
 }
 if(quoted)throw new Error('未闭合的引号');if(cell||row.length||closed)endRow();return rows;
}
