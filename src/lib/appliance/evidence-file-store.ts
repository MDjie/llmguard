import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type { SignedEvidenceRecord } from './evidence-wal';
import { verifyEvidenceRecords } from './evidence-wal';

type VerificationKey = Parameters<typeof verifyEvidenceRecords>[0]['keyResolver'];

interface EvidenceFileHeader {
  readonly kind: 'EVIDENCE_WAL_HEADER';
  readonly schemaVersion: '1.0';
  readonly deviceId: string;
  readonly startingSequence: number;
  readonly previousRecordHash: string;
}

export interface EvidenceRecoveryResult {
  readonly header: EvidenceFileHeader;
  readonly records: readonly SignedEvidenceRecord[];
  readonly fileBytes: number;
}

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function signedRecord(value: unknown): value is SignedEvidenceRecord {
  if (!object(value) || !object(value.body)) return false;
  return value.signatureAlgorithm === 'Ed25519' && typeof value.signingKeyId === 'string' &&
    typeof value.signature === 'string' && typeof value.recordHash === 'string' &&
    value.body.schemaVersion === '1.0' && typeof value.body.deviceId === 'string' &&
    typeof value.body.sequence === 'number' && typeof value.body.previousRecordHash === 'string' &&
    typeof value.body.payloadCanonicalJson === 'string' && typeof value.body.payloadDigest === 'string';
}

function header(value: unknown): value is EvidenceFileHeader {
  return object(value) && value.kind === 'EVIDENCE_WAL_HEADER' &&
    value.schemaVersion === '1.0' && typeof value.deviceId === 'string' &&
    typeof value.startingSequence === 'number' &&
    Number.isSafeInteger(value.startingSequence) && value.startingSequence >= 1 &&
    typeof value.previousRecordHash === 'string';
}

/** Durable NDJSON WAL backend. Each accepted append is fsynced before return. */
export class EvidenceFileStore {
  readonly filePath: string;

  constructor(private readonly options: {
    readonly filePath: string;
    readonly deviceId: string;
    readonly maximumFileBytes: number;
    readonly keyResolver: VerificationKey;
  }) {
    if (!isAbsolute(options.filePath) || options.deviceId.length === 0 ||
        !Number.isSafeInteger(options.maximumFileBytes) || options.maximumFileBytes < 1_024) {
      throw new Error('EVIDENCE_FILE_OPTIONS_INVALID');
    }
    this.filePath = resolve(options.filePath);
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const metadata = await lstat(this.filePath);
      if (!metadata.isFile()) throw new Error('EVIDENCE_FILE_NOT_REGULAR');
    } catch (error) {
      if (!(object(error) && error.code === 'ENOENT')) throw error;
    }
    const handle = await open(this.filePath, 'a', 0o600);
    try {
      const metadata = await handle.stat();
      if (metadata.size === 0) {
        const initial: EvidenceFileHeader = {
          kind: 'EVIDENCE_WAL_HEADER', schemaVersion: '1.0',
          deviceId: this.options.deviceId, startingSequence: 1, previousRecordHash: 'GENESIS',
        };
        await handle.write(canonicalJson(initial) + '\n');
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
  }

  async recover(): Promise<EvidenceRecoveryResult> {
    await access(this.filePath, constants.R_OK);
    const bytes = await readFile(this.filePath);
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) {
      throw new Error('EVIDENCE_FILE_TORN_WRITE');
    }
    const lines = bytes.toString('utf8').split('\n').slice(0, -1);
    if (lines.length === 0) throw new Error('EVIDENCE_FILE_HEADER_MISSING');
    let parsedHeader: unknown;
    try {
      parsedHeader = JSON.parse(lines[0] ?? '');
    } catch {
      throw new Error('EVIDENCE_FILE_HEADER_INVALID');
    }
    if (!header(parsedHeader) || parsedHeader.deviceId !== this.options.deviceId) {
      throw new Error('EVIDENCE_FILE_HEADER_INVALID');
    }
    const records: SignedEvidenceRecord[] = [];
    for (const line of lines.slice(1)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error('EVIDENCE_FILE_RECORD_INVALID');
      }
      if (!signedRecord(parsed)) throw new Error('EVIDENCE_FILE_RECORD_INVALID');
      records.push(parsed);
    }
    if (!verifyEvidenceRecords({
      records,
      expectedDeviceId: this.options.deviceId,
      startingSequence: parsedHeader.startingSequence,
      previousRecordHash: parsedHeader.previousRecordHash,
      keyResolver: this.options.keyResolver,
    })) {
      throw new Error('EVIDENCE_FILE_CHAIN_INVALID');
    }
    return { header: parsedHeader, records, fileBytes: bytes.length };
  }

  async appendDurably(record: SignedEvidenceRecord): Promise<void> {
    const recovered = await this.recover();
    const last = recovered.records.at(-1);
    const expectedSequence = last
      ? last.body.sequence + 1
      : recovered.header.startingSequence;
    const expectedPrevious = last?.recordHash ?? recovered.header.previousRecordHash;
    if (record.body.deviceId !== this.options.deviceId ||
        record.body.sequence !== expectedSequence ||
        record.body.previousRecordHash !== expectedPrevious ||
        !verifyEvidenceRecords({
          records: [record],
          expectedDeviceId: this.options.deviceId,
          startingSequence: expectedSequence,
          previousRecordHash: expectedPrevious,
          keyResolver: this.options.keyResolver,
        })) {
      throw new Error('EVIDENCE_FILE_APPEND_CHAIN_INVALID');
    }
    const line = canonicalJson(record) + '\n';
    if (recovered.fileBytes + Buffer.byteLength(line) > this.options.maximumFileBytes) {
      throw new Error('EVIDENCE_FILE_CAPACITY_EXHAUSTED');
    }
    const handle = await open(this.filePath, 'a', 0o600);
    try {
      await handle.write(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
