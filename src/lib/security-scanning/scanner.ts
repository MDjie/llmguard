import { createHash, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { safeFetchJson, type SafeFetchDependencies } from '@/lib/egress/safe-fetch';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import {
  trustedSupplyChainKeysFromEnvironment,
  validateSupplyChainArtifactManifest,
  type SupplyChainArtifactManifest,
} from '@/lib/supply-chain';

export type SecurityScanKind = 'HOST' | 'WEB' | 'MODEL_SUPPLY_CHAIN';
export type SecurityScanTargetType = 'REGISTERED_HOST' | 'REGISTERED_WEB_APP' | 'MODEL_ARTIFACT';

export interface SecurityScanTarget {
  readonly type: SecurityScanTargetType;
  readonly inventoryId: string;
  readonly version: string;
  readonly sha256?: string;
}

export interface SecurityScannerDefinition {
  readonly id: string;
  readonly scanKind: SecurityScanKind;
  readonly adapterVersion: string;
  readonly baseUrl: string;
  readonly path: string;
  readonly providerType: 'custom';
  readonly supportedTargetTypes: readonly SecurityScanTargetType[];
  readonly maximumDurationMs: number;
  readonly maximumFindings: number;
  readonly artifact: SupplyChainArtifactManifest;
}

export interface SecurityScanFinding {
  readonly fingerprint: string;
  readonly ruleId: string;
  readonly category: string;
  readonly severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly title: string;
  readonly evidenceDigest: string;
  readonly remediation?: string;
}

export interface SecurityScanResult {
  readonly scannerId: string;
  readonly scannerVersion: string;
  readonly scannerDigest: string;
  readonly target: SecurityScanTarget;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly findings: readonly SecurityScanFinding[];
  readonly rawOutputDigest: string;
}

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const artifactSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.enum([
    'CODE', 'MODEL', 'DATASET', 'RULE_DATABASE', 'MCP', 'SKILL', 'VULNERABILITY_DATABASE',
  ]),
  version: z.string().min(1).max(256),
  sourceUri: z.url().max(2_048),
  sourceDigest: digest,
  licenseSpdx: z.string().min(1).max(128),
  noticeDigest: digest,
  scannerDefinitionDigest: digest,
  signatureKeyId: z.string().min(1).max(128),
  signature: z.string().min(16).max(4_096),
  permissions: z.array(z.string().min(1).max(256)).max(128),
  networkDomains: z.array(z.string().min(1).max(253)).max(128),
  filePaths: z.array(z.string().min(1).max(1_024)).max(128),
  commands: z.array(z.string().min(1).max(512)).max(128),
  credentialRefs: z.array(z.string().min(1).max(256)).max(128),
  approvalIds: z.array(z.string().min(1).max(128)).min(2).max(16),
  isolatedDynamicAnalysis: z.boolean(),
}).strict();

const definitionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  scanKind: z.enum(['HOST', 'WEB', 'MODEL_SUPPLY_CHAIN']),
  adapterVersion: z.string().min(1).max(128),
  baseUrl: z.url().max(2_048),
  path: z.string().regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,1024}$/),
  providerType: z.literal('custom'),
  supportedTargetTypes: z.array(
    z.enum(['REGISTERED_HOST', 'REGISTERED_WEB_APP', 'MODEL_ARTIFACT']),
  ).min(1).max(3),
  maximumDurationMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1_000),
  maximumFindings: z.number().int().min(1).max(100_000),
  artifact: artifactSchema,
}).strict();

const resultSchema = z.object({
  scannerId: z.string().min(1).max(128),
  scannerVersion: z.string().min(1).max(256),
  scannerDigest: digest,
  target: z.object({
    type: z.enum(['REGISTERED_HOST', 'REGISTERED_WEB_APP', 'MODEL_ARTIFACT']),
    inventoryId: z.string().min(1).max(256),
    version: z.string().min(1).max(256),
    sha256: digest.optional(),
  }).strict(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  findings: z.array(z.object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    ruleId: z.string().min(1).max(256),
    category: z.string().min(1).max(128),
    severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    title: z.string().min(1).max(500),
    evidenceDigest: digest,
    remediation: z.string().min(1).max(4_096).optional(),
  }).strict()).max(100_000),
  rawOutputDigest: digest,
}).strict();

function unsignedDefinition(definition: SecurityScannerDefinition) {
  const { artifact: _artifact, ...unsigned } = definition;
  void _artifact;
  return unsigned;
}

export function securityScannerDefinitionDigest(
  definition: SecurityScannerDefinition,
): string {
  return 'sha256:' + createHash('sha256')
    .update(canonicalJson(unsignedDefinition(definition)))
    .digest('hex');
}

export function validateSecurityScannerDefinition(
  definition: SecurityScannerDefinition,
  trustedKeys: ReadonlyMap<string, KeyObject>,
): void {
  definitionSchema.parse(definition);
  validateSupplyChainArtifactManifest(definition.artifact, trustedKeys);
  if (definition.artifact.type !== 'CODE') {
    throw new Error('SECURITY_SCANNER_CODE_ARTIFACT_REQUIRED');
  }
  if (definition.artifact.scannerDefinitionDigest !== securityScannerDefinitionDigest(definition)) {
    throw new Error('SECURITY_SCANNER_DEFINITION_DIGEST_MISMATCH');
  }
  const endpointHost = new URL(definition.baseUrl).hostname.toLowerCase();
  if (!definition.artifact.networkDomains.map((host) => host.toLowerCase()).includes(endpointHost)) {
    throw new Error('SECURITY_SCANNER_NETWORK_CAPABILITY_MISSING');
  }
  const requiredPermission = 'scan:' + definition.scanKind.toLowerCase();
  if (!definition.artifact.permissions.includes(requiredPermission)) {
    throw new Error('SECURITY_SCANNER_PERMISSION_MISSING');
  }
  const expectedTarget = definition.scanKind === 'HOST'
    ? 'REGISTERED_HOST'
    : definition.scanKind === 'WEB'
      ? 'REGISTERED_WEB_APP'
      : 'MODEL_ARTIFACT';
  if (!definition.supportedTargetTypes.includes(expectedTarget)) {
    throw new Error('SECURITY_SCANNER_TARGET_CAPABILITY_MISSING');
  }
}

export function loadSecurityScannerCatalog(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  trustedKeys = trustedSupplyChainKeysFromEnvironment(environment),
): ReadonlyMap<string, SecurityScannerDefinition> {
  const raw = environment.SECURITY_SCANNER_DEFINITIONS_JSON;
  if (!raw) return new Map();
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error('SECURITY_SCANNER_DEFINITIONS_JSON_INVALID');
  }
  const definitions = z.array(definitionSchema).min(1).max(32).parse(candidate);
  const catalog = new Map<string, SecurityScannerDefinition>();
  for (const definition of definitions) {
    if (catalog.has(definition.id)) throw new Error('SECURITY_SCANNER_ID_DUPLICATE');
    validateSecurityScannerDefinition(definition, trustedKeys);
    catalog.set(definition.id, definition);
  }
  return catalog;
}

export function validateSecurityScanTarget(
  definition: SecurityScannerDefinition,
  target: SecurityScanTarget,
): void {
  if (!definition.supportedTargetTypes.includes(target.type)) {
    throw new Error('SECURITY_SCAN_TARGET_TYPE_NOT_SUPPORTED');
  }
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(target.inventoryId) || !target.version) {
    throw new Error('SECURITY_SCAN_REGISTERED_TARGET_REQUIRED');
  }
  if (target.type === 'MODEL_ARTIFACT' && !digest.safeParse(target.sha256).success) {
    throw new Error('SECURITY_SCAN_MODEL_DIGEST_REQUIRED');
  }
}

export class RemoteSecurityScanner {
  constructor(
    private readonly definition: SecurityScannerDefinition,
    private readonly fetchDependencies: SafeFetchDependencies = {},
  ) {}

  async scan(
    taskId: string,
    target: SecurityScanTarget,
    signal?: AbortSignal,
  ): Promise<SecurityScanResult> {
    validateSecurityScanTarget(this.definition, target);
    const timeout = AbortSignal.timeout(this.definition.maximumDurationMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const candidate = await safeFetchJson({
      baseUrl: this.definition.baseUrl,
      path: this.definition.path,
      providerType: this.definition.providerType,
      body: {
        schemaVersion: '1.0',
        taskId,
        scanKind: this.definition.scanKind,
        target,
      },
      signal: combinedSignal,
      timeoutMs: this.definition.maximumDurationMs,
      maxRequestBytes: 256 * 1_024,
      maxResponseBytes: 16 * 1_024 * 1_024,
    }, this.fetchDependencies);
    const result = resultSchema.parse(candidate);
    if (
      result.scannerId !== this.definition.id ||
      result.scannerVersion !== this.definition.artifact.version ||
      result.scannerDigest !== this.definition.artifact.sourceDigest
    ) {
      throw new Error('SECURITY_SCAN_SCANNER_IDENTITY_MISMATCH');
    }
    if (canonicalJson(result.target) !== canonicalJson(target)) {
      throw new Error('SECURITY_SCAN_TARGET_IDENTITY_MISMATCH');
    }
    if (result.findings.length > this.definition.maximumFindings) {
      throw new Error('SECURITY_SCAN_FINDING_LIMIT_EXCEEDED');
    }
    if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
      throw new Error('SECURITY_SCAN_TIME_RANGE_INVALID');
    }
    return result;
  }
}

export type SecurityScanStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'RETRYING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELED';

const transitions: Readonly<Record<SecurityScanStatus, readonly SecurityScanStatus[]>> = {
  QUEUED: ['RUNNING', 'CANCELED'],
  RUNNING: ['RETRYING', 'SUCCEEDED', 'FAILED', 'CANCELED'],
  RETRYING: ['RUNNING', 'CANCELED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: [],
};

export function nextSecurityScanStatus(
  current: SecurityScanStatus,
  next: SecurityScanStatus,
): SecurityScanStatus {
  if (!transitions[current].includes(next)) {
    throw new Error('SECURITY_SCAN_STATE_TRANSITION_INVALID');
  }
  return next;
}

export type FindingReviewDisposition =
  | 'CONFIRMED'
  | 'FALSE_POSITIVE'
  | 'DISPUTED'
  | 'ARBITRATED_CONFIRMED'
  | 'ARBITRATED_FALSE_POSITIVE';

export function validateFindingReview(input: {
  readonly disposition: FindingReviewDisposition;
  readonly submitterId: string;
  readonly reviewerId: string;
  readonly previousReviewerIds: readonly string[];
  readonly previousDispositions?: readonly FindingReviewDisposition[];
  readonly reason: string;
}): void {
  if (
    !input.reason.trim() ||
    input.submitterId === input.reviewerId ||
    input.previousReviewerIds.includes(input.reviewerId)
  ) {
    throw new Error('SECURITY_SCAN_INDEPENDENT_REVIEW_REQUIRED');
  }
  if (input.disposition.startsWith('ARBITRATED_') && input.previousReviewerIds.length < 2) {
    throw new Error('SECURITY_SCAN_ARBITRATION_PREREQUISITES_MISSING');
  }
  if (input.disposition.startsWith('ARBITRATED_') && input.previousDispositions) {
    const dispositions = new Set(input.previousDispositions);
    const disputed = dispositions.has('DISPUTED') ||
      (dispositions.has('CONFIRMED') && dispositions.has('FALSE_POSITIVE'));
    if (!disputed) throw new Error('SECURITY_SCAN_ARBITRATION_DISPUTE_REQUIRED');
  }
}
