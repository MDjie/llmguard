import {spawn,spawnSync} from 'node:child_process';
/** Only terminates the process tree created by this invocation. */
export async function runBoundedCommand(program,args,{env=process.env,stdio='inherit',timeoutMs=900000,onProgress=()=>{},heartbeatMs=30000}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>7200000)throw new Error('COMMAND_DEADLINE_INVALID');
 const started=Date.now();
 return new Promise(resolve=>{
  let settled=false,timedOut=false;
  const child=spawn(program,args,{env,stdio,windowsHide:true,detached:process.platform!=='win32'});
  const finish=(exitCode)=>{
   if(settled)return;settled=true;clearTimeout(deadline);clearInterval(heartbeat);
   resolve({exitCode:timedOut?124:exitCode,timedOut,elapsedMs:Date.now()-started});
  };
  const heartbeat=setInterval(()=>onProgress({pid:child.pid,elapsedMs:Date.now()-started,timeoutMs}),heartbeatMs);
  const deadline=setTimeout(()=>{
   timedOut=true;
   if(child.pid){
    if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});
    else {try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
   }
   finish(124);
  },timeoutMs);
  child.once('error',()=>finish(1));
  child.once('close',code=>finish(code??1));
 });
}
