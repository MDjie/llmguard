import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, openSync, closeSync } from 'node:fs';
import net from 'node:net';
import https from 'node:https';
import path from 'node:path';
const environment = JSON.parse(readFileSync('.artifact-build/upgrade-implementation-20260907/environment/environment.json','utf8'));
const tls = Object.fromEntries([['ca','ca.crt'],['cert','client.crt'],['key','client.key']].map(([key,file]) => [key,readFileSync(path.resolve('.artifact-build/upgrade-implementation-20260907/environment/tls',file))]));
async function ready(){return new Promise(resolve=>{const req=https.get('https://127.0.0.1:58087/actuator/health',{...tls,signal:AbortSignal.timeout(1000)},res=>{res.resume();resolve(Boolean(res.statusCode && res.statusCode < 500));});req.once('error',()=>resolve(false));});}
const native=process.argv.includes('--native');
let extra={};
if(native){execFileSync(process.execPath,['--import','tsx','scripts/integration/prepare-media-codec-fixtures.mjs'],{stdio:'inherit',windowsHide:true});execFileSync(process.execPath,['--import','tsx','scripts/integration/prepare-gateway-v11-native.ts'],{stdio:'inherit',windowsHide:true});extra=JSON.parse(readFileSync('.artifact-build/v11-all-20260908/native-proxy-fixture.json','utf8')).extra;}
const children=[], descriptors=[];let javaStarted=false;
async function port(port){return new Promise(resolve=>{const socket=net.connect({port,host:'127.0.0.1'});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(500,()=>{socket.destroy();resolve(false);});});}
function start(file,args=[],env={}){const fd=openSync('.artifact-build/v11-all-20260908/'+path.basename(file)+'.log','w');descriptors.push(fd);const child=spawn(process.execPath,[...(file.endsWith('.ts')?['--import','tsx']:[]),file,...args],{env:{...process.env,...environment,...extra,...env},stdio:['ignore',fd,fd],windowsHide:true});children.push(child);return child;}
try {
  for(const p of [5107,58087,58088,58089]) if(await port(p)) throw new Error('ISOLATED_PORT_ALREADY_IN_USE_'+p);
  start('scripts/integration/gateway-v11-archive-object-store.mjs');start('scripts/integration/gateway-v2-mock-model.mjs');
  start('src/server.ts',[],{GATEWAY_ARCHIVE_MODE:'STRICT_OBJECT',GATEWAY_ARCHIVE_POLICIES_JSON:'[]'});
  start('scripts/integration/gateway-v2-java.mjs',['start-classes']);javaStarted=true;
  for(let i=0;i<120;i++){if(await port(5107)&&await ready()&&await port(58088)&&await port(58089))break;if(children.some(child=>child.exitCode!==null))throw new Error('ISOLATED_SERVICE_EXITED');if(i===119)throw new Error('ISOLATED_STARTUP_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,1000));}
  console.log('Owned control, gateway, synthetic model and archive object fixture started.');
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,native?['--import','tsx','scripts/integration/with-gateway-v11-native.ts']:['--import','tsx','scripts/integration/with-gateway-v2-profile.ts','FULL_BUFFER','scripts/integration/check-gateway-v11-archive.mjs'],{env:{...process.env,...environment},stdio:'inherit',windowsHide:true});children.push(child);child.once('error',reject);child.once('exit',code=>resolve(code??1));});process.exitCode=code;
  if(code===0 && process.argv.includes('--ui')){const status=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','scripts/integration/check-gateway-v11-ui.ts'],{env:{...process.env,...environment},stdio:'inherit',windowsHide:true});children.push(child);child.once('error',reject);child.once('exit',value=>resolve(value??1));});process.exitCode=status;}
} finally {
  if(javaStarted){try{const label=execFileSync('docker',['inspect','--format','{{index .Config.Labels "guardllm.scope"}}','guardllm-upgrade-v2-java-20260907'],{encoding:'utf8',windowsHide:true}).trim();if(label==='upgrade-v2-integration')execFileSync('docker',['stop','guardllm-upgrade-v2-java-20260907'],{stdio:'ignore',windowsHide:true});}catch{}}
  for(const child of children)if(child.exitCode===null)child.kill();for(const fd of descriptors)closeSync(fd);
}
