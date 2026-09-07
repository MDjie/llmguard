import { spawn } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { createWriteStream, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { hashFile, safeBundlePath, sealBundle, summarizeSbom, verifyBundle } from './gateway-v2-bundle-integrity.mjs';

const root=path.resolve(import.meta.dirname,'../..'),roles=['app','gateway','worker'];
const [command,...args]=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2) {
  if(!['--config','--output','--signing-key','--bundle','--verification-key'].includes(args[i])||!args[i+1]||options[args[i]]) throw new Error('INVALID_CLI_OPTION');
  options[args[i]]=args[i+1];
}
async function run(binary,argv,{output,timeout=300000}={}) {
  const file=output?createWriteStream(output,{flags:'wx'}):null;
  let stdout='',stderr='',size=0;
  const child=spawn(binary,argv,{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);timer.unref();
  child.stdout.on('data',chunk=>{
    size+=chunk.length;
    if(size>(output?256*1024*1024:8*1024*1024)) {child.kill('SIGKILL');return;}
    if(file) {if(!file.write(chunk))child.stdout.pause();} else stdout+=chunk.toString('utf8');
  });
  if(file) {file.on('drain',()=>child.stdout.resume());file.on('error',()=>child.kill('SIGKILL'));}
  child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk.toString('utf8');});
  let code;
  try {code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}
  finally {clearTimeout(timer);if(file){file.end();await finished(file);}}
  if(code!==0) throw new Error('BUNDLE_COMMAND_FAILED: '+binary+' '+argv[0]+' (exit '+code+') '+stderr.slice(-500).replace(/[\r\n]+/g,' '));
  return stdout;
}
async function inspect(reference) {
  const [image]=JSON.parse(await run('docker',['image','inspect',reference]));
  if(!image||!/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('LOCAL_IMAGE_REQUIRED');
  return {id:image.Id,platform:image.Os+'/'+image.Architecture,user:image.Config?.User??'',repoDigests:image.RepoDigests??[]};
}
function copyTree(source,destination,extension) {
  mkdirSync(destination,{recursive:true});
  for(const name of readdirSync(source).sort()) {
    const absolute=path.join(source,name),target=path.join(destination,name),stat=lstatSync(absolute);
    if(stat.isSymbolicLink())throw new Error('SOURCE_LINK_REJECTED');
    if(stat.isDirectory())copyTree(absolute,target,extension);
    else if(stat.isFile()&&extension.test(name))copyFileSync(absolute,target);
  }
}
function outsideBundle(key,bundle) {
  if(!key)throw new Error('EXTERNAL_RELEASE_KEY_REQUIRED');
  const relative=path.relative(bundle,path.resolve(key));
  if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw new Error('TRUST_KEY_MUST_BE_OUTSIDE_BUNDLE');
  return readFileSync(key,'utf8');
}
async function main() {
  if(command==='pack') {
    if(!options['--config']||!options['--output'])throw new Error('PACK_REQUIRES_CONFIG_OUTPUT_SIGNING_KEY');
    const configuration=JSON.parse(readFileSync(options['--config'],'utf8')),output=path.resolve(options['--output']);
    const signingKey=outsideBundle(options['--signing-key'],output);
    if(createPublicKey(signingKey).asymmetricKeyType!=='ed25519')throw new Error('ED25519_RELEASE_KEY_REQUIRED');
    if(!/^ghcr\.io\/anchore\/syft@sha256:[a-f0-9]{64}$/.test(configuration.scanner))throw new Error('PINNED_SYFT_IMAGE_REQUIRED');
    await inspect(configuration.scanner);
    const images=[];
    for(const role of roles) {
      const spec=configuration.images?.[role];
      if(typeof spec?.reference!=='string'||!/^sha256:[a-f0-9]{64}$/.test(spec?.expectedId))throw new Error('FROZEN_IMAGE_ID_REQUIRED');
      const actual=await inspect(spec.reference);
      if(actual.id!==spec.expectedId||!actual.user||actual.user==='0'||actual.user==='root')throw new Error('IMAGE_CHANGED_OR_ROOT_RUNTIME: '+role);
      images.push({role,reference:spec.reference,...actual,archive:'images/'+role+'.tar',sbom:'sbom/'+role+'.cdx.json'});
    }
    mkdirSync(output,{recursive:false});
    for(const directory of ['images','sbom','scripts','runbooks'])mkdirSync(path.join(output,directory));
    for(const image of images) {
      console.log('EXPORT '+image.role);
      // Save the frozen digest, not a mutable tag which could change after inspection.
      await run('docker',['image','save',image.id,'--output',path.join(output,image.archive)]);
      console.log('SBOM '+image.role+' (network disabled, archive mounted read-only)');
      await run('docker',['run','--rm','--pull=never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--pids-limit','128','--memory','2g','--cpus','2','--tmpfs','/tmp:size=128m,mode=1777',
        '--mount','type=bind,source='+path.join(output,'images')+',target=/input,readonly',
        '--env','SYFT_CHECK_FOR_APP_UPDATE=false',configuration.scanner,'scan','docker-archive:/input/'+image.role+'.tar','-o','cyclonedx-json'],{output:path.join(output,image.sbom)});
      image.inventory=summarizeSbom(JSON.parse(readFileSync(path.join(output,image.sbom),'utf8')));
      if((await inspect(image.id)).id!==image.id)throw new Error('FROZEN_IMAGE_MISSING');
    }
    copyTree(path.join(root,'deploy/helm/guard-gateway-v2'),path.join(output,'chart'),/\.(yaml|yml)$/);
    copyTree(path.join(root,'drizzle'),path.join(output,'drizzle'),/\.sql$/);
    copyTree(path.join(root,'docs/upgrade'),path.join(output,'runbooks'),/\.md$/);
    copyTree(path.join(root,'deploy/observability'),path.join(output,'observability'),/\.(json|yaml|yml)$/);
    mkdirSync(path.join(output,'scripts/release'));
    for(const file of ['gateway-v2-bundle-integrity.mjs','gateway-v2-offline.mjs','gateway-v2-migrate.mjs','gateway-v2-identity-preflight.mjs'])copyFileSync(path.join(root,'scripts/release',file),path.join(output,'scripts/release',file));
    const sourceFiles=['package.json','pnpm-lock.yaml','Dockerfile','services/guard-gateway/Dockerfile','packages/contracts/generated/gateway-v2-manifest.json'];
    const sourceDigests={};for(const file of sourceFiles)sourceDigests[file]=await hashFile(path.join(root,file));
    const metadata={createdAt:new Date().toISOString(),sourceDigests,images,scanner:configuration.scanner,
      verification:'Ed25519 signature plus SHA-256 of every payload file; external trust key required',
      missingProductionEvidence:['target-hardware qualification','independent model quality','24-hour endurance','Kubernetes runtime and node failure test','image registry signatures and license review'],
      deploymentRequirements:['operator-provisioned database, Redis, object storage, model and TLS identities','image import to the target runtime or private registry; render chart with real immutable registry digests','run identity preflight and migration plan before upgrade','migration and identity tools run in the supplied worker image with operator config mounted read-only'],
      externalDependenciesNotBundled:['PostgreSQL','Redis','object store','model weights','Kubernetes']};
    await sealBundle(output,metadata,signingKey);
    const trusted=createPublicKey(signingKey).export({type:'spki',format:'pem'});
    const verified=await verifyBundle(output,trusted);
    console.log(JSON.stringify({status:'PASS',qualification:'BUILD_ARTIFACT_ONLY',verifiedFiles:verified.verifiedFiles,images:images.map(({role,id,inventory})=>({role,id,components:inventory.components}))}));
  } else if(command==='verify'||command==='load') {
    if(!options['--bundle'])throw new Error('BUNDLE_REQUIRED');
    const bundle=path.resolve(options['--bundle']),key=outsideBundle(options['--verification-key'],bundle);
    const result=await verifyBundle(bundle,key);
    if(command==='load') {
      const images=result.manifest.images;
      if(!Array.isArray(images)||images.length!==3||roles.some(role=>images.filter(image=>image.role===role&&image.archive==='images/'+role+'.tar'&&/^sha256:[a-f0-9]{64}$/.test(image.id)).length!==1))throw new Error('BUNDLE_IMAGE_MAPPING_INVALID');
      for(const image of images) {
        const archive=safeBundlePath(bundle,image.archive);
        await run('docker',['image','load','--input',archive]);
        // OCI index IDs can be normalized by older Docker daemons; do not silently accept a different identifier.
        if((await inspect(image.id)).id!==image.id)throw new Error('IMPORTED_IMAGE_ID_MISMATCH');
      }
    }
    console.log(JSON.stringify({status:'PASS',operation:command,qualification:result.manifest.qualification,verifiedFiles:result.verifiedFiles,keyFingerprint:result.keyFingerprint,servicesStarted:false}));
  } else throw new Error('Use pack --config FILE --output NEW_DIRECTORY --signing-key EXTERNAL_KEY | verify|load --bundle DIRECTORY --verification-key EXTERNAL_KEY');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'OFFLINE_BUNDLE_FAILED');process.exitCode=1;});
