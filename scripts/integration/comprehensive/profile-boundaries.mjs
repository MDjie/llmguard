import{build}from'tsup';import{spawnSync}from'node:child_process';import{resolve,relative,isAbsolute}from'node:path';import{existsSync}from'node:fs';
const out=resolve(process.argv[2]),within=relative(resolve('.artifact-build'),out),image=process.env.COMPREHENSIVE_ANALYZER_IMAGE;
if(!within||within.startsWith('..')||isAbsolute(within)||!existsSync(out+'/format-fixtures')||!image)throw new Error('ISOLATED_PROFILE_RUN_REQUIRED');
await build({entry:['scripts/integration/multiformat/profile-boundaries.ts'],outDir:out,bundle:true,platform:'node',target:'node24',format:['esm'],splitting:false,clean:false,noExternal:['zod','saxes','xmlchars'],outExtension:()=>({js:'.mjs'})});
const result=spawnSync('docker',['run','--rm','--network','none','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--memory','2g','--cpus','2','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=512m','--mount','type=bind,source='+resolve(out,'format-fixtures')+',target=/fixtures,readonly','--mount','type=bind,source='+out+',target=/results',image,'node','/results/profile-boundaries.mjs'],{stdio:'inherit',windowsHide:true,timeout:120000});
process.exitCode=result.status??1;
