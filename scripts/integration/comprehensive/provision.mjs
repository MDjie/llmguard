import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
const out=resolve(process.argv[2]),values=JSON.parse(readFileSync(out+'/environment.private.json','utf8'));
const url=new URL(values.DATABASE_URL);if(url.hostname!=='127.0.0.1'||url.port!=='5438'||!/^\/guardllm_integration_full_[0-9]+$/.test(url.pathname))throw new Error('ISOLATED_DATABASE_REQUIRED');
const suffix=url.pathname.split('_').at(-1),bucket='guardtest-fx33-'+suffix,name='guardllm-fx33-analyzer-'+suffix;
function run(args){const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:120000});if(r.status!==0)throw new Error('ISOLATED_PROVISION_FAILED_'+args[0]);return r.stdout.trim();}
await new Promise((done,fail)=>{const s=net.createServer();s.once('error',fail);s.listen(59090,'127.0.0.1',()=>s.close(done));});
run(['exec','guardllm-multiformat-test-store','sh','-c','mc alias set fx33 http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb --ignore-existing fx33/'+bucket+' >/dev/null && mc version enable fx33/'+bucket+' >/dev/null']);
const token=values.ANALYZER_SHARED_TOKEN?.length>=32?values.ANALYZER_SHARED_TOKEN:randomBytes(48).toString('base64url');
values.OBJECT_STORE_BUCKET=bucket;values.MULTIMODAL_ANALYZER_BASE_URL='http://127.0.0.1:59090';values.MULTIMODAL_ANALYZER_ALLOWED_HOSTS='127.0.0.1';values.MULTIMODAL_ANALYZER_ALLOWED_PRIVATE_HOSTS='127.0.0.1';values.ANALYZER_SHARED_TOKEN=token;
values.MEDIA_ANALYZER_BASE_URL=values.MULTIMODAL_ANALYZER_BASE_URL;values.MEDIA_ANALYZER_ALLOWED_HOSTS='127.0.0.1';values.MEDIA_ANALYZER_ALLOWED_PRIVATE_HOSTS='127.0.0.1';
values.OBJECT_STORE_ANALYZER_ENDPOINT='http://host.docker.internal:59000';values.OBJECT_STORE_ALLOWED_HOSTS='127.0.0.1,host.docker.internal';values.OBJECT_STORE_ALLOWED_PRIVATE_HOSTS='127.0.0.1,host.docker.internal';values.GUARD_RUNTIME_DEPLOYMENT_ID=suffix;
writeFileSync(out+'/analyzer.private.env','ANALYZER_SHARED_TOKEN='+token+'\nANALYZER_OBJECT_STORE_HOSTS=host.docker.internal\nANALYZER_HOST=0.0.0.0\n');
const image=process.env.COMPREHENSIVE_ANALYZER_IMAGE;if(!image)throw new Error('COMPREHENSIVE_ANALYZER_IMAGE_REQUIRED');
run(['run','-d','--name',name,'--label','guardllm.comprehensive='+suffix,'--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--memory','2g','--cpus','2','--pids-limit','256','--tmpfs','/tmp:rw,nosuid,size=768m','-p','127.0.0.1:59090:8090','--env-file',out+'/analyzer.private.env','--mount','type=bind,source='+resolve('services/media-analyzer/dist/server.mjs')+',target=/app/server.mjs,readonly',image]);
writeFileSync(out+'/environment.private.json',JSON.stringify(values));writeFileSync(out+'/containers.json',JSON.stringify([{name,label:suffix}],null,2));
let live=false;for(let n=0;n<20;n++){try{const response=await fetch('http://127.0.0.1:59090/health/live',{signal:AbortSignal.timeout(2000)});if(response.status===200){live=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,500));}
if(!live)throw new Error('ANALYZER_PROCESS_STARTUP_FAILED');
const probe=await fetch('http://127.0.0.1:59090/v1/capabilities',{method:'POST',headers:{'x-analyzer-token':token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(20000)});if(probe.status!==200)throw new Error('ANALYZER_CAPABILITY_PROBE_FAILED');const capability=await probe.json();writeFileSync(out+'/analyzer-preflight.json',JSON.stringify({status:'PASS',image,capability},null,2));
if(!capability.decoding?.ffmpeg||!capability.decoding?.office||!capability.decoding?.pdf)throw new Error('ANALYZER_REQUIRED_DECODERS_MISSING');
console.log(JSON.stringify({container:name,bucket,versioning:'Enabled',port:59090,realModelAdaptersConfigured:false}));
