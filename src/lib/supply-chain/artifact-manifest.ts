import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle';

export type SupplyChainArtifactType =
  | 'CODE'
  | 'MODEL'
  | 'DATASET'
  | 'RULE_DATABASE'
  | 'MCP'
  | 'SKILL'
  | 'VULNERABILITY_DATABASE';

export interface SupplyChainArtifactManifest {
  readonly id: string;
  readonly type: SupplyChainArtifactType;
  readonly version: string;
  readonly sourceUri: string;
  readonly sourceDigest: string;
  readonly licenseSpdx: string;
  readonly noticeDigest: string;
  readonly scannerDefinitionDigest: string;
  readonly signatureKeyId: string;
  readonly signature: string;
  readonly permissions: readonly string[];
  readonly networkDomains: readonly string[];
  readonly filePaths: readonly string[];
  readonly commands: readonly string[];
  readonly credentialRefs: readonly string[];
  readonly approvalIds: readonly string[];
  readonly isolatedDynamicAnalysis: boolean;
}

export interface SupplyChainManifestDiff {
  readonly changed: boolean;
  readonly addedPermissions: readonly string[];
  readonly addedNetworkDomains: readonly string[];
  readonly addedFilePaths: readonly string[];
  readonly addedCommands: readonly string[];
  readonly addedCredentialRefs: readonly string[];
  readonly requiresSecurityApproval: boolean;
}

type UnsignedManifest = Omit<SupplyChainArtifactManifest, 'signature' | 'approvalIds'>;

function unsigned(manifest: SupplyChainArtifactManifest): UnsignedManifest {
  const { signature: _signature, approvalIds: _approvalIds, ...payload } = manifest;
  void _signature;
  void _approvalIds;
  return payload;
}

function additions(previous: readonly string[], next: readonly string[]): readonly string[] {
  const known = new Set(previous);
  return [...new Set(next)].filter((item) => !known.has(item)).sort();
}

export function supplyChainManifestDigest(manifest: SupplyChainArtifactManifest): string {
  return createHash('sha256').update(canonicalJson(unsigned(manifest))).digest('hex');
}

export function validateSupplyChainArtifactManifest(
  manifest: SupplyChainArtifactManifest,
  trustedKeys: ReadonlyMap<string, KeyObject>,
): void {
  if (!manifest.id || !manifest.version || /^(?:latest|main|master|head|snapshot)$/iu.test(manifest.version)) {
    throw new Error('SUPPLY_CHAIN_EXACT_VERSION_REQUIRED');
  }
  if (![manifest.sourceDigest, manifest.noticeDigest, manifest.scannerDefinitionDigest]
    .every((digest) => /^sha256:[a-f0-9]{64}$/u.test(digest))) {
    throw new Error('SUPPLY_CHAIN_DIGEST_INVALID');
  }
  if (!manifest.licenseSpdx || new Set(manifest.approvalIds).size < 2) {
    throw new Error('SUPPLY_CHAIN_LEGAL_AND_DUAL_APPROVAL_REQUIRED');
  }
  if (['MCP', 'SKILL'].includes(manifest.type) && !manifest.isolatedDynamicAnalysis) {
    throw new Error('SUPPLY_CHAIN_ISOLATED_ANALYSIS_REQUIRED');
  }
  const key = trustedKeys.get(manifest.signatureKeyId);
  if (!key || !verify(
    null,
    Buffer.from(canonicalJson(unsigned(manifest))),
    key,
    Buffer.from(manifest.signature, 'base64url'),
  )) {
    throw new Error('SUPPLY_CHAIN_SIGNATURE_INVALID');
  }
}

export function trustedSupplyChainKeysFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyMap<string, KeyObject> {
  const raw = environment.SUPPLY_CHAIN_TRUSTED_PUBLIC_KEYS_JSON;
  if (!raw) throw new Error('SUPPLY_CHAIN_TRUSTED_PUBLIC_KEYS_JSON is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SUPPLY_CHAIN_TRUSTED_PUBLIC_KEYS_JSON is invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SUPPLY_CHAIN_TRUSTED_PUBLIC_KEYS_JSON must be an object');
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > 100 ||
      entries.some(([keyId, pem]) => !keyId || typeof pem !== 'string')) {
    throw new Error('SUPPLY_CHAIN_TRUSTED_PUBLIC_KEYS_JSON contains invalid keys');
  }
  return new Map(entries.map(([keyId, pem]) => [
    keyId,
    createPublicKey((pem as string).replace(/\\n/gu, '\n')),
  ]));
}

export function diffSupplyChainManifests(
  previous: SupplyChainArtifactManifest,
  next: SupplyChainArtifactManifest,
): SupplyChainManifestDiff {
  if (previous.id !== next.id || previous.type !== next.type) {
    throw new Error('SUPPLY_CHAIN_DIFF_IDENTITY_MISMATCH');
  }
  const addedPermissions = additions(previous.permissions, next.permissions);
  const addedNetworkDomains = additions(previous.networkDomains, next.networkDomains);
  const addedFilePaths = additions(previous.filePaths, next.filePaths);
  const addedCommands = additions(previous.commands, next.commands);
  const addedCredentialRefs = additions(previous.credentialRefs, next.credentialRefs);
  const changed = supplyChainManifestDigest(previous) !== supplyChainManifestDigest(next);
  return {
    changed,
    addedPermissions,
    addedNetworkDomains,
    addedFilePaths,
    addedCommands,
    addedCredentialRefs,
    requiresSecurityApproval: [
      addedPermissions, addedNetworkDomains, addedFilePaths, addedCommands, addedCredentialRefs,
    ].some((items) => items.length > 0),
  };
}
