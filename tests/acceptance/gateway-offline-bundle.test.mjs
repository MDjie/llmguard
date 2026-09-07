import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealBundle, verifyBundle, safeBundlePath, summarizeSbom } from '../../scripts/release/gateway-v2-bundle-integrity.mjs';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const privatePem=privateKey.export({type:'pkcs8',format:'pem'}),publicPem=publicKey.export({type:'spki',format:'pem'});
async function fixture() {const root=mkdtempSync(path.join(os.tmpdir(),'guard-v2-bundle-'));mkdirSync(path.join(root,'images'));writeFileSync(path.join(root,'images','app.tar'),'fixture archive');await sealBundle(root,{images:[]},privatePem);return root;}
test('valid detached signature and full inventory verify against an external trusted key',async()=>{
  const result=await verifyBundle(await fixture(),publicPem);assert.equal(result.verifiedFiles,1);assert.equal(result.manifest.qualification,'BUILD_ARTIFACT_ONLY');
});
test('wrong trust root and modified manifest are rejected before import',async()=>{
  const root=await fixture(),other=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  await assert.rejects(verifyBundle(root,other),/SIGNATURE_INVALID/);
  writeFileSync(path.join(root,'bundle-manifest.json'),readFileSync(path.join(root,'bundle-manifest.json'),'utf8').replace('BUILD_ARTIFACT_ONLY','PRODUCTION_APPROVED'));
  await assert.rejects(verifyBundle(root,publicPem),/SIGNATURE_INVALID/);
});
test('same-length archive corruption and additional unsigned files are rejected',async()=>{
  const root=await fixture();writeFileSync(path.join(root,'images','app.tar'),'changed archive');await assert.rejects(verifyBundle(root,publicPem),/ARTIFACT_CHANGED/);
  const extra=await fixture();writeFileSync(path.join(extra,'extra.env'),'secret');await assert.rejects(verifyBundle(extra,publicPem),/INVENTORY_MISMATCH/);
});
test('Windows drive, traversal, UNC, empty segments and alternative stream names are rejected',()=>{
  for(const name of ['../x','a/../../x','C:/x','//server/x','a\\b','a//b','a/./b','a:stream','']) assert.throws(()=>safeBundlePath(os.tmpdir(),name),/UNSAFE_BUNDLE_PATH/);
});
test('SBOM reports unknown licenses and never implies security or legal approval',()=>{
  const report=summarizeSbom({bomFormat:'CycloneDX',components:[{name:'a',purl:'pkg:npm/a@1',licenses:[{license:{id:'MIT'}}]},{name:'b'}]});
  assert.equal(report.components,2);assert.equal(report.unknownLicense,1);assert.equal(report.licenses.MIT,1);assert.equal(report.licenseApproval,'NOT_GRANTED');
  assert.throws(()=>summarizeSbom({bomFormat:'CycloneDX',components:[]}),/NONEMPTY/);
});
