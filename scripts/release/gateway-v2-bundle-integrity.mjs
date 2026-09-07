import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIGEST = /^[a-f0-9]{64}$/;
const OMIT = new Set(['bundle-manifest.json', 'bundle-signature.json']);
export function safeBundlePath(root, relative) {
  if (typeof relative !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('UNSAFE_BUNDLE_PATH');
  const target = path.resolve(root, ...relative.split('/'));
  const relation = path.relative(path.resolve(root), target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('UNSAFE_BUNDLE_PATH');
  let current=path.resolve(root);
  for(const part of relative.split('/')) { current=path.join(current,part); if(lstatSync(current).isSymbolicLink()) throw new Error('BUNDLE_LINK_REJECTED'); }
  return target;
}
export async function hashFile(file) {
  const digest=createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
export function listBundleFiles(root) {
  if(!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('BUNDLE_DIRECTORY_REQUIRED');
  const files=[];
  function visit(relative, depth=0) {
    if(depth>12) throw new Error('BUNDLE_DEPTH_LIMIT');
    for(const name of readdirSync(path.join(root,relative)).sort()) {
      const entry=relative ? relative+'/'+name:name, absolute=safeBundlePath(root,entry), stat=lstatSync(absolute);
      if(stat.isDirectory()) visit(entry,depth+1);
      else if(stat.isFile()) { if(!OMIT.has(entry)) files.push(entry); }
      else throw new Error('BUNDLE_SPECIAL_FILE_REJECTED');
      if(files.length>10000) throw new Error('BUNDLE_FILE_LIMIT');
    }
  }
  visit('');
  if(new Set(files.map(file=>file.toLowerCase())).size!==files.length) throw new Error('BUNDLE_CASE_COLLISION');
  return files.sort();
}
function jsonFile(file, max=8*1024*1024) {
  if(!lstatSync(file).isFile()||lstatSync(file).size>max) throw new Error('BUNDLE_METADATA_SIZE');
  return JSON.parse(readFileSync(file,'utf8'));
}
export function publicKeyFingerprint(key) {
  const publicKey=createPublicKey(key);
  if(publicKey.asymmetricKeyType!=='ed25519') throw new Error('ED25519_RELEASE_KEY_REQUIRED');
  return createHash('sha256').update(publicKey.export({format:'der',type:'spki'})).digest('hex');
}
export async function sealBundle(root, metadata, privateKeyPem) {
  const key=createPrivateKey(privateKeyPem);
  if(key.asymmetricKeyType!=='ed25519') throw new Error('ED25519_RELEASE_KEY_REQUIRED');
  const files=[];
  for(const relative of listBundleFiles(root)) {
    const absolute=safeBundlePath(root,relative);
    files.push({path:relative,size:lstatSync(absolute).size,sha256:await hashFile(absolute)});
  }
  const manifest={...metadata,format:'guardllm-gateway-v2-offline/1',qualification:'BUILD_ARTIFACT_ONLY',files};
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  const fingerprint=publicKeyFingerprint(privateKeyPem);
  writeFileSync(path.join(root,'bundle-manifest.json'),bytes,{flag:'wx'});
  writeFileSync(path.join(root,'bundle-signature.json'),JSON.stringify({algorithm:'Ed25519',keyFingerprint:fingerprint,signature:sign(null,bytes,key).toString('base64')},null,2)+'\n',{flag:'wx'});
  return manifest;
}
export async function verifyBundle(root, trustedPublicKeyPem) {
  const manifestPath=safeBundlePath(root,'bundle-manifest.json'),signaturePath=safeBundlePath(root,'bundle-signature.json');
  const manifest=jsonFile(manifestPath), signature=jsonFile(signaturePath,8192);
  const fingerprint=publicKeyFingerprint(trustedPublicKeyPem);
  if(signature.algorithm!=='Ed25519'||signature.keyFingerprint!==fingerprint||typeof signature.signature!=='string'||!verify(null,readFileSync(manifestPath),createPublicKey(trustedPublicKeyPem),Buffer.from(signature.signature,'base64'))) throw new Error('BUNDLE_SIGNATURE_INVALID');
  if(manifest.format!=='guardllm-gateway-v2-offline/1'||manifest.qualification!=='BUILD_ARTIFACT_ONLY'||!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>10000) throw new Error('BUNDLE_MANIFEST_INVALID');
  const inventory=listBundleFiles(root), expected=manifest.files.map(entry=>entry.path).sort();
  if(JSON.stringify(inventory)!==JSON.stringify(expected)) throw new Error('BUNDLE_INVENTORY_MISMATCH');
  for(const entry of manifest.files) {
    if(!DIGEST.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<0) throw new Error('BUNDLE_ENTRY_INVALID');
    const absolute=safeBundlePath(root,entry.path);
    if(lstatSync(absolute).size!==entry.size||await hashFile(absolute)!==entry.sha256) throw new Error('BUNDLE_ARTIFACT_CHANGED: '+entry.path);
  }
  return {manifest,keyFingerprint:fingerprint,verifiedFiles:inventory.length};
}

/** CycloneDX is inventory evidence, not vulnerability clearance or license approval. */
export function summarizeSbom(document) {
  if(document.bomFormat!=='CycloneDX'||!Array.isArray(document.components)||document.components.length<1) throw new Error('NONEMPTY_CYCLONEDX_REQUIRED');
  const ecosystems={},licenses={};let unknownLicense=0;
  for(const component of document.components) {
    if(typeof component.name!=='string'||!component.name) throw new Error('SBOM_COMPONENT_NAME_REQUIRED');
    const ecosystem=typeof component.purl==='string'?(component.purl.match(/^pkg:([^/]+)\//)?.[1]??'unknown'):'unknown';
    ecosystems[ecosystem]=(ecosystems[ecosystem]??0)+1;
    const labels=(component.licenses??[]).map(item=>item.expression??item.license?.id??item.license?.name).filter(value=>typeof value==='string'&&value);
    if(!labels.length) unknownLicense++;
    for(const license of labels) licenses[license]=(licenses[license]??0)+1;
  }
  return {components:document.components.length,ecosystems,licenses,unknownLicense,vulnerabilityAssessment:'NOT_PERFORMED',licenseApproval:'NOT_GRANTED'};
}
