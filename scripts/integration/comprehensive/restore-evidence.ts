import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readMediaEvidence} from '@/lib/evidence/media-snapshots';
import {readAcceptedArtifactBytes} from '@/lib/artifacts/binary-reader';
import {readOriginalResource} from '@/lib/content-access/original-resource';
import {db,closeDatabaseConnection} from '@/storage/database/shared/db';
const out=resolve(process.env.COMPREHENSIVE_RUN_DIR!);
const f=JSON.parse(readFileSync(out+'/fixture.private.json','utf8')) as {tenantId:string;applicationId:string};
const preview=JSON.parse(readFileSync(out+'/original-preview-fixture.json','utf8')) as {snapshotId:string;audioId:string;audioArtifactId:string};
async function main(){
 const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5438');assert.match(url.pathname,/^\/guardllm_integration_full_\d+$/);
 const scope={tenantId:f.tenantId,applicationId:f.applicationId};
 const {content}=await readMediaEvidence(scope,preview.snapshotId);assert.equal(content.views.length,2);assert.deepEqual(content.reviewEvidence?.map(item=>item.polarity),['SUPPORT','COUNTER']);
 const resource=await readOriginalResource(db,scope,preview.audioId);assert.ok(resource);
 const bytes=await readAcceptedArtifactBytes(scope,preview.audioArtifactId,16*1024*1024,['AUDIO']);try{assert.equal(createHash('sha256').update(bytes).digest('hex'),resource.artifact.verifiedSha256);}finally{bytes.fill(0);}
 writeFileSync(out+'/restored-evidence.json',JSON.stringify({status:'PASS',encryptedSnapshotReplayed:true,originalPartsVerified:true,reviewEvidencePreserved:true},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'unknown');process.exitCode=1;}).finally(closeDatabaseConnection);
