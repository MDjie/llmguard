import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stopOwnedProcess } from './process-identity.mjs';
const out=resolve(process.argv[2]),root=resolve('.artifact-build');if(!out.startsWith(root+'/')&&!out.startsWith(root+'\\'))throw new Error('ISOLATED_DIRECTORY_REQUIRED');
const results=[];
if(existsSync(out+'/processes.json'))for(const record of JSON.parse(readFileSync(out+'/processes.json','utf8')).reverse())try{results.push({name:record.name,status:stopOwnedProcess(record)});}catch(e){results.push({name:record.name,status:'FAIL',code:e.message});}
if(!process.argv.includes('--keep-analyzer')&&existsSync(out+'/containers.json'))for(const record of JSON.parse(readFileSync(out+'/containers.json','utf8'))){
 if(!/^guardllm-fx33-analyzer-[0-9]+$/.test(record.name))throw new Error('UNOWNED_CONTAINER');
 const current=spawnSync('docker',['inspect',record.name,'--format','{{index .Config.Labels "guardllm.comprehensive"}}'],{encoding:'utf8',windowsHide:true});
 if(current.status===0&&current.stdout.trim()===record.label){const r=spawnSync('docker',['stop','--time','10',record.name],{encoding:'utf8',windowsHide:true});results.push({name:record.name,status:r.status===0?'STOPPED':'FAIL'});}else results.push({name:record.name,status:current.status===0?'FAIL':'ALREADY_STOPPED'});
}
writeFileSync(out+'/cleanup.json',JSON.stringify({results},null,2));console.log(JSON.stringify(results));if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
