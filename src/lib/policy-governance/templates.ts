import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { GuardRequest } from '@guardllm/contracts';
import type { z } from 'zod';
import {
  createResponseTemplateSchema,
  previewResponseTemplateSchema,
} from '@/contracts/http/policy-governance';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import { canonicalJson, clearRuntimePolicyBundleCache, loadRuntimePolicyBundle } from '@/lib/policy-bundle';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { responseTemplates } from '@/storage/database/shared/schema';
import { PolicyGovernanceOperationError } from './errors';
import { safePreviewVariables, validateResponseTemplateDraft } from './validation';

type CreateTemplate = z.infer<typeof createResponseTemplateSchema>;
type PreviewTemplate = z.infer<typeof previewResponseTemplateSchema>;
type TemplateRow = typeof responseTemplates.$inferSelect;

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu;

function templateDigest(input: CreateTemplate, contentHash: string): string {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: '1.0',
    templateKey: input.templateKey,
    riskCategory: input.riskCategory,
    action: input.action,
    locale: input.locale,
    industry: input.industry,
    jurisdiction: input.jurisdiction,
    businessLine: input.businessLine,
    legalDisclaimerVersion: input.legalDisclaimerVersion,
    templateScope: input.templateScope,
    allowedVariables: [...input.allowedVariables].sort(),
    contentHash,
  }), 'utf8').digest('hex');
}

function rowAsDraft(row: TemplateRow): CreateTemplate {
  return createResponseTemplateSchema.parse({
    templateKey: row.templateKey,
    riskCategory: row.riskCategory,
    action: row.action,
    locale: row.locale,
    industry: row.industry,
    jurisdiction: row.jurisdiction,
    businessLine: row.businessLine,
    legalDisclaimerVersion: row.legalDisclaimerVersion,
    templateScope: row.templateScope,
    templateText: row.templateText,
    allowedVariables: row.allowedVariables,
    validFrom: row.validFrom.toISOString(),
    ...(row.validTo ? { validTo: row.validTo.toISOString() } : {}),
  });
}

function verifyTemplateIntegrity(row: TemplateRow, draft: CreateTemplate): void {
  const contentHash = createHash('sha256').update(draft.templateText, 'utf8').digest('hex');
  if (contentHash !== row.contentHash || templateDigest(draft, contentHash) !== row.signatureDigest) {
    throw new PolicyGovernanceOperationError(
      'TEMPLATE_INTEGRITY_INVALID',
      'Response-template integrity verification failed.',
      422,
    );
  }
}

async function scopedTemplate(scope: TenantScope, templateId: string): Promise<TemplateRow> {
  const [row] = await db.select().from(responseTemplates).where(and(
    eq(responseTemplates.id, templateId),
    scopePredicate(responseTemplates, scope),
  )).limit(1);
  if (!row) {
    throw new PolicyGovernanceOperationError(
      'TEMPLATE_NOT_FOUND',
      'The response template does not exist in this application scope.',
      404,
    );
  }
  return row;
}

export async function createResponseTemplateDraft(
  scope: TenantScope,
  actorId: string,
  input: CreateTemplate,
) {
  validateResponseTemplateDraft(input);
  const contentHash = createHash('sha256').update(input.templateText, 'utf8').digest('hex');
  const signatureDigest = templateDigest(input, contentHash);
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.tenantId + ':' + scope.applicationId + ':' + input.templateKey}))`);
    const [latest] = await transaction.select({ version: responseTemplates.version })
      .from(responseTemplates).where(and(
        scopePredicate(responseTemplates, scope),
        eq(responseTemplates.templateKey, input.templateKey),
      )).orderBy(desc(responseTemplates.version)).limit(1);
    const version = (latest?.version ?? 0) + 1;
    const [created] = await transaction.insert(responseTemplates).values({
      ...scope,
      templateKey: input.templateKey,
      riskCategory: input.riskCategory,
      action: input.action,
      locale: input.locale,
      industry: input.industry,
      jurisdiction: input.jurisdiction,
      businessLine: input.businessLine,
      legalDisclaimerVersion: input.legalDisclaimerVersion,
      templateScope: input.templateScope,
      templateText: input.templateText,
      allowedVariables: [...input.allowedVariables],
      version,
      contentHash,
      signatureDigest,
      approvalStatus: 'pending',
      createdBy: actorId,
      validFrom: input.validFrom ? new Date(input.validFrom) : new Date(),
      validTo: input.validTo ? new Date(input.validTo) : null,
      enabled: false,
    }).returning();
    if (!created) throw new Error('Response template insert returned no row');
    return {
      id: created.id,
      templateKey: created.templateKey,
      version: created.version,
      approvalStatus: created.approvalStatus,
      contentHash: created.contentHash,
      createdAt: created.createdAt,
    };
  });
}

export async function listResponseTemplates(
  scope: TenantScope,
  filters: { readonly approvalStatus?: string; readonly templateKey?: string },
) {
  const conditions = [scopePredicate(responseTemplates, scope)];
  if (filters.approvalStatus) conditions.push(eq(responseTemplates.approvalStatus, filters.approvalStatus));
  if (filters.templateKey) conditions.push(eq(responseTemplates.templateKey, filters.templateKey));
  const rows = await db.select().from(responseTemplates)
    .where(and(...conditions)).orderBy(desc(responseTemplates.createdAt));
  const versionsByKey = new Map<string, number[]>();
  for (const row of rows) {
    const versions = versionsByKey.get(row.templateKey) ?? [];
    versions.push(row.version);
    versionsByKey.set(row.templateKey, versions);
  }
  return rows.map((row) => ({
    id: row.id,
    templateKey: row.templateKey,
    riskCategory: row.riskCategory,
    action: row.action,
    locale: row.locale,
    industry: row.industry,
    jurisdiction: row.jurisdiction,
    businessLine: row.businessLine,
    legalDisclaimerVersion: row.legalDisclaimerVersion,
    templateScope: row.templateScope,
    allowedVariables: row.allowedVariables,
    version: row.version,
    contentHash: row.contentHash,
    signatureDigest: row.signatureDigest,
    approvalStatus: row.approvalStatus,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    enabled: row.enabled,
    rollbackAvailable: row.enabled && (versionsByKey.get(row.templateKey)?.some((version) => version < row.version) ?? false),
    recheckStatus: row.approvalStatus === 'approved' ? 'passed_at_approval' : 'preview_required',
    createdAt: row.createdAt,
  }));
}

function renderDraft(draft: CreateTemplate, variables: Readonly<Record<string, string>>): string {
  validateResponseTemplateDraft(draft);
  const safeVariables = safePreviewVariables(draft.allowedVariables, variables);
  PLACEHOLDER.lastIndex = 0;
  const rendered = draft.templateText.replace(PLACEHOLDER, (_match, variable: string) => {
    const value = safeVariables[variable];
    if (value === undefined) throw new Error('TEMPLATE_VARIABLE_MISSING');
    return value;
  });
  PLACEHOLDER.lastIndex = 0;
  if (PLACEHOLDER.test(rendered)) throw new Error('TEMPLATE_RENDER_INCOMPLETE');
  PLACEHOLDER.lastIndex = 0;
  return rendered;
}

export async function previewResponseTemplate(
  scope: TenantScope,
  input: PreviewTemplate,
) {
  const row = await scopedTemplate(scope, input.templateId);
  const draft = rowAsDraft(row);
  verifyTemplateIntegrity(row, draft);
  let rendered: string;
  try {
    rendered = renderDraft(draft, input.variables);
  } catch (error) {
    return {
      passed: false,
      renderStatus: 'failed' as const,
      reasonCode: error instanceof Error ? error.message : 'TEMPLATE_RENDER_FAILED',
      recheck: { passed: false, action: 'BLOCK' as const, riskCategories: [] },
    };
  }
  const requestId = randomUUID();
  const bundle = await loadRuntimePolicyBundle(scope, undefined, requestId);
  const request: GuardRequest = {
    contractVersion: '1.0',
    context: {
      traceId: randomUUID(),
      requestId,
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      direction: 'OUTPUT_COMPLETE',
      sourceType: 'SYSTEM',
      locale: draft.locale,
      jurisdiction: draft.jurisdiction,
      industry: draft.industry,
      businessLine: draft.businessLine,
      legalDisclaimerVersion: draft.legalDisclaimerVersion,
      absoluteDeadlineEpochMs: Date.now() + 15_000,
      policyBundleId: bundle.id,
      stage: 'OUTPUT_POST',
    },
    content: { text: rendered },
  };
  const decision = await createEngineForPolicyBundle(bundle).evaluate(request);
  const riskCategories = [...new Set(decision.observations
    .filter((observation) => observation.status === 'MATCH')
    .map((observation) => observation.riskType))].sort();
  const passed = decision.action === 'ALLOW' || decision.action === 'WARN';
  return {
    passed,
    renderStatus: 'completed' as const,
    ...(passed ? { preview: rendered } : {}),
    recheck: {
      passed,
      action: decision.action,
      riskCategories,
      decisionId: decision.decisionId,
    },
  };
}

export async function approveResponseTemplate(
  scope: TenantScope,
  actorId: string,
  templateId: string,
  reason: string,
) {
  const candidate = await scopedTemplate(scope, templateId);
  if (candidate.approvalStatus !== 'pending') {
    throw new PolicyGovernanceOperationError('TEMPLATE_STATE_INVALID', 'Only a pending template can be approved.');
  }
  if (candidate.createdBy === actorId) {
    throw new PolicyGovernanceOperationError('TEMPLATE_INDEPENDENT_APPROVAL_REQUIRED', 'A different principal must approve the template.');
  }
  const preview = await previewResponseTemplate(scope, { templateId, variables: {} });
  if (!preview.passed) {
    throw new PolicyGovernanceOperationError('TEMPLATE_RECHECK_FAILED', 'The template failed output safety recheck.', 422);
  }
  const now = new Date();
  const result = await db.transaction(async (transaction) => {
    const [current] = await transaction.select().from(responseTemplates).where(and(
      eq(responseTemplates.id, templateId),
      scopePredicate(responseTemplates, scope),
    )).limit(1).for('update');
    if (!current || current.approvalStatus !== 'pending') {
      throw new PolicyGovernanceOperationError('TEMPLATE_STATE_CONFLICT', 'Template state changed; reload and retry.');
    }
    await transaction.update(responseTemplates).set({
      approvalStatus: 'retired', enabled: false, validTo: now,
    }).where(and(
      scopePredicate(responseTemplates, scope),
      eq(responseTemplates.templateKey, current.templateKey),
      eq(responseTemplates.approvalStatus, 'approved'),
      ne(responseTemplates.id, current.id),
    ));
    const [updated] = await transaction.update(responseTemplates).set({
      approvalStatus: 'approved', approvedBy: actorId, approvedAt: now, enabled: true,
    }).where(and(
      eq(responseTemplates.id, current.id),
      eq(responseTemplates.approvalStatus, 'pending'),
      scopePredicate(responseTemplates, scope),
    )).returning();
    if (!updated) throw new PolicyGovernanceOperationError('TEMPLATE_STATE_CONFLICT', 'Template state changed; reload and retry.');
    return {
      id: updated.id,
      approvalStatus: updated.approvalStatus,
      approvedAt: updated.approvedAt,
      recheck: preview.recheck,
      approvalReasonDigest: createHash('sha256').update(reason, 'utf8').digest('hex'),
    };
  });
  clearRuntimePolicyBundleCache();
  return result;
}

export async function rollbackResponseTemplate(
  scope: TenantScope,
  actorId: string,
  templateId: string,
  reason: string,
) {
  const result = await db.transaction(async (transaction) => {
    const [current] = await transaction.select().from(responseTemplates).where(and(
      eq(responseTemplates.id, templateId),
      scopePredicate(responseTemplates, scope),
    )).limit(1).for('update');
    if (!current || current.approvalStatus !== 'approved' || !current.enabled) {
      throw new PolicyGovernanceOperationError('TEMPLATE_STATE_INVALID', 'Only the active approved template can be rolled back.');
    }
    const [previous] = await transaction.select().from(responseTemplates).where(and(
      scopePredicate(responseTemplates, scope),
      eq(responseTemplates.templateKey, current.templateKey),
      eq(responseTemplates.approvalStatus, 'retired'),
    )).orderBy(desc(responseTemplates.version)).limit(1).for('update');
    if (!previous) {
      throw new PolicyGovernanceOperationError('TEMPLATE_ROLLBACK_UNAVAILABLE', 'No previously approved template version is available.');
    }
    const previousDraft = rowAsDraft(previous);
    verifyTemplateIntegrity(previous, previousDraft);
    const now = new Date();
    await transaction.update(responseTemplates).set({
      approvalStatus: 'retired', enabled: false, validTo: now,
    }).where(and(eq(responseTemplates.id, current.id), scopePredicate(responseTemplates, scope)));
    await transaction.update(responseTemplates).set({
      approvalStatus: 'approved', enabled: true, validTo: null,
      approvedBy: actorId, approvedAt: now,
    }).where(and(eq(responseTemplates.id, previous.id), scopePredicate(responseTemplates, scope)));
    return {
      rolledBackTemplateId: current.id,
      restoredTemplateId: previous.id,
      restoredVersion: previous.version,
      reasonDigest: createHash('sha256').update(reason, 'utf8').digest('hex'),
    };
  });
  clearRuntimePolicyBundleCache();
  return result;
}
