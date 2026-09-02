import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle';

const TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9._+:/@-]{1,256}$/u;

export interface LineageEdgeInput {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly operation: string;
  readonly processorId: string;
  readonly processorVersion: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly createdAt?: Date;
}

export interface DeletionManifestEntry {
  readonly objectType: string;
  readonly count: number;
  readonly idDigest: string;
}

export interface DeletionPhase {
  readonly state: 'COMPLETE' | 'NOT_APPLICABLE' | 'PENDING_EXTERNAL';
  readonly evidence?: string;
}

export interface DeletionProofInput {
  readonly cutoff: Date;
  readonly manifest: readonly DeletionManifestEntry[];
  readonly phases: Readonly<Record<string, DeletionPhase>>;
  readonly completedAt?: Date;
  readonly proofId?: string;
}

export interface SignedDeletionProof {
  readonly version: '1.0';
  readonly proofId: string;
  readonly cutoff: string;
  readonly manifest: readonly DeletionManifestEntry[];
  readonly phases: Readonly<Record<string, DeletionPhase>>;
  readonly completedAt: string;
  readonly keyId: string;
  readonly signature: string;
}

function requireType(value: string, name: string): string {
  if (!TYPE_PATTERN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requireId(value: string, name: string): string {
  if (!ID_PATTERN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requireVersion(value: string): string {
  if (!VERSION_PATTERN.test(value)) throw new Error('processorVersion is invalid');
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deletionProofConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const key = environment.DELETION_PROOF_HMAC_KEY ?? '';
  const keyId = environment.DELETION_PROOF_HMAC_KEY_ID ?? '';
  if (Buffer.byteLength(key, 'utf8') < 32) {
    throw new Error('DELETION_PROOF_HMAC_KEY must contain at least 32 bytes');
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(keyId)) {
    throw new Error('DELETION_PROOF_HMAC_KEY_ID is invalid');
  }
  return { key, keyId };
}

export function lineageObjectIdDigest(ids: readonly (string | number)[]): string {
  return sha256(canonicalJson([...ids].map(String).sort()));
}

export function buildLineageEdge(input: LineageEdgeInput) {
  const attributes = input.attributes ?? {};
  const createdAt = input.createdAt ?? new Date();
  const protectedEvidence = {
    version: '1.0',
    tenantId: requireId(input.tenantId, 'tenantId'),
    applicationId: requireId(input.applicationId, 'applicationId'),
    sourceType: requireType(input.sourceType, 'sourceType'),
    sourceId: requireId(input.sourceId, 'sourceId'),
    targetType: requireType(input.targetType, 'targetType'),
    targetId: requireId(input.targetId, 'targetId'),
    operation: requireType(input.operation, 'operation'),
    processorId: requireId(input.processorId, 'processorId'),
    processorVersion: requireVersion(input.processorVersion),
    attributes,
    createdAt: createdAt.toISOString(),
  };
  return {
    ...protectedEvidence,
    evidenceHash: sha256(canonicalJson(protectedEvidence)),
    createdAt,
  };
}

function unsignedDeletionProof(proof: SignedDeletionProof) {
  return {
    version: proof.version,
    proofId: proof.proofId,
    cutoff: proof.cutoff,
    manifest: proof.manifest,
    phases: proof.phases,
    completedAt: proof.completedAt,
    keyId: proof.keyId,
  };
}

export function buildDeletionProof(
  input: DeletionProofInput,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SignedDeletionProof {
  const config = deletionProofConfiguration(environment);
  if (Number.isNaN(input.cutoff.getTime())) throw new Error('cutoff is invalid');
  const manifest = [...input.manifest]
    .map((entry) => ({
      objectType: requireType(entry.objectType, 'objectType'),
      count: entry.count,
      idDigest: entry.idDigest.toLowerCase(),
    }))
    .sort((left, right) => left.objectType.localeCompare(right.objectType));
  for (const entry of manifest) {
    if (!Number.isInteger(entry.count) || entry.count < 0) {
      throw new Error('Deletion manifest count is invalid');
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.idDigest)) {
      throw new Error('Deletion manifest idDigest is invalid');
    }
  }
  if (manifest.length === 0 || manifest.every((entry) => entry.count === 0)) {
    throw new Error('Deletion proof requires at least one deleted object');
  }
  const phases = Object.fromEntries(
    Object.entries(input.phases).sort(([left], [right]) => left.localeCompare(right)),
  );
  if (!phases.database || phases.database.state !== 'COMPLETE') {
    throw new Error('Deletion proof requires a completed database phase');
  }
  const proof: SignedDeletionProof = {
    version: '1.0',
    proofId: input.proofId ?? randomUUID(),
    cutoff: input.cutoff.toISOString(),
    manifest,
    phases,
    completedAt: (input.completedAt ?? new Date()).toISOString(),
    keyId: config.keyId,
    signature: '',
  };
  if (!/^[a-f0-9-]{36}$/u.test(proof.proofId)) throw new Error('proofId is invalid');
  const signature = createHmac('sha256', config.key)
    .update(canonicalJson(unsignedDeletionProof(proof)), 'utf8')
    .digest('hex');
  return { ...proof, signature };
}

export function verifyDeletionProof(
  proof: SignedDeletionProof,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  try {
    const config = deletionProofConfiguration(environment);
    if (proof.version !== '1.0' || proof.keyId !== config.keyId) return false;
    const expected = createHmac('sha256', config.key)
      .update(canonicalJson(unsignedDeletionProof(proof)), 'utf8')
      .digest();
    const actual = Buffer.from(proof.signature, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
