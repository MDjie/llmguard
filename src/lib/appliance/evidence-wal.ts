import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';

type SigningKey = string | Buffer | KeyObject;

export type EvidenceDomain = 'AUDIT' | 'RUNTIME' | 'NETWORK_SECURITY' | 'MODEL_SECURITY';

export interface EvidenceInput {
  readonly domain: EvidenceDomain;
  readonly eventType: string;
  readonly occurredAtEpochMs: number;
  readonly policyBundleId: string;
  readonly decisionId?: string;
  readonly flowId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EvidenceRecordBody {
  readonly schemaVersion: '1.0';
  readonly deviceId: string;
  readonly sequence: number;
  readonly domain: EvidenceDomain;
  readonly eventType: string;
  readonly occurredAtEpochMs: number;
  readonly policyBundleId: string;
  readonly decisionId?: string;
  readonly flowId?: string;
  readonly payloadCanonicalJson: string;
  readonly payloadDigest: string;
  readonly previousRecordHash: string;
}

export interface SignedEvidenceRecord {
  readonly body: EvidenceRecordBody;
  readonly recordHash: string;
  readonly signatureAlgorithm: 'Ed25519';
  readonly signingKeyId: string;
  readonly signature: string;
}

export interface EvidenceExportBatch {
  readonly deviceId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly recordCount: number;
  readonly records: readonly SignedEvidenceRecord[];
  readonly batchDigest: string;
}

export interface EvidenceExportAck {
  readonly batchDigest: string;
  readonly throughSequence: number;
  readonly throughRecordHash: string;
}

export interface EvidenceWalStatus {
  readonly retainedRecords: number;
  readonly maximumRecords: number;
  readonly utilization: number;
  readonly highWatermarkReached: boolean;
  readonly protectedTrafficAdmissible: boolean;
  readonly lastSequence: number;
  readonly acknowledgedSequence: number;
}

function sha256(value: string): string {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function asPrivateKey(key: SigningKey): KeyObject {
  return typeof key === 'string' || Buffer.isBuffer(key) ? createPrivateKey(key) : key;
}

function asPublicKey(key: SigningKey): KeyObject {
  return typeof key === 'string' || Buffer.isBuffer(key) ? createPublicKey(key) : key;
}

function recordHash(body: EvidenceRecordBody): string {
  return sha256(canonicalJson(body));
}

function batchDigest(input: Omit<EvidenceExportBatch, 'records' | 'batchDigest'> & {
  readonly recordHashes: readonly string[];
}): string {
  return sha256(canonicalJson(input));
}

/**
 * Append-only reference WAL. Production storage must durably fsync the returned
 * record before the corresponding protected action is committed.
 */
export class EvidenceWal {
  private readonly records: SignedEvidenceRecord[] = [];
  private readonly pendingBatches = new Map<string, EvidenceExportBatch>();
  private nextSequence: number;
  private tailHash: string;
  private acknowledgedSequence = 0;

  constructor(private readonly options: {
    readonly deviceId: string;
    readonly signingKeyId: string;
    readonly privateKey: SigningKey;
    readonly maximumRecords: number;
    readonly highWatermarkRatio: number;
    readonly initialSequence?: number;
    readonly previousRecordHash?: string;
  }) {
    if (options.deviceId.length === 0 || options.signingKeyId.length === 0 ||
        !Number.isSafeInteger(options.maximumRecords) || options.maximumRecords < 1 ||
        !Number.isFinite(options.highWatermarkRatio) || options.highWatermarkRatio <= 0 ||
        options.highWatermarkRatio > 1) {
      throw new Error('EVIDENCE_WAL_OPTIONS_INVALID');
    }
    const initialSequence = options.initialSequence ?? 1;
    const previousRecordHash = options.previousRecordHash ?? 'GENESIS';
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 1 ||
        (initialSequence === 1 && previousRecordHash !== 'GENESIS') ||
        (initialSequence > 1 && !/^sha256:[a-f0-9]{64}$/u.test(previousRecordHash))) {
      throw new Error('EVIDENCE_WAL_RECOVERY_ANCHOR_INVALID');
    }
    this.nextSequence = initialSequence;
    this.tailHash = previousRecordHash;
    this.acknowledgedSequence = initialSequence - 1;
  }

  append(input: EvidenceInput): SignedEvidenceRecord {
    if (!this.canAppend() || input.eventType.length === 0 ||
        !Number.isSafeInteger(input.occurredAtEpochMs) || input.occurredAtEpochMs < 1 ||
        input.policyBundleId.length === 0) {
      throw new Error(this.canAppend()
        ? 'EVIDENCE_INPUT_INVALID'
        : 'EVIDENCE_CAPACITY_EXHAUSTED');
    }
    const payloadCanonicalJson = canonicalJson(input.payload);
    const body: EvidenceRecordBody = {
      schemaVersion: '1.0',
      deviceId: this.options.deviceId,
      sequence: this.nextSequence,
      domain: input.domain,
      eventType: input.eventType,
      occurredAtEpochMs: input.occurredAtEpochMs,
      policyBundleId: input.policyBundleId,
      ...(input.decisionId ? { decisionId: input.decisionId } : {}),
      ...(input.flowId ? { flowId: input.flowId } : {}),
      payloadCanonicalJson,
      payloadDigest: sha256(payloadCanonicalJson),
      previousRecordHash: this.tailHash,
    };
    const hash = recordHash(body);
    const record: SignedEvidenceRecord = {
      body,
      recordHash: hash,
      signatureAlgorithm: 'Ed25519',
      signingKeyId: this.options.signingKeyId,
      signature: sign(null, Buffer.from(hash), asPrivateKey(this.options.privateKey))
        .toString('base64url'),
    };
    this.records.push(record);
    this.nextSequence += 1;
    this.tailHash = hash;
    return record;
  }

  createExportBatch(maximumRecords: number): EvidenceExportBatch | undefined {
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1) {
      throw new Error('EVIDENCE_EXPORT_LIMIT_INVALID');
    }
    const selected = this.records
      .filter((record) => record.body.sequence > this.acknowledgedSequence)
      .slice(0, maximumRecords);
    const first = selected[0];
    const last = selected.at(-1);
    if (!first || !last) return undefined;
    const summary = {
      deviceId: this.options.deviceId,
      firstSequence: first.body.sequence,
      lastSequence: last.body.sequence,
      recordCount: selected.length,
      recordHashes: selected.map((record) => record.recordHash),
    };
    const batch: EvidenceExportBatch = {
      deviceId: summary.deviceId,
      firstSequence: summary.firstSequence,
      lastSequence: summary.lastSequence,
      recordCount: summary.recordCount,
      records: selected,
      batchDigest: batchDigest(summary),
    };
    this.pendingBatches.set(batch.batchDigest, batch);
    return batch;
  }

  acknowledgeExport(ack: EvidenceExportAck): void {
    const batch = this.pendingBatches.get(ack.batchDigest);
    const last = batch?.records.at(-1);
    if (!batch || !last || ack.throughSequence !== batch.lastSequence ||
        ack.throughRecordHash !== last.recordHash) {
      throw new Error('EVIDENCE_EXPORT_ACK_INVALID');
    }
    if (ack.throughSequence < this.acknowledgedSequence) {
      throw new Error('EVIDENCE_EXPORT_ACK_STALE');
    }
    this.acknowledgedSequence = ack.throughSequence;
    this.pendingBatches.delete(ack.batchDigest);
  }

  compactAcknowledged(): number {
    const before = this.records.length;
    const retained = this.records.filter(
      (record) => record.body.sequence > this.acknowledgedSequence,
    );
    this.records.splice(0, this.records.length, ...retained);
    for (const [key, batch] of this.pendingBatches) {
      if (batch.lastSequence <= this.acknowledgedSequence) this.pendingBatches.delete(key);
    }
    return before - this.records.length;
  }

  status(): EvidenceWalStatus {
    const utilization = this.records.length / this.options.maximumRecords;
    return {
      retainedRecords: this.records.length,
      maximumRecords: this.options.maximumRecords,
      utilization,
      highWatermarkReached: utilization >= this.options.highWatermarkRatio,
      protectedTrafficAdmissible: this.canAppend(),
      lastSequence: this.nextSequence - 1,
      acknowledgedSequence: this.acknowledgedSequence,
    };
  }

  canAppend(): boolean {
    return this.records.length < this.options.maximumRecords;
  }
}

export function verifyEvidenceRecords(input: {
  readonly records: readonly SignedEvidenceRecord[];
  readonly expectedDeviceId: string;
  readonly startingSequence: number;
  readonly previousRecordHash: string;
  readonly keyResolver: (keyId: string) => SigningKey | undefined;
}): boolean {
  let sequence = input.startingSequence;
  let previous = input.previousRecordHash;
  for (const record of input.records) {
    if (record.signatureAlgorithm !== 'Ed25519' ||
        record.body.deviceId !== input.expectedDeviceId ||
        record.body.sequence !== sequence || record.body.previousRecordHash !== previous ||
        sha256(record.body.payloadCanonicalJson) !== record.body.payloadDigest ||
        recordHash(record.body) !== record.recordHash) return false;
    const key = input.keyResolver(record.signingKeyId);
    if (!key) return false;
    try {
      if (!verify(null, Buffer.from(record.recordHash), asPublicKey(key),
        Buffer.from(record.signature, 'base64url'))) return false;
    } catch {
      return false;
    }
    previous = record.recordHash;
    sequence += 1;
  }
  return true;
}
