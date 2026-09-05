import { createHash, sign, verify } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  createDictionaryDraftSchema,
  dictionaryManifestSchema,
} from '@/contracts/http/policy-governance';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import {
  clearRuntimePolicyBundleCache,
  policySigningKeyId,
  signingPrivateKey,
  verificationPublicKey,
} from '@/lib/policy-bundle';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  dictionaryReleases,
  dictionaryReleaseTransitions,
  keywordRules,
  policyProfiles,
  riskFindings,
} from '@/storage/database/shared/schema';
import { PolicyGovernanceOperationError } from './errors';
import {
  assertIndependentDictionaryApproval,
  testDictionaryManifest,
  validateDictionaryManifest,
  type DictionaryManifest,
} from './validation';

type CreateDictionaryDraft = z.infer<typeof createDictionaryDraftSchema>;
type DictionaryReleaseRow = typeof dictionaryReleases.$inferSelect;

interface StoredDictionaryStatistics {
  readonly validation?: ReturnType<typeof validateDictionaryManifest> & { readonly checkedAt: string };
  readonly testing?: ReturnType<typeof testDictionaryManifest> & { readonly testedAt: string };
}

function parseManifest(row: DictionaryReleaseRow): DictionaryManifest {
  try {
    return dictionaryManifestSchema.parse(row.canonicalManifest);
  } catch (error) {
    throw new PolicyGovernanceOperationError(
      'DICTIONARY_MANIFEST_INVALID',
      'The stored dictionary manifest is invalid.',
      422,
    );
  }
}

function statistics(row: DictionaryReleaseRow): StoredDictionaryStatistics {
  const value = row.statistics;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as StoredDictionaryStatistics;
}

function sanitizedStatistics(row: DictionaryReleaseRow): StoredDictionaryStatistics {
  const stored = statistics(row);
  return {
    ...(stored.validation ? {
      validation: {
        passed: Boolean(stored.validation.passed),
        checkedEntries: Number(stored.validation.checkedEntries),
        checkedVariants: Number(stored.validation.checkedVariants),
        conflictCount: Number(stored.validation.conflictCount),
        conflicts: [...(stored.validation.conflicts ?? [])].slice(0, 100),
        checkedAt: String(stored.validation.checkedAt),
      },
    } : {}),
    ...(stored.testing ? {
      testing: {
        passed: Boolean(stored.testing.passed),
        positiveCases: Number(stored.testing.positiveCases),
        positivePassed: Number(stored.testing.positivePassed),
        negativeCases: Number(stored.testing.negativeCases),
        negativePassed: Number(stored.testing.negativePassed),
        failedCaseRefs: [...(stored.testing.failedCaseRefs ?? [])].slice(0, 100),
        testedAt: String(stored.testing.testedAt),
      },
    } : {}),
  };
}

function signedManifest(manifest: DictionaryManifest): {
  readonly contentHash: string;
  readonly signature: string;
  readonly signingKeyId: string;
} {
  const serialized = canonicalJson(manifest);
  return {
    contentHash: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    signature: sign(null, Buffer.from(serialized, 'utf8'), signingPrivateKey()).toString('base64url'),
    signingKeyId: policySigningKeyId(),
  };
}

function verifyStoredManifest(row: DictionaryReleaseRow, manifest: DictionaryManifest): void {
  const serialized = canonicalJson(manifest);
  const digest = createHash('sha256').update(serialized, 'utf8').digest('hex');
  let configuredKeyId: string;
  try {
    configuredKeyId = policySigningKeyId();
  } catch {
    throw new PolicyGovernanceOperationError(
      'DICTIONARY_SIGNING_KEY_UNAVAILABLE',
      'Dictionary signing-key identity is unavailable.',
      503,
    );
  }
  if (
    row.signatureAlgorithm !== 'Ed25519' ||
    row.signingKeyId !== configuredKeyId ||
    digest !== row.contentHash ||
    !verify(null, Buffer.from(serialized, 'utf8'), verificationPublicKey(), Buffer.from(row.signature, 'base64url'))
  ) {
    throw new PolicyGovernanceOperationError(
      'DICTIONARY_SIGNATURE_INVALID',
      'Dictionary integrity verification failed.',
      422,
    );
  }
}

async function scopedReleaseForUpdate(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  scope: TenantScope,
  releaseId: string,
): Promise<DictionaryReleaseRow> {
  const [row] = await transaction.select().from(dictionaryReleases).where(and(
    eq(dictionaryReleases.id, releaseId),
    scopePredicate(dictionaryReleases, scope),
  )).limit(1).for('update');
  if (!row) {
    throw new PolicyGovernanceOperationError(
      'DICTIONARY_RELEASE_NOT_FOUND',
      'The dictionary release does not exist in this application scope.',
      404,
    );
  }
  if (row.releaseSetId) {
    throw new PolicyGovernanceOperationError('DICTIONARY_SET_MEMBER', 'Operate on the entire dictionary release set, not an individual shard.', 409);
  }
  return row;
}

function transitionRecord(
  scope: TenantScope,
  release: DictionaryReleaseRow,
  toState: string,
  action: string,
  actorId: string,
  reason?: string,
) {
  return {
    ...scope,
    releaseId: release.id,
    fromState: release.state,
    toState,
    action,
    actorId,
    reason,
    manifestHash: release.contentHash,
  };
}

export async function createDictionaryDraft(
  scope: TenantScope,
  actorId: string,
  input: CreateDictionaryDraft,
) {
  if (/\.part-\d+$/u.test(input.dictionaryId)) {
    throw new PolicyGovernanceOperationError('DICTIONARY_SET_NAMESPACE', 'Shard identifiers are reserved for atomic release-set imports.', 422);
  }
  return db.transaction(transaction=>insertDictionaryDraft(transaction,scope,actorId,input));
}

/** Internal transaction primitive: callers must commit the full release set in one transaction. */
export async function insertDictionaryDraft(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  scope: TenantScope,
  actorId: string,
  input: CreateDictionaryDraft,
  membership?: {releaseSetId:string;partNumber:number},
) {
  const manifest = dictionaryManifestSchema.parse({ schemaVersion: '1.0', ...input });
  const signed = signedManifest(manifest);
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.tenantId + ':' + scope.applicationId + ':' + input.dictionaryId}))`);
    const [policy] = await transaction.select({ id: policyProfiles.id }).from(policyProfiles).where(and(
      eq(policyProfiles.id, input.policyId),
      scopePredicate(policyProfiles, scope),
    )).limit(1);
    if (!policy) {
      throw new PolicyGovernanceOperationError(
        'DICTIONARY_POLICY_NOT_FOUND',
        'The target policy does not exist in this application scope.',
        404,
      );
    }
    const [created] = await transaction.insert(dictionaryReleases).values({
      ...scope,
      ...membership,
      dictionaryId: manifest.dictionaryId,
      version: manifest.version,
      state: 'draft',
      canonicalManifest: manifest,
      contentHash: signed.contentHash,
      signature: signed.signature,
      signatureAlgorithm: 'Ed25519',
      signingKeyId: signed.signingKeyId,
      entryCount: manifest.entries.reduce((count, entry) => count + entry.variants.length, 0),
      statistics: {},
      submittedBy: actorId,
    }).returning();
    if (!created) throw new Error('Dictionary release insert returned no row');
    const ruleRows = manifest.entries.flatMap((entry) => entry.variants.map((variant) => ({
      ...scope,
      policyId: manifest.policyId,
      releaseId: created.id,
      dimension: entry.riskType,
      keyword: variant,
      canonicalTerm: entry.canonicalTerm,
      variantType: variant === entry.canonicalTerm ? 'canonical' : 'variant',
      locale: entry.locale,
      direction: entry.direction,
      industry: entry.industry,
      contexts: [...entry.contexts],
      severity: entry.severity,
      mandatoryDeny: entry.mandatoryDeny,
      validFrom: entry.validFrom ? new Date(entry.validFrom) : new Date(),
      validTo: entry.validTo ? new Date(entry.validTo) : null,
      owner: entry.owner,
      evidenceRequirement: entry.evidenceRequirement,
      score: (entry.score * 100).toFixed(2),
      matchType: entry.matchType,
      caseSensitive: entry.caseSensitive,
      enabled: true,
      description: 'Governed dictionary entry',
      tags: [manifest.layer],
    })));
    if (ruleRows.length > 0) await transaction.insert(keywordRules).values(ruleRows);
    await transaction.insert(dictionaryReleaseTransitions).values({
      ...scope,
      releaseId: created.id,
      fromState: null,
      toState: 'draft',
      action: 'create',
      actorId,
      manifestHash: created.contentHash,
    });
    return {
      id: created.id,
      dictionaryId: created.dictionaryId,
      version: created.version,
      layer: manifest.layer,
      state: created.state,
      entryCount: created.entryCount,
      contentHash: created.contentHash,
      createdAt: created.createdAt,
    };
}

function dayKeys(now = new Date()): readonly string[] {
  return Array.from({ length: 7 }, (_, offset) => {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (6 - offset)));
    return day.toISOString().slice(0, 10);
  });
}

export async function listDictionaryReleases(
  scope: TenantScope,
  filters: { readonly state?: string; readonly dictionaryId?: string },
) {
  const conditions = [scopePredicate(dictionaryReleases, scope)];
  if (filters.state) conditions.push(eq(dictionaryReleases.state, filters.state));
  if (filters.dictionaryId) conditions.push(eq(dictionaryReleases.dictionaryId, filters.dictionaryId));
  const rows = await db.select().from(dictionaryReleases)
    .where(and(...conditions)).orderBy(desc(dictionaryReleases.createdAt));
  const releaseIds = rows.map((row) => row.id);
  const ruleRows = releaseIds.length === 0 ? [] : await db.select({
    id: keywordRules.id,
    releaseId: keywordRules.releaseId,
  }).from(keywordRules).where(and(
    scopePredicate(keywordRules, scope),
    inArray(keywordRules.releaseId, releaseIds),
  ));
  const ruleToRelease = new Map(ruleRows.flatMap((row) => row.releaseId ? [[row.id, row.releaseId] as const] : []));
  const days = dayKeys();
  const findings = ruleToRelease.size === 0 ? [] : await db.select({
    createdAt: riskFindings.createdAt,
    matchedRules: riskFindings.matchedRules,
  }).from(riskFindings).where(and(
    scopePredicate(riskFindings, scope),
    gte(riskFindings.createdAt, new Date(days[0] + 'T00:00:00.000Z')),
  )).orderBy(desc(riskFindings.createdAt)).limit(10_000);
  const trends = new Map<string, Map<string, number>>();
  for (const finding of findings) {
    const releaseMatches = new Set((finding.matchedRules ?? []).flatMap((ruleId) => {
      const releaseId = ruleToRelease.get(ruleId);
      return releaseId ? [releaseId] : [];
    }));
    const day = finding.createdAt.toISOString().slice(0, 10);
    for (const releaseId of releaseMatches) {
      const trend = trends.get(releaseId) ?? new Map<string, number>();
      trend.set(day, (trend.get(day) ?? 0) + 1);
      trends.set(releaseId, trend);
    }
  }
  return rows.map((row) => {
    const manifest = parseManifest(row);
    const rollbackAvailable = rows.some((candidate) =>
      candidate.id !== row.id && candidate.dictionaryId === row.dictionaryId &&
      candidate.approvedBy !== null && ['deprecated', 'rolled_back'].includes(candidate.state));
    return {
      id: row.id,
      policyId: manifest.policyId,
      dictionaryId: row.dictionaryId,
      version: row.version,
      layer: manifest.layer,
      state: row.state,
      entryCount: row.entryCount,
      statistics: sanitizedStatistics(row),
      releaseSetId: row.releaseSetId,
      submittedBy: row.submittedBy,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt,
      activatedAt: row.activatedAt,
      rolledBackAt: row.rolledBackAt,
      contentHash: row.contentHash,
      signingKeyId: row.signingKeyId,
      rollbackAvailable,
      hitTrend: days.map((day) => ({ day, hits: trends.get(row.id)?.get(day) ?? 0 })),
      createdAt: row.createdAt,
    };
  });
}

export async function validateDictionaryRelease(scope: TenantScope, actorId: string, releaseId: string) {
  return db.transaction(async (transaction) => {
    const row = await scopedReleaseForUpdate(transaction, scope, releaseId);
    if (row.state !== 'draft') {
      throw new PolicyGovernanceOperationError('DICTIONARY_STATE_INVALID', 'Only a draft dictionary can be validated.');
    }
    const manifest = parseManifest(row);
    verifyStoredManifest(row, manifest);
    const result = validateDictionaryManifest(manifest);
    const checkedAt = new Date().toISOString();
    await transaction.update(dictionaryReleases).set({
      statistics: { ...statistics(row), validation: { ...result, checkedAt } },
    }).where(and(eq(dictionaryReleases.id, row.id), scopePredicate(dictionaryReleases, scope)));
    await transaction.insert(dictionaryReleaseTransitions).values(
      transitionRecord(scope, row, row.state, 'validate', actorId),
    );
    return { ...result, checkedAt };
  });
}

export async function testDictionaryRelease(scope: TenantScope, actorId: string, releaseId: string) {
  return db.transaction(async (transaction) => {
    const row = await scopedReleaseForUpdate(transaction, scope, releaseId);
    if (row.state !== 'draft') {
      throw new PolicyGovernanceOperationError('DICTIONARY_STATE_INVALID', 'Only a draft dictionary can be tested.');
    }
    const manifest = parseManifest(row);
    verifyStoredManifest(row, manifest);
    const validation = validateDictionaryManifest(manifest);
    if (!validation.passed) {
      throw new PolicyGovernanceOperationError(
        'DICTIONARY_VALIDATION_FAILED',
        'Dictionary tests cannot run until validation conflicts are resolved.',
        422,
      );
    }
    const result = testDictionaryManifest(manifest);
    const testedAt = new Date().toISOString();
    await transaction.update(dictionaryReleases).set({
      statistics: {
        ...statistics(row),
        validation: { ...validation, checkedAt: testedAt },
        testing: { ...result, testedAt },
      },
    }).where(and(eq(dictionaryReleases.id, row.id), scopePredicate(dictionaryReleases, scope)));
    await transaction.insert(dictionaryReleaseTransitions).values(
      transitionRecord(scope, row, row.state, 'test', actorId),
    );
    return { ...result, testedAt };
  });
}

export async function approveDictionaryRelease(scope: TenantScope, actorId: string, releaseId: string, reason: string) {
  return db.transaction(async (transaction) => {
    const row = await scopedReleaseForUpdate(transaction, scope, releaseId);
    if (row.state !== 'draft') {
      throw new PolicyGovernanceOperationError('DICTIONARY_STATE_INVALID', 'Only a tested draft can be approved.');
    }
    const manifest = parseManifest(row);
    verifyStoredManifest(row, manifest);
    const stored = statistics(row);
    if (!stored.validation?.passed || !stored.testing?.passed) {
      throw new PolicyGovernanceOperationError(
        'DICTIONARY_TEST_EVIDENCE_REQUIRED',
        'Passing validation and positive/negative tests are required before approval.',
        422,
      );
    }
    try {
      assertIndependentDictionaryApproval({ manifest, submittedBy: row.submittedBy, approverId: actorId });
    } catch {
      throw new PolicyGovernanceOperationError(
        'DICTIONARY_INDEPENDENT_APPROVAL_REQUIRED',
        'A different principal must approve this high-risk dictionary.',
      );
    }
    const now = new Date();
    const [updated] = await transaction.update(dictionaryReleases).set({
      state: 'reviewed', approvedBy: actorId, approvedAt: now,
    }).where(and(
      eq(dictionaryReleases.id, row.id),
      eq(dictionaryReleases.state, 'draft'),
      scopePredicate(dictionaryReleases, scope),
    )).returning();
    if (!updated) throw new PolicyGovernanceOperationError('DICTIONARY_STATE_CONFLICT', 'Dictionary state changed; reload and retry.');
    await transaction.insert(dictionaryReleaseTransitions).values(
      transitionRecord(scope, row, 'reviewed', 'approve', actorId, reason),
    );
    return { id: updated.id, state: updated.state, approvedAt: updated.approvedAt };
  });
}

export async function publishDictionaryRelease(
  scope: TenantScope,
  actorId: string,
  releaseId: string,
  mode: 'SHADOW' | 'CANARY',
  reason?: string,
) {
  const targetState = mode === 'SHADOW' ? 'shadow' : 'canary';
  return db.transaction(async (transaction) => {
    const row = await scopedReleaseForUpdate(transaction, scope, releaseId);
    if (row.state !== 'reviewed' || !row.approvedBy) {
      throw new PolicyGovernanceOperationError('DICTIONARY_STATE_INVALID', 'Only an approved dictionary can be published.');
    }
    const manifest = parseManifest(row);
    verifyStoredManifest(row, manifest);
    const [updated] = await transaction.update(dictionaryReleases).set({ state: targetState }).where(and(
      eq(dictionaryReleases.id, row.id),
      eq(dictionaryReleases.state, 'reviewed'),
      scopePredicate(dictionaryReleases, scope),
    )).returning();
    if (!updated) throw new PolicyGovernanceOperationError('DICTIONARY_STATE_CONFLICT', 'Dictionary state changed; reload and retry.');
    await transaction.insert(dictionaryReleaseTransitions).values(
      transitionRecord(scope, row, targetState, 'publish', actorId, reason),
    );
    return { id: updated.id, state: updated.state };
  });
}

export async function activateDictionaryRelease(scope: TenantScope, actorId: string, releaseId: string, reason: string) {
  const result = await db.transaction(async (transaction) => {
    const row = await scopedReleaseForUpdate(transaction, scope, releaseId);
    if (!['shadow', 'canary'].includes(row.state) || !row.approvedBy) {
      throw new PolicyGovernanceOperationError('DICTIONARY_STATE_INVALID', 'Only a published dictionary can be activated.');
    }
    const manifest = parseManifest(row);
    verifyStoredManifest(row, manifest);
    const activeRows = await transaction.select().from(dictionaryReleases).where(and(
      scopePredicate(dictionaryReleases, scope),
      eq(dictionaryReleases.dictionaryId, row.dictionaryId),
      eq(dictionaryReleases.state, 'active'),
      ne(dictionaryReleases.id, row.id),
    )).for('update');
    for (const active of activeRows) {
      await transaction.update(dictionaryReleases).set({ state: 'deprecated' }).where(eq(dictionaryReleases.id, active.id));
      await transaction.insert(dictionaryReleaseTransitions).values(
        transitionRecord(scope, active, 'deprecated', 'replaced', actorId, 'Replaced by ' + row.id),
      );
    }
    const now = new Date();
    const [updated] = await transaction.update(dictionaryReleases).set({
      state: 'active', activatedAt: now,
    }).where(and(
      eq(dictionaryReleases.id, row.id),
      inArray(dictionaryReleases.state, ['shadow', 'canary']),
      scopePredicate(dictionaryReleases, scope),
    )).returning();
    if (!updated) throw new PolicyGovernanceOperationError('DICTIONARY_STATE_CONFLICT', 'Dictionary state changed; reload and retry.');
    await transaction.insert(dictionaryReleaseTransitions).values(
      transitionRecord(scope, row, 'active', 'activate', actorId, reason),
    );
    return { id: updated.id, state: updated.state, activatedAt: updated.activatedAt };
  });
  clearRuntimePolicyBundleCache();
  return result;
}

export async function rollbackDictionaryRelease(
  scope: TenantScope,
  actorId: string,
  releaseId: string,
  reason: string,
) {
  const result = await db.transaction(async (transaction) => {
    const row = await scopedReleaseForUpdate(transaction, scope, releaseId);
    if (row.state !== 'active') {
      throw new PolicyGovernanceOperationError('DICTIONARY_STATE_INVALID', 'Only the active dictionary can be rolled back.');
    }
    const [previous] = await transaction.select().from(dictionaryReleases).where(and(
      scopePredicate(dictionaryReleases, scope),
      eq(dictionaryReleases.dictionaryId, row.dictionaryId),
      ne(dictionaryReleases.id, row.id),
      isNotNull(dictionaryReleases.approvedBy),
      inArray(dictionaryReleases.state, ['deprecated', 'rolled_back']),
    )).orderBy(desc(dictionaryReleases.createdAt)).limit(1).for('update');
    if (!previous) {
      throw new PolicyGovernanceOperationError('DICTIONARY_ROLLBACK_UNAVAILABLE', 'No approved previous dictionary release is available.');
    }
    const now = new Date();
    await transaction.update(dictionaryReleases).set({
      state: 'rolled_back', rolledBackAt: now, rollbackOfId: previous.id,
    }).where(and(eq(dictionaryReleases.id, row.id), scopePredicate(dictionaryReleases, scope)));
    await transaction.update(dictionaryReleases).set({
      state: 'active', activatedAt: now, rolledBackAt: null,
    }).where(and(eq(dictionaryReleases.id, previous.id), scopePredicate(dictionaryReleases, scope)));
    await transaction.insert(dictionaryReleaseTransitions).values([
      transitionRecord(scope, row, 'rolled_back', 'rollback', actorId, reason),
      transitionRecord(scope, previous, 'active', 'rollback_restore', actorId, reason),
    ]);
    return { rolledBackReleaseId: row.id, restoredReleaseId: previous.id, restoredVersion: previous.version };
  });
  clearRuntimePolicyBundleCache();
  return result;
}
