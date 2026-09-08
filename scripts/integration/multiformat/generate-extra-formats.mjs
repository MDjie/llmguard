import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const results=[];
function run(program,args) {
 const result=spawnSync(program,args,{encoding:'utf8',timeout:90000,maxBuffer:1000000});
 if(result.status!==0)throw new Error(program+':'+(result.stderr||result.error?.message||'FAILED').slice(-300));
}
for(const [source,targets] of [['docx',['doc','odt']],['xlsx',['xls','ods']],['pptx',['ppt','odp']]]) {
 for(const target of targets) {
  try {run('libreoffice',['-env:UserInstallation=file:///tmp/fixture-profile-'+target,'--headless','--convert-to',target,'--outdir','/fixtures','/fixtures/sample.'+source]);results.push({extension:target,status:'GENERATED'});}
  catch(error){results.push({extension:target,status:'FAILED',error:error.message});}
 }
}
try {
 run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-ar','16000','-ac','2','-c:a','pcm_s16le','-f','s16le','-y','/fixtures/audio.pcm']);
 run('ffmpeg',['-v','error','-protocol_whitelist','file,pipe','-f','s16le','-ar','16000','-ac','2','-i','/fixtures/audio.pcm','-af','pan=mono|c0=c1','-c:a','pcm_s16le','-y','/tmp/pcm-decoded.wav']);
 results.push({extension:'pcm',status:'GENERATED_AND_DECODED',parameters:{sampleRate:16000,channels:2,sampleFormat:'s16le'}});
} catch(error){results.push({extension:'pcm',status:'FAILED',error:error.message});}
writeFileSync('/results/extra-formats.json',JSON.stringify({scope:'SYNTHETIC_CODEC_FIXTURES_ONLY',results},null,2));
console.log(JSON.stringify(results));if(results.some(item=>item.status==='FAILED'))process.exitCode=1;
