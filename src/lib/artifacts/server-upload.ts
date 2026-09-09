import {setTimeout as delay} from 'node:timers/promises';
import {createHash,randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {db} from '@/storage/database/shared/db';
import {artifacts} from '@/storage/database/shared/schema';
import {scopePredicate,type TenantScope} from '@/lib/tenancy';
import {createArtifactUpload,completeArtifactUpload,signArtifactPart} from './service';
import {verifyNextArtifact} from './verifier';
export async function storeVerifiedBytes(input:{scope:TenantScope;ownerId:string;kind:string;fileName:string;mediaType:string;bytes:Buffer;metadata?:Record<string,unknown>;idempotencyKey?:string;signal?:AbortSignal}){
 const sha256=createHash('sha256').update(input.bytes).digest('hex');
 const {artifact}=await createArtifactUpload({...input,sizeBytes:input.bytes.length,sha256,idempotencyKey:input.idempotencyKey??'server-'+randomUUID(),retentionDays:7,metadata:input.metadata??{}});
 if(artifact.contentExpiresAt<=new Date())throw new Error('ARTIFACT_EXPIRED');
 if(artifact.state==='accepted')return artifact;
 if(artifact.state==='uploading'){
 const parts:Array<{partNumber:number;sizeBytes:number;sha256:string}>=[];
 for(let number=1;number<=artifact.partCount;number++){
  input.signal?.throwIfAborted();const part=input.bytes.subarray((number-1)*artifact.partSize,number*artifact.partSize),digest=createHash('sha256').update(part).digest();
  const signed=await signArtifactPart(input.scope,input.ownerId,artifact.id,number,digest.toString('base64'));
  const response=await fetch(signed.url,{method:'PUT',headers:signed.headers,body:Uint8Array.from(part).buffer,signal:input.signal?AbortSignal.any([input.signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000),redirect:'error'});
  await response.body?.cancel();if(!response.ok&&response.status!==412)throw new Error('ARTIFACT_STORAGE_WRITE_FAILED');parts.push({partNumber:number,sizeBytes:part.length,sha256:digest.toString('hex')});
 }
 await completeArtifactUpload(input.scope,input.ownerId,artifact.id,parts);
 }
 await verifyNextArtifact({...input.scope,ownerId:input.ownerId,id:artifact.id});
 for(let attempt=0;attempt<60;attempt++){
 input.signal?.throwIfAborted();
 const [verified]=await db.select().from(artifacts).where(and(scopePredicate(artifacts,input.scope),eq(artifacts.id,artifact.id),eq(artifacts.ownerId,input.ownerId))).limit(1);
 if(verified?.state==='accepted')return verified;
 if(!verified||['failed','quarantined','deleted'].includes(verified.state))throw new Error(verified?.failureCode??'ARTIFACT_VERIFICATION_FAILED');
 await delay(500,undefined,{signal:input.signal});
 }
 throw new Error('ARTIFACT_VERIFICATION_PENDING');
}
