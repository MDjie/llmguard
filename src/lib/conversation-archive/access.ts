import { authorizedMediaAnnotations } from '@/lib/evidence/media-annotations';
import { mediaProvenanceSchema,type MediaAnnotation } from '@/contracts/http/media-evidence';
import { evidenceSnapshotSchema } from '@/contracts/http/media-evidence';
import { highlightMediaViews } from '@/lib/evidence/media-views';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { ApiProblem } from '@/lib/api-security';
import { db } from '@/storage/database/shared/db';
import { contentAccessRequests, archivedContentObjects, securityAlerts } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantContext } from '@/lib/tenancy';
import { readAccessResourceDigest } from '@/lib/content-access/resources';
import { authorizedArchiveHighlights } from '@/lib/evidence/authorized-highlight';
import { readArchivedContent } from './service';
import type { ArchiveObjectStore } from './object-store';
const problem = (code: string) => new ApiProblem({ status: 409, code, title: 'Archive access unavailable', detail: code });
export async function consumeArchivedContentAccess(scope: TenantContext, contentId: string, requestId: string, store?: ArchiveObjectStore, afterConsume?: (transaction:Parameters<Parameters<typeof db.transaction>[0]>[0], payload:{answerEvidence:string;sourceDigest:string;highlightViews:ReturnType<typeof authorizedArchiveHighlights>})=>Promise<void>) {
  const predicate = and(scopePredicate(contentAccessRequests, scope), eq(contentAccessRequests.id, requestId), eq(contentAccessRequests.resourceType, 'ARCHIVED_CONTENT'),
    eq(contentAccessRequests.resourceId, contentId), eq(contentAccessRequests.requesterId, scope.principalId), eq(contentAccessRequests.status, 'approved'), gt(contentAccessRequests.expiresAt, new Date()));
  const [approved] = await db.select().from(contentAccessRequests).where(predicate).limit(1);
  if (!approved || approved.usedAt) throw problem('CONTENT_ACCESS_GRANT_NOT_AVAILABLE');
  if (await readAccessResourceDigest(db, scope, 'ARCHIVED_CONTENT', contentId) !== approved.sourceDigest) throw problem('CONTENT_ACCESS_SOURCE_CHANGED');
  // Read outside locks, then consume under a fresh identity/digest/expiry check. Failed storage reads do not burn a grant.
  const content = await readArchivedContent(scope, contentId, store);
  const [object] = await db.select({ requestId: archivedContentObjects.requestId }).from(archivedContentObjects).where(and(scopePredicate(archivedContentObjects,scope),eq(archivedContentObjects.id,contentId))).limit(1);
  const alerts = object ? await db.select({ sourceId: securityAlerts.sourceId, stage: securityAlerts.stage, evidence: securityAlerts.evidence }).from(securityAlerts).where(and(scopePredicate(securityAlerts,scope),eq(securityAlerts.requestId,object.requestId))).limit(1000) : [];
  const parsedMedia = content.reference.representation === 'MEDIA_BYTES' ? z.object({ mimeType:z.enum(['image/png','image/jpeg','image/webp','image/gif','audio/wav','audio/x-wav','audio/mpeg','video/mp4']),sha256:z.string().regex(/^[a-f0-9]{64}$/),dataBase64:z.string().min(1).max(1398104) }).loose().safeParse(content.content) : null;
  let media:{mimeType:'image/png'|'image/jpeg'|'image/webp'|'image/gif'|'audio/wav'|'audio/x-wav'|'audio/mpeg'|'video/mp4';dataBase64:string;annotations?:MediaAnnotation[]}|undefined;
  if(parsedMedia?.success){const bytes=Buffer.from(parsedMedia.data.dataBase64,'base64');try{if(bytes.length<=1048576 && bytes.toString('base64')===parsedMedia.data.dataBase64 && createHash('sha256').update(bytes).digest('hex')===parsedMedia.data.sha256)media={mimeType:parsedMedia.data.mimeType,dataBase64:parsedMedia.data.dataBase64};}finally{bytes.fill(0);}}
  if(media&&parsedMedia?.success){const provenance=mediaProvenanceSchema.safeParse(parsedMedia.data.provenance);if(provenance.success&&typeof parsedMedia.data.artifactId==='string'){
    const sourceAlerts=await db.select({evidence:securityAlerts.evidence}).from(securityAlerts).where(and(scopePredicate(securityAlerts,scope),eq(securityAlerts.jobId,provenance.data.jobId))).limit(1000);
    media.annotations=authorizedMediaAnnotations(parsedMedia.data.artifactId,parsedMedia.data.sha256,media.mimeType,provenance.data,sourceAlerts);
  }}
  const derived=evidenceSnapshotSchema.safeParse(content.content);
  const derivedAlerts=derived.success?await db.select({evidence:securityAlerts.evidence}).from(securityAlerts).where(and(scopePredicate(securityAlerts,scope),eq(securityAlerts.jobId,derived.data.jobId))).limit(1000):[];
  const highlightViews = derived.success?highlightMediaViews(derived.data.views,derivedAlerts):object ? authorizedArchiveHighlights(content.content,content.reference,object.requestId,alerts) : [];
  return db.transaction(async transaction => {
    const [current] = await transaction.select().from(contentAccessRequests).where(predicate).limit(1).for('update');
    const now = new Date();
    if (!current || current.usedAt || !current.expiresAt || current.expiresAt <= now) throw problem('CONTENT_ACCESS_GRANT_NOT_AVAILABLE');
    if (await readAccessResourceDigest(transaction, scope, 'ARCHIVED_CONTENT', contentId, now, true) !== current.sourceDigest) throw problem('CONTENT_ACCESS_SOURCE_CHANGED');
    await transaction.update(contentAccessRequests).set({ usedAt: now }).where(and(scopePredicate(contentAccessRequests, scope), eq(contentAccessRequests.id, requestId)));
    const payload = { incidentId: contentId, accessRequestId: requestId, sourceDigest: current.sourceDigest, expiresAt: current.expiresAt.toISOString(), consumedAt: now.toISOString(), answerEvidence: JSON.stringify(content.content, null, 2), highlightViews, ...(media ? {media} : {}) };
    await afterConsume?.(transaction,payload);return payload;
  });
}
