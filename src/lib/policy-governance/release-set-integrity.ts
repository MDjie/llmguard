import { verify } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import { policySigningKeyId, verificationPublicKey } from '@/lib/policy-bundle/crypto';
import type { dictionaryReleases, dictionaryReleaseSets } from '@/storage/database/shared/schema';
import { verifyReleaseSetArtifact } from './release-set';
import { PolicyGovernanceOperationError } from './errors';

export type ReleaseSetRow = typeof dictionaryReleaseSets.$inferSelect;
export function releaseSetSigningPayload(row: Pick<ReleaseSetRow,'tenantId'|'applicationId'|'canonicalManifest'>): string {
  return canonicalJson({tenantId:row.tenantId,applicationId:row.applicationId,artifact:row.canonicalManifest});
}

export function verifyStoredReleaseSet(row: ReleaseSetRow) {
  try {
    const artifact=verifyReleaseSetArtifact(row.canonicalManifest);
    if(artifact.releaseSetDigest!==row.contentHash || artifact.policyId!==row.policyId ||
      artifact.dictionaryId!==row.dictionaryId || artifact.version!==row.version ||
      artifact.shards.length!==row.shardCount || row.signingKeyId!==policySigningKeyId() ||
      !verify(null,Buffer.from(releaseSetSigningPayload(row)),verificationPublicKey(),Buffer.from(row.signature,'base64url'))) {
      throw new Error('integrity mismatch');
    }
    return artifact;
  } catch {
    throw new PolicyGovernanceOperationError('DICTIONARY_SET_INTEGRITY_INVALID','Dictionary release-set signature or content is invalid.',422);
  }
}

export function verifyReleaseSetMembers(root: ReleaseSetRow, members: readonly (typeof dictionaryReleases.$inferSelect)[]) {
  const artifact=verifyStoredReleaseSet(root);
  const parts=new Set<number>();
  if(members.length!==artifact.shards.length) throw new PolicyGovernanceOperationError('DICTIONARY_SET_INCOMPLETE','The complete release set is required.',422);
  for(const member of members) {
    const part=member.partNumber ?? 0;
    const shard=artifact.shards[part-1];
    if(!shard || parts.has(part) || member.releaseSetId!==root.id || member.tenantId!==root.tenantId ||
      member.applicationId!==root.applicationId || member.state!==root.state ||
      member.approvedBy!==root.approvedBy || member.submittedBy!==root.submittedBy ||
      member.contentHash!==shard.sha256 || canonicalJson(member.canonicalManifest)!==canonicalJson(shard.manifest)) {
      throw new PolicyGovernanceOperationError('DICTIONARY_SET_MIXED','Mixed, altered or incorrectly scoped dictionary shards were rejected.',422);
    }
    parts.add(part);
  }
  return artifact;
}
