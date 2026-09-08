import {readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import net from 'node:net';
const out=resolve(process.argv[2]);
const env=JSON.parse(readFileSync('.artifact-build/upgrade-implementation-20260907/environment/environment.json','utf8'));
const url=new URL(env.PGDATABASE_URL);
if(url.hostname!=='127.0.0.1'||url.port!=='55447'||url.pathname!=='/guardllm_integration_gateway_v2')throw new Error('ISOLATED_GATEWAY_REQUIRED');
for(const port of [5107,58087,58088])await new Promise((done,fail)=>{const socket=net.createServer();socket.once('error',fail);socket.listen(port,'127.0.0.1',()=>socket.close(done));});
const build=spawn(process.execPath,['node_modules/next/dist/bin/next','build'],{env:{...process.env,...env,NODE_ENV:'production'},stdio:'inherit',windowsHide:true});
const code=await new Promise(done=>build.on('exit',done));if(code!==0)throw new Error('GATEWAY_CONTROL_BUILD_FAILED');
const processes=[];
for(const [name,args] of [['gateway-control',['scripts/integration/start-gateway-v2-control.mjs']],['gateway-model',['scripts/integration/gateway-v2-mock-model.mjs']],['gateway-java',['scripts/integration/gateway-v2-java.mjs','start-classes']]]){
 const fd=openSync(out+'/'+name+'.private.log','a');const child=spawn(process.execPath,args,{stdio:['ignore',fd,fd],windowsHide:true,detached:true});processes.push({name,pid:child.pid});child.unref();closeSync(fd);
}
writeFileSync(out+'/gateway-processes.json',JSON.stringify(processes,null,2));console.log(JSON.stringify(processes));
