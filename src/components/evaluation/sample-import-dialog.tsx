'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { apiErrorMessage } from '@/lib/api-client-error';

interface Preview {validCount?:number;duplicates:number;imported:number;errors:Array<{line:number;message:string}>;samples?:Array<{line:number;title:string;inputText:string;outputText:string|null}>}
export function SampleImportDialog({disabled,onImported}:{disabled:boolean;onImported:()=>void}){
  const [open,setOpen]=useState(false),[file,setFile]=useState<{fileName:string;content:string}|null>(null),[result,setResult]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[previewReady,setPreviewReady]=useState(false);
  async function readFile(value:File|undefined){
    setFile(null);setResult(null);setMessage('');setPreviewReady(false);
    if(!value)return;
    if(value.size>5*1024*1024){setMessage('文件不能超过5MiB');return;}
    setBusy(true);
    try{const content=new TextDecoder('utf-8',{fatal:true}).decode(await value.arrayBuffer());setFile({fileName:value.name,content});}
    catch{setMessage('无法读取文件，请使用UTF-8编码');}finally{setBusy(false);}
  }
  async function submit(preview:boolean){
    if(!file)return;setBusy(true);setMessage('');setPreviewReady(false);
    try{
      const response=await fetch('/api/test-cases/import',{method:'POST',headers:{'Content-Type':'application/json',...csrfHeaders()},body:JSON.stringify({...file,preview})});
      const payload=await response.json() as {data?:Preview};setResult(payload.data??null);
      if(!response.ok){setMessage(apiErrorMessage(payload));return;}
      if(preview)setPreviewReady(true);else{setMessage(`已导入${payload.data?.imported??0}条，跳过${payload.data?.duplicates??0}条重复样本`);setFile(null);onImported();}
    }catch(error){setMessage(error instanceof Error?error.message:'导入失败');}finally{setBusy(false);}
  }
  return <><Button variant="outline" disabled={disabled} onClick={()=>{setOpen(true);setFile(null);setResult(null);setMessage('');setPreviewReady(false);}}>批量导入文本样本</Button><Dialog open={open} onOpenChange={value=>{if(!busy)setOpen(value);}}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>批量导入文本攻击样本</DialogTitle><DialogDescription>支持TXT、JSON、JSONL，UTF-8编码，最多1000条/5MiB。导入后在评测门禁中检测输入和模拟输出。</DialogDescription></DialogHeader>
    <div className="flex gap-4 text-sm"><a className="underline" href="/templates/attack-samples.json" download>下载JSON模板</a><a className="underline" href="/templates/attack-samples.txt" download>下载TXT模板</a></div>
    <p className="text-sm text-muted-foreground">TXT每个非空行作为一个攻击样本，默认预期拦截。导入数据仅用于安全验证，不调用业务大模型。</p>
    <Input disabled={busy} type="file" accept=".txt,.json,.jsonl" aria-label="选择样本文件" onChange={event=>void readFile(event.target.files?.[0])}/>
    {result&&<div className="space-y-2 text-sm"><p>可新增 {result.validCount??result.imported} 条 · 重复 {result.duplicates} 条 · 错误 {result.errors.length} 条</p>{result.errors.map((error,index)=><p key={index} className="text-red-600">第{error.line}行：{error.message}</p>)}{result.samples?.map(sample=><div className="rounded border p-3" key={sample.line}><strong>第{sample.line}条 · {sample.title}</strong><p className="whitespace-pre-wrap break-words">输入：{sample.inputText}</p>{sample.outputText&&<p className="whitespace-pre-wrap break-words">模拟输出：{sample.outputText}</p>}</div>)}</div>}
    {message&&<p role="status" className="text-sm">{message}</p>}<DialogFooter><Button disabled={busy||!file} variant="outline" onClick={()=>void submit(true)}>预览校验</Button><Button disabled={disabled||busy||!file||!previewReady} onClick={()=>void submit(false)}>{busy?'处理中…':'确认导入'}</Button><Button asChild variant="outline"><Link href="/evaluation-runs">进入评测门禁</Link></Button></DialogFooter>
  </DialogContent></Dialog></>;
}
