import { createHash, verify } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Direction, GuardAction } from '@guardllm/contracts';
import { dictionaryLayerSchema, dictionaryManifestSchema } from '@/contracts/http/policy-governance';
import { canonicalJson } from './canonical';
import { policySigningKeyId, verificationPublicKey } from './crypto';
import type { RuleSpec } from '@/lib/guard-engine-v2/types';
import { db } from '@/storage/database/shared/db';
import {
  detectorCalibrations,
  dictionaryReleases,
  keywordRules,
  responseTemplates,
} from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { dictionaryReleaseSets } from '@/storage/database/shared/schema';
import { verifyReleaseSetMembers } from '@/lib/policy-governance/release-set-integrity';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VARIABLE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const FORBIDDEN_TEMPLATE_VARIABLE = /(?:raw|text|content|prompt|instruction|attack|secret|password|token|credential|pii|identity|health|medical|evidence|original|input|output|payload)/i;

export interface DictionaryReleaseManifest {
  readonly id: string;
  readonly dictionaryId: string;
  readonly version: string;
  readonly state: 'reviewed' | 'shadow' | 'canary' | 'active';
  readonly layer?: 'PLATFORM_REDLINE' | 'INDUSTRY' | 'TENANT' | 'APPLICATION' | 'INCIDENT';
  readonly manifestHash: string;
  readonly contentHash: string;
  readonly signatureAlgorithm: 'Ed25519';
  readonly signingKeyId: string;
  readonly entryCount: number;
  readonly submittedBy: string;
  readonly approvedBy: string;
  readonly releaseSet?: {readonly id:string;readonly digest:string;readonly partNumber:number;readonly shardCount:number};
}

export interface ResponseTemplateManifest {
  readonly id: string;
  readonly templateKey: string;
  readonly riskCategory: string;
  readonly action: Exclude<GuardAction, 'ALLOW'>;
  readonly locale: string;
  readonly industry: string;
  readonly jurisdiction?: string;
  readonly businessLine?: string;
  readonly legalDisclaimerVersion?: string;
  readonly templateScope?: 'PLATFORM' | 'TENANT';
  readonly templateText: string;
  readonly allowedVariables: readonly string[];
  readonly version: number;
  readonly contentHash: string;
  readonly signatureDigest: string;
  readonly approvedBy: string;
}

export interface DetectorCalibrationManifest {
  readonly id: string;
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly riskType: string;
  readonly locale: string;
  readonly industry: string;
  readonly threshold: number;
  readonly confidenceFloor: number;
  readonly metrics: Readonly<Record<string, number>>;
  readonly datasetHash: string;
  readonly approvedBy: string;
}

export interface ModelDigestManifest {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly sha256: string;
}

export interface TokenizerManifest {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
}

export interface FailurePolicyManifest {
  readonly detectorId: string;
  readonly policy: 'FAIL_CLOSED' | 'DEGRADE';
}

export interface GovernedKeywordRule extends RuleSpec {
  readonly canonicalTermId: string;
  readonly variantId: string;
  readonly dictionaryReleaseId: string;
  readonly dictionaryVersion: string;
  readonly owner: string;
  readonly locale: string;
  readonly direction: Direction | 'BOTH';
  readonly industry: string;
  readonly contexts: readonly string[];
  readonly validFromEpochMs: number;
  readonly validToEpochMs?: number;
  readonly evidenceRequirement: string;
}

export interface GovernedPolicyArtifacts {
  readonly dictionaryReleases: readonly DictionaryReleaseManifest[];
  readonly keywordRules: readonly GovernedKeywordRule[];
  readonly responseTemplates: readonly ResponseTemplateManifest[];
  readonly detectorCalibrations: readonly DetectorCalibrationManifest[];
  readonly modelDigests: readonly ModelDigestManifest[];
  readonly tokenizer: TokenizerManifest;
  readonly failurePolicies: readonly FailurePolicyManifest[];
}

export class PolicyGovernanceValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PolicyGovernanceValidationError';
  }
}

function requireIdentifier(value: string, field: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new PolicyGovernanceValidationError('GOVERNANCE_ID_INVALID', `${field} is invalid`);
  }
}

function requireSha256(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new PolicyGovernanceValidationError('GOVERNANCE_DIGEST_INVALID', `${field} is invalid`);
  }
}

function requireUnique<T>(items: readonly T[], key: (item: T) => string, field: string): void {
  const values = items.map(key);
  if (new Set(values).size !== values.length) {
    throw new PolicyGovernanceValidationError('GOVERNANCE_DUPLICATE', `${field} contains duplicates`);
  }
}

function validateTemplate(template: ResponseTemplateManifest): void {
  requireIdentifier(template.templateKey, 'templateKey');
  requireSha256(template.contentHash, 'template contentHash');
  requireSha256(template.signatureDigest, 'template signatureDigest');
  if (template.version < 1 || !Number.isSafeInteger(template.version)) {
    throw new PolicyGovernanceValidationError('TEMPLATE_VERSION_INVALID', 'Template version is invalid');
  }
  if (!template.approvedBy.trim()) {
    throw new PolicyGovernanceValidationError('TEMPLATE_NOT_APPROVED', 'Template approver is required');
  }
  if (!new Set<GuardAction>([
    'WARN',
    'MASK',
    'REWRITE',
    'REQUIRE_REVIEW',
    'SAFE_RESPONSE',
    'BLOCK',
  ]).has(template.action)) {
    throw new PolicyGovernanceValidationError('TEMPLATE_ACTION_INVALID', 'Template action is invalid');
  }
  const allowedVariables = [...template.allowedVariables];
  if (new Set(allowedVariables).size !== allowedVariables.length ||
      allowedVariables.some((variable) =>
        !VARIABLE_PATTERN.test(variable) || FORBIDDEN_TEMPLATE_VARIABLE.test(variable))) {
    throw new PolicyGovernanceValidationError(
      'TEMPLATE_VARIABLE_ALLOWLIST_INVALID',
      'Template variable allowlist is invalid',
    );
  }
  const placeholders = [...template.templateText.matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1] as string);
  if (placeholders.some((placeholder) => !allowedVariables.includes(placeholder))) {
    throw new PolicyGovernanceValidationError(
      'TEMPLATE_VARIABLE_NOT_ALLOWED',
      'Template contains a variable outside its allowlist',
    );
  }
  for (const selector of [
    template.locale,
    template.industry,
    template.jurisdiction ?? 'global',
    template.businessLine ?? 'general',
    template.legalDisclaimerVersion ?? 'none',
  ]) {
    requireIdentifier(selector, 'template selector');
  }
  if (template.templateScope !== undefined &&
      !['PLATFORM', 'TENANT'].includes(template.templateScope)) {
    throw new PolicyGovernanceValidationError('TEMPLATE_SCOPE_INVALID', 'Template scope is invalid');
  }
  if (template.templateScope === 'PLATFORM' &&
      template.riskCategory.startsWith('platform.redline') &&
      template.action !== 'BLOCK') {
    throw new PolicyGovernanceValidationError(
      'PLATFORM_REDLINE_TEMPLATE_WEAKENED',
      'Platform redline templates must keep the BLOCK action',
    );
  }
  const actualHash = createHash('sha256').update(template.templateText, 'utf8').digest('hex');
  if (actualHash !== template.contentHash) {
    throw new PolicyGovernanceValidationError('TEMPLATE_DIGEST_MISMATCH', 'Template content hash mismatches');
  }
}

const allowedDirections = new Set<Direction | 'BOTH'>([
  'BOTH',
  'INPUT',
  'OUTPUT_COMPLETE',
  'OUTPUT_CHUNK',
  'RAG_INGEST',
  'RAG_CONTEXT',
  'TOOL_REQUEST',
  'TOOL_RESULT',
]);

function validateGovernedKeywordRules(artifacts: GovernedPolicyArtifacts): void {
  requireUnique(artifacts.keywordRules, (item) => item.id, 'keywordRules');
  const releases = new Map(artifacts.dictionaryReleases.map((release) => [release.id, release]));
  const selectors = new Map<string, GovernedKeywordRule>();
  for (const rule of artifacts.keywordRules) {
    requireIdentifier(rule.id, 'keyword rule id');
    requireIdentifier(rule.canonicalTermId, 'keyword canonicalTermId');
    requireIdentifier(rule.variantId, 'keyword variantId');
    if (
      !rule.pattern.trim() ||
      !rule.owner.trim() ||
      !rule.evidenceRequirement.trim() ||
      !rule.locale.trim() ||
      !rule.industry.trim() ||
      !allowedDirections.has(rule.direction) ||
      rule.score < 0 || rule.score > 1 ||
      !Number.isFinite(rule.score)
    ) {
      throw new PolicyGovernanceValidationError(
        'KEYWORD_RULE_METADATA_INVALID',
        'Governed keyword rule lacks required ownership, scope, evidence, or score metadata',
      );
    }
    if (
      !Number.isSafeInteger(rule.validFromEpochMs) ||
      rule.validFromEpochMs < 1 ||
      (rule.validToEpochMs !== undefined && (
        !Number.isSafeInteger(rule.validToEpochMs) ||
        rule.validToEpochMs <= rule.validFromEpochMs
      ))
    ) {
      throw new PolicyGovernanceValidationError(
        'KEYWORD_RULE_VALIDITY_INVALID',
        'Governed keyword rule has an invalid effective period',
      );
    }
    if (new Set(rule.contexts).size !== rule.contexts.length) {
      throw new PolicyGovernanceValidationError(
        'KEYWORD_RULE_CONTEXT_DUPLICATE',
        'Governed keyword rule context selectors contain duplicates',
      );
    }
    const release = releases.get(rule.dictionaryReleaseId);
    if (!release || release.state !== 'active' || release.version !== rule.dictionaryVersion ||
        (release.layer !== undefined && release.layer !== rule.dictionaryLayer)) {
      throw new PolicyGovernanceValidationError(
        'KEYWORD_RULE_RELEASE_INVALID',
        'Governed keyword rule is not attached to its active approved release',
      );
    }
    const normalizedPattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
    const selector = [
      normalizedPattern,
      rule.matchType,
      rule.caseSensitive ? 'case-sensitive' : 'case-insensitive',
      rule.locale,
      rule.industry,
      rule.direction,
      [...rule.contexts].sort().join(','),
    ].join(':');
    const conflicting = selectors.get(selector);
    if (conflicting) {
      throw new PolicyGovernanceValidationError(
        'KEYWORD_RULE_SELECTOR_CONFLICT',
        'Governed keyword rules ' + conflicting.id + ' and ' + rule.id + ' have a conflicting selector',
      );
    }
    selectors.set(selector, rule);
  }
}

export function validateGovernedKeywordRulesForCompilation(
  rules: readonly GovernedKeywordRule[],
  compileTimeEpochMs: number,
): void {
  for (const rule of rules) {
    if (
      rule.validFromEpochMs > compileTimeEpochMs ||
      (rule.validToEpochMs !== undefined && rule.validToEpochMs <= compileTimeEpochMs)
    ) {
      throw new PolicyGovernanceValidationError(
        'KEYWORD_RULE_INACTIVE',
        'Governed keyword rule is not active at compile time',
      );
    }
  }
}

export function validateGovernedPolicyArtifacts(
  artifacts: GovernedPolicyArtifacts,
): GovernedPolicyArtifacts {
  requireUnique(artifacts.dictionaryReleases, (item) => item.id, 'dictionaryReleases');
  validateGovernedKeywordRules(artifacts);
  requireUnique(artifacts.responseTemplates, (item) => item.id, 'responseTemplates');
  requireUnique(
    artifacts.responseTemplates,
    (item) => [
      item.templateKey,
      item.locale,
      item.industry,
      item.jurisdiction ?? 'global',
      item.businessLine ?? 'general',
    ].join(':'),
    'response template selectors',
  );
  requireUnique(
    artifacts.detectorCalibrations,
    (item) => `${item.detectorId}:${item.detectorVersion}:${item.riskType}:${item.locale}:${item.industry}`,
    'detectorCalibrations',
  );
  requireUnique(artifacts.modelDigests, (item) => `${item.modelId}:${item.modelVersion}`, 'modelDigests');
  requireUnique(artifacts.failurePolicies, (item) => item.detectorId, 'failurePolicies');

  for (const release of artifacts.dictionaryReleases) {
    requireIdentifier(release.dictionaryId, 'dictionaryId');
    if (release.layer !== undefined && !dictionaryLayerSchema.safeParse(release.layer).success) {
      throw new PolicyGovernanceValidationError('DICTIONARY_LAYER_INVALID', 'Dictionary release layer is invalid');
    }
    requireSha256(release.manifestHash, 'dictionary manifestHash');
    requireSha256(release.contentHash, 'dictionary contentHash');
    requireIdentifier(release.signingKeyId, 'dictionary signingKeyId');
    if (release.signatureAlgorithm !== 'Ed25519' || !release.approvedBy.trim()) {
      throw new PolicyGovernanceValidationError(
        'DICTIONARY_RELEASE_NOT_APPROVED',
        'Dictionary release lacks trusted approval metadata',
      );
    }
    if (!Number.isSafeInteger(release.entryCount) || release.entryCount < 0) {
      throw new PolicyGovernanceValidationError(
        'DICTIONARY_ENTRY_COUNT_INVALID',
        'Dictionary release entry count is invalid',
      );
    }
  }
  const groups=new Map<string,DictionaryReleaseManifest[]>();
  for(const release of artifacts.dictionaryReleases) {
    if(!release.releaseSet)continue;
    const group=groups.get(release.releaseSet.id) ?? [];
    group.push(release);groups.set(release.releaseSet.id,group);
  }
  for(const group of groups.values()) {
    const root=group[0].releaseSet!;
    requireSha256(root.digest,'release set digest');
    if(!Number.isSafeInteger(root.shardCount) || root.shardCount<1 || group.length!==root.shardCount ||
      new Set(group.map(release=>release.releaseSet!.partNumber)).size!==root.shardCount ||
      group.some(release=>release.releaseSet!.digest!==root.digest || release.releaseSet!.shardCount!==root.shardCount ||
        !Number.isSafeInteger(release.releaseSet!.partNumber) || release.releaseSet!.partNumber<1 || release.releaseSet!.partNumber>root.shardCount ||
        release.state!==group[0].state || release.version!==group[0].version || release.approvedBy!==group[0].approvedBy)) {
      throw new PolicyGovernanceValidationError('DICTIONARY_SET_INCOMPLETE','Compiled policy must contain one complete, consistent release set.');
    }
  }
  for (const template of artifacts.responseTemplates) validateTemplate(template);
  for (const calibration of artifacts.detectorCalibrations) {
    requireIdentifier(calibration.detectorId, 'calibration detectorId');
    requireSha256(calibration.datasetHash, 'calibration datasetHash');
    if (
      calibration.threshold < 0 || calibration.threshold > 1 ||
      calibration.confidenceFloor < 0 || calibration.confidenceFloor > 1 ||
      !calibration.approvedBy.trim()
    ) {
      throw new PolicyGovernanceValidationError(
        'CALIBRATION_INVALID',
        'Detector calibration is invalid or unapproved',
      );
    }
  }
  for (const model of artifacts.modelDigests) requireSha256(model.sha256, 'model sha256');
  requireIdentifier(artifacts.tokenizer.id, 'tokenizer id');
  requireIdentifier(artifacts.tokenizer.version, 'tokenizer version');
  requireSha256(artifacts.tokenizer.sha256, 'tokenizer sha256');
  return artifacts;
}

export function builtInTokenizerManifest(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TokenizerManifest {
  const id = environment.GUARD_TOKENIZER_ID?.trim() || 'unicode-codepoint';
  const version = environment.GUARD_TOKENIZER_VERSION?.trim() || '1.0.0';
  const sha256 = environment.GUARD_TOKENIZER_SHA256?.trim() ||
    createHash('sha256').update(`${id}:${version}`, 'utf8').digest('hex');
  const manifest = { id, version, sha256 };
  requireIdentifier(id, 'tokenizer id');
  requireIdentifier(version, 'tokenizer version');
  requireSha256(sha256, 'tokenizer sha256');
  return manifest;
}

function verifiedDictionaryRelease(row: typeof dictionaryReleases.$inferSelect) {
  const parsed = dictionaryManifestSchema.safeParse(row.canonicalManifest);
  if (!parsed.success) {
    throw new PolicyGovernanceValidationError('DICTIONARY_MANIFEST_INVALID', 'Approved dictionary manifest is invalid');
  }
  const serialized = canonicalJson(parsed.data);
  const digest = createHash('sha256').update(serialized, 'utf8').digest('hex');
  const entryCount = parsed.data.entries.reduce((count, entry) => count + entry.variants.length, 0);
  let validSignature = false;
  try {
    validSignature = row.signatureAlgorithm === 'Ed25519' &&
      row.signingKeyId === policySigningKeyId() &&
      verify(null, Buffer.from(serialized, 'utf8'), verificationPublicKey(), Buffer.from(row.signature, 'base64url'));
  } catch {
    validSignature = false;
  }
  if (
    digest !== row.contentHash || !validSignature ||
    parsed.data.dictionaryId !== row.dictionaryId || parsed.data.version !== row.version ||
    entryCount !== row.entryCount
  ) {
    throw new PolicyGovernanceValidationError('DICTIONARY_SIGNATURE_INVALID', 'Approved dictionary integrity verification failed');
  }
  return {
    manifest: parsed.data,
    release: {
      id: row.id,
      dictionaryId: row.dictionaryId,
      version: row.version,
      state: row.state as DictionaryReleaseManifest['state'],
      layer: parsed.data.layer,
      manifestHash: digest,
      contentHash: row.contentHash,
      signatureAlgorithm: 'Ed25519' as const,
      signingKeyId: row.signingKeyId,
      entryCount: row.entryCount,
      submittedBy: row.submittedBy,
      approvedBy: row.approvedBy!,
    },
  };
}

export async function loadGovernedPolicyArtifacts(
  scope: TenantScope,
  policyId: string,
  now = new Date(),
): Promise<GovernedPolicyArtifacts> {
  return db.transaction(async transaction=>{
  const [releaseRows, keywordRows, templateRows, calibrationRows, setRows] = await Promise.all([
    transaction.select().from(dictionaryReleases).where(and(
      scopePredicate(dictionaryReleases, scope),
      inArray(dictionaryReleases.state, ['reviewed', 'shadow', 'canary', 'active']),
      isNotNull(dictionaryReleases.approvedBy),
      sql`${dictionaryReleases.canonicalManifest}->>'policyId' = ${policyId}`,
    )),
    transaction.select({
      id: keywordRules.id,
      dictionaryId: dictionaryReleases.dictionaryId,
      releaseId: dictionaryReleases.id,
      releaseVersion: dictionaryReleases.version,
      dimension: keywordRules.dimension,
      keyword: keywordRules.keyword,
      canonicalTerm: keywordRules.canonicalTerm,
      locale: keywordRules.locale,
      direction: keywordRules.direction,
      industry: keywordRules.industry,
      contexts: keywordRules.contexts,
      severity: keywordRules.severity,
      mandatoryDeny: keywordRules.mandatoryDeny,
      validFrom: keywordRules.validFrom,
      validTo: keywordRules.validTo,
      owner: keywordRules.owner,
      evidenceRequirement: keywordRules.evidenceRequirement,
      score: keywordRules.score,
      matchType: keywordRules.matchType,
      caseSensitive: keywordRules.caseSensitive,
    }).from(keywordRules).innerJoin(dictionaryReleases, and(
      eq(keywordRules.releaseId, dictionaryReleases.id),
      scopePredicate(dictionaryReleases, scope),
    )).where(and(
      scopePredicate(keywordRules, scope),
      eq(keywordRules.policyId, policyId),
      eq(keywordRules.enabled, true),
      lte(keywordRules.validFrom, now),
      or(isNull(keywordRules.validTo), gt(keywordRules.validTo, now)),
      eq(dictionaryReleases.state, 'active'),
      isNotNull(dictionaryReleases.approvedBy),
    )),
    transaction.select().from(responseTemplates).where(and(
      scopePredicate(responseTemplates, scope),
      eq(responseTemplates.approvalStatus, 'approved'),
      eq(responseTemplates.enabled, true),
      lte(responseTemplates.validFrom, now),
      or(isNull(responseTemplates.validTo), gt(responseTemplates.validTo, now)),
    )),
    transaction.select().from(detectorCalibrations).where(and(
      scopePredicate(detectorCalibrations, scope),
      isNotNull(detectorCalibrations.approvedBy),
    )),
    transaction.select().from(dictionaryReleaseSets).where(and(scopePredicate(dictionaryReleaseSets,scope),
      eq(dictionaryReleaseSets.policyId,policyId),inArray(dictionaryReleaseSets.state,['reviewed','shadow','canary','active']))),
  ]);

  const verifiedReleases = releaseRows.map(verifiedDictionaryRelease);
  const roots=new Map(setRows.map(root=>[root.id,root]));
  for(const root of setRows)verifyReleaseSetMembers(root,releaseRows.filter(row=>row.releaseSetId===root.id));
  for(const row of releaseRows) {
    if(row.releaseSetId && !roots.has(row.releaseSetId))throw new PolicyGovernanceValidationError('DICTIONARY_SET_MISSING','A dictionary shard lacks its verified root.');
  }
  for(const item of verifiedReleases) {
    if(item.release.state!=='active')continue;
    const expected=item.manifest.entries.filter(entry=>(!entry.validFrom || Date.parse(entry.validFrom)<=now.getTime()) &&
      (!entry.validTo || Date.parse(entry.validTo)>now.getTime())).reduce((count,entry)=>count+entry.variants.length,0);
    if(keywordRows.filter(row=>row.releaseId===item.release.id).length!==expected)
      throw new PolicyGovernanceValidationError('KEYWORD_RULE_COUNT_MISMATCH','Active signed dictionary entries are missing, disabled or unexpectedly duplicated.');
  }
  const releaseById = new Map(verifiedReleases.map((item) => [item.release.id, item]));
  return validateGovernedPolicyArtifacts({
    dictionaryReleases: verifiedReleases.map((item,index) => {
      const row=releaseRows[index];const root=row.releaseSetId ? roots.get(row.releaseSetId) : undefined;
      return {...item.release,...(root ? {releaseSet:{id:root.id,digest:root.contentHash,partNumber:row.partNumber!,shardCount:root.shardCount}} : {})};
    }),
    keywordRules: keywordRows.map((row) => {
      const canonicalTerm = row.canonicalTerm?.trim() || row.keyword;
      const release = releaseById.get(row.releaseId);
      if (!release) {
        throw new PolicyGovernanceValidationError('KEYWORD_RULE_RELEASE_INVALID', 'Keyword rule references an unverified dictionary release');
      }
      const sourceEntry = release.manifest.entries.find(entry=>entry.canonicalTerm===canonicalTerm && entry.riskType===row.dimension && entry.variants.includes(row.keyword));
      if (!sourceEntry) throw new PolicyGovernanceValidationError('KEYWORD_RULE_SOURCE_MISSING','Keyword rule does not match the signed source manifest');
      if(row.matchType!==sourceEntry.matchType || row.caseSensitive!==sourceEntry.caseSensitive ||
        Number(row.score)!==Number((sourceEntry.score*100).toFixed(2)) || row.severity!==sourceEntry.severity ||
        row.mandatoryDeny!==sourceEntry.mandatoryDeny || row.locale!==sourceEntry.locale || row.direction!==sourceEntry.direction ||
        row.industry!==sourceEntry.industry || canonicalJson(row.contexts)!==canonicalJson(sourceEntry.contexts) ||
        row.owner!==sourceEntry.owner || row.evidenceRequirement!==sourceEntry.evidenceRequirement ||
        (row.validTo?.getTime() ?? null)!==(sourceEntry.validTo ? Date.parse(sourceEntry.validTo) : null) ||
        (sourceEntry.validFrom && row.validFrom.getTime()!==Date.parse(sourceEntry.validFrom)))
        throw new PolicyGovernanceValidationError('KEYWORD_RULE_CONTENT_MISMATCH','Keyword rule metadata differs from its signed source manifest');
      return {
        id: row.id,
        riskType: row.dimension,
        pattern: row.keyword,
        matchType: row.matchType as GovernedKeywordRule['matchType'],
        caseSensitive: row.caseSensitive,
        score: Number(row.score) / 100,
        severity: row.severity as GovernedKeywordRule['severity'],
        ruleVersion: row.releaseVersion,
        mandatoryDeny: row.mandatoryDeny,
        canonicalTermId: sourceEntry.canonicalTermId ?? 'term-' + createHash('sha256')
          .update(row.dictionaryId + ':' + canonicalTerm, 'utf8').digest('hex').slice(0, 24),
        ...(sourceEntry.sourceIds ? {sourceIds:sourceEntry.sourceIds} : {}),
        ...(sourceEntry.actionHint ? {actionHint:sourceEntry.actionHint} : {}),
        ...(sourceEntry.sourceMatchMode ? {sourceMatchMode:sourceEntry.sourceMatchMode} : {}),
        ...(sourceEntry.matchConstraints ? {matchConstraints:sourceEntry.matchConstraints} : {}),
        variantId: row.id,
        dictionaryReleaseId: row.releaseId,
        dictionaryVersion: row.releaseVersion,
        dictionaryLayer: release.manifest.layer,
        owner: row.owner ?? '',
        locale: row.locale,
        direction: row.direction as GovernedKeywordRule['direction'],
        industry: row.industry,
        contexts: row.contexts,
        validFromEpochMs: row.validFrom.getTime(),
        ...(row.validTo ? { validToEpochMs: row.validTo.getTime() } : {}),
        evidenceRequirement: row.evidenceRequirement ?? '',
      };
    }),
    responseTemplates: templateRows.map((row) => ({
      id: row.id,
      templateKey: row.templateKey,
      riskCategory: row.riskCategory,
      action: row.action as ResponseTemplateManifest['action'],
      locale: row.locale,
      industry: row.industry,
      jurisdiction: row.jurisdiction,
      businessLine: row.businessLine,
      legalDisclaimerVersion: row.legalDisclaimerVersion,
      templateScope: row.templateScope as ResponseTemplateManifest['templateScope'],
      templateText: row.templateText,
      allowedVariables: row.allowedVariables,
      version: row.version,
      contentHash: row.contentHash,
      signatureDigest: row.signatureDigest,
      approvedBy: row.approvedBy!,
    })),
    detectorCalibrations: calibrationRows.map((row) => ({
      id: row.id,
      detectorId: row.detectorId,
      detectorVersion: row.detectorVersion,
      riskType: row.riskType,
      locale: row.locale,
      industry: row.industry,
      threshold: Number(row.threshold),
      confidenceFloor: Number(row.confidenceFloor),
      metrics: row.metrics,
      datasetHash: row.datasetHash,
      approvedBy: row.approvedBy,
    })),
    modelDigests: [],
    tokenizer: builtInTokenizerManifest(),
    failurePolicies: [],
  });
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
