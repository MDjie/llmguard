import {spawnSync} from 'node:child_process';import{resolve}from'node:path';import{writeFileSync}from'node:fs';
const out=resolve(process.argv[2]),image=process.env.COMPREHENSIVE_ANALYZER_IMAGE;if(!image)throw new Error('IMAGE_REQUIRED');
const results=[];
function run(id,args){const r=spawnSync('docker',['run','--rm','--network','none','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--memory','2g','--cpus','2','--pids-limit','256','--tmpfs','/tmp:rw,nosuid,size=768m','--mount','type=bind,source='+resolve(out,'format-fixtures')+',target=/fixtures','--mount','type=bind,source='+out+',target=/results','--mount','type=bind,source='+resolve('scripts/integration/multiformat')+',target=/checks,readonly',image,...args],{encoding:'utf8',windowsHide:true,timeout:180000});results.push({id,status:r.status===0?'PASS':'FAIL',exitCode:r.status});console.log(JSON.stringify(results.at(-1)));}
run('GENERATE-AUDIO-VIDEO',['node','/checks/audio-video-codec-smoke.mjs']);run('GENERATE-OFFICE-PCM',['node','/checks/generate-extra-formats.mjs']);
run('GENERATE-AVIF',['ffmpeg','-v','error','-i','/fixtures/sample.png','-frames:v','1','-c:v','libaom-av1','-y','/fixtures/sample.avif']);
run('GENERATE-HEIC',['heif-enc','-q','50','-o','/fixtures/sample.heic','/fixtures/sample.png']);
writeFileSync(out+'/format-generation.json',JSON.stringify({scope:'SYNTHETIC_FORMATS_NO_SEMANTIC_MODEL',results},null,2));if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
