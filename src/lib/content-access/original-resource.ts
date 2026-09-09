import {and,asc,eq} from 'drizzle-orm';
import {db} from '@/storage/database/shared/db';
import {artifacts,artifactParts,guardJobs,mediaEvidenceSnapshots} from '@/storage/database/shared/schema';
import {scopePredicate,type TenantScope} from '@/lib/tenancy';
import {intakeBindingSchema} from '@/lib/guard-jobs/intake-binding';
import {nativeJobBindingSchema} from '@/lib/guard-jobs/native-binding';
import {archiveContentHmac} from '@/lib/gateway-runtime/security';
import {canonicalJson} from '@/lib/gateway-runtime/protocol';
import {parseOriginalResourceId,originalMimeSchema,ORIGINAL_MEDIA_MAX_BYTES,ORIGINAL_PDF_MAX_BYTES} from '@/contracts/http/original-preview';
type Reader=Pick<typeof db,'select'>;
/** Approval identifies one source and, for PDF, one page. Derived-text grants cannot authorize it. */
export async function readOriginalResource(reader:Reader,scope:TenantScope,id:string,now=new Date(),lock=false){
 const parsed=parseOriginalResourceId(id);
 const snapshotQuery=reader.select().from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,parsed.snapshotId))).limit(1);
 const [snapshot]=await(lock?snapshotQuery.for('share'):snapshotQuery);
 if(!snapshot||snapshot.state!=='READY'||!(snapshot.expiresAt>now||snapshot.holdUntil&&snapshot.holdUntil>now))return null;
 const jobQuery=reader.select().from(guardJobs).where(and(scopePredicate(guardJobs,scope),eq(guardJobs.id,snapshot.jobId))).limit(1);
 const [job]=await(lock?jobQuery.for('share'):jobQuery);
 if(!job||job.status!=='completed'||job.cancelledAt)return null;
 let expectedSha:string|undefined;
 if(job.jobType==='intake'){const binding=intakeBindingSchema.safeParse(job.executionBinding);if(!binding.success)return null;expectedSha=binding.data.artifacts.find(source=>source.id===parsed.artifactId)?.sha256;if(!expectedSha)return null;}
 else if(job.jobType==='native_joint'){const binding=nativeJobBindingSchema.safeParse(job.executionBinding);if(!binding.success)return null;expectedSha=binding.data.artifacts.find(source=>source.id===parsed.artifactId)?.sha256;if(!expectedSha)return null;}
 else if(job.artifactId!==parsed.artifactId)return null;
 const artifactQuery=reader.select().from(artifacts).where(and(scopePredicate(artifacts,scope),eq(artifacts.id,parsed.artifactId),eq(artifacts.ownerId,job.ownerId))).limit(1);
 const [artifact]=await(lock?artifactQuery.for('share'):artifactQuery);
 if(!artifact||artifact.state!=='accepted'||artifact.purgedAt||artifact.contentExpiresAt<=now||!artifact.verifiedSha256||!artifact.verifiedSize||expectedSha&&expectedSha!==artifact.verifiedSha256)return null;
 const pdf=artifact.kind==='DOCUMENT'&&artifact.detectedMediaType==='application/pdf';
 if(pdf?(parsed.page<1||artifact.verifiedSize>ORIGINAL_PDF_MAX_BYTES):(parsed.page!==0||!['IMAGE','AUDIO','VIDEO'].includes(artifact.kind)||!originalMimeSchema.safeParse(artifact.detectedMediaType).success||artifact.verifiedSize>ORIGINAL_MEDIA_MAX_BYTES))return null;
 const partQuery=reader.select().from(artifactParts).where(and(scopePredicate(artifactParts,scope),eq(artifactParts.artifactId,artifact.id))).orderBy(asc(artifactParts.partNumber));
 const parts=await(lock?partQuery.for('share'):partQuery);
 if(parts.length!==artifact.partCount||!parts.length||parts.some((part,index)=>part.partNumber!==index+1||part.state!=='verified')||parts.reduce((sum,part)=>sum+part.sizeBytes,0)!==artifact.verifiedSize)return null;
 const sourceDigest=archiveContentHmac(canonicalJson({version:'original-resource-1',id,snapshotDigest:snapshot.contentHmac,jobId:job.id,ownerId:artifact.ownerId,kind:artifact.kind,mimeType:artifact.detectedMediaType,sourceSha256:artifact.verifiedSha256,sizeBytes:artifact.verifiedSize,expiresAt:artifact.contentExpiresAt.toISOString(),parts:parts.map(part=>({number:part.partNumber,key:part.objectKey,sha256:part.sha256,sizeBytes:part.sizeBytes}))}),snapshot.keyIds[0]);
 return {...parsed,snapshot,job,artifact,parts,sourceDigest};
}
