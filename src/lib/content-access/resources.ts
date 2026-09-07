import { and, eq, gt, inArray, or } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { archivedContentObjects, conversationArchives, mediaEvidenceSnapshots, securityIncidents } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { incidentEvidenceDigest } from '@/lib/incidents/projection';
export type ContentResourceType = 'INCIDENT_EVIDENCE' | 'ARCHIVED_CONTENT' | 'MEDIA_EVIDENCE';
export async function readAccessResourceDigest(reader: Pick<typeof db, 'select'>, scope: TenantScope, type: string, id: string, now = new Date(), lock = false) {
  if (type === 'INCIDENT_EVIDENCE') {
    const query = reader.select({ value: securityIncidents.answerEvidence }).from(securityIncidents).where(and(scopePredicate(securityIncidents, scope), eq(securityIncidents.id, id))).limit(1);
    const [row] = await (lock ? query.for('share') : query); return row ? incidentEvidenceDigest(row.value) : null;
  }
  if(type==='MEDIA_EVIDENCE'){
    const query=reader.select({digest:mediaEvidenceSnapshots.contentHmac}).from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,id),eq(mediaEvidenceSnapshots.state,'READY'),or(gt(mediaEvidenceSnapshots.expiresAt,now),gt(mediaEvidenceSnapshots.holdUntil,now)))).limit(1);
    const [row]=await(lock?query.for('share'):query);return row?.digest??null;
  }
  if (type !== 'ARCHIVED_CONTENT') return null;
  const query = reader.select({ digest: archivedContentObjects.contentHmac }).from(archivedContentObjects).innerJoin(conversationArchives,
    and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, archivedContentObjects.requestId)))
    .where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.id, id), inArray(archivedContentObjects.state, ['MANIFEST_COMMITTED','INDEXED']),
      inArray(conversationArchives.state, ['OPEN','COMMITTED','GAPPED']), or(gt(conversationArchives.expiresAt, now), gt(conversationArchives.holdUntil, now)))).limit(1);
  const [row] = await (lock ? query.for('share') : query); return row?.digest ?? null;
}
