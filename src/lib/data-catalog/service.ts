import { and, desc, eq, sql } from 'drizzle-orm';
import { ApiProblem } from '@/lib/api-security';
import { scopePredicate, type TenantContext } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { dataCatalogEntries, dataCatalogHistory } from '@/storage/database/shared/schema';
import type { ClassificationControls, ClassificationLevel, DataCategory } from './policy';
import { classificationControlViolations } from './policy';

export interface CatalogEntryInput {
  readonly assetCode: string;
  readonly name: string;
  readonly category: DataCategory;
  readonly classificationLevel: ClassificationLevel;
  readonly ownerId: string;
  readonly stewardId?: string;
  readonly retentionDays: number;
  readonly sourceSystem: string;
  readonly storageLocation: string;
  readonly legalBasis?: string;
  readonly controlPolicy: ClassificationControls;
}

function assertControls(level: ClassificationLevel, controls: ClassificationControls): void {
  const violations = classificationControlViolations(level, controls);
  if (violations.length > 0) {
    throw new ApiProblem({
      status: 422,
      code: 'DATA_CLASSIFICATION_CONTROLS_INSUFFICIENT',
      title: 'Data classification controls are insufficient',
      detail: violations.join(', '),
    });
  }
}

export async function createCatalogEntry(scope: TenantContext, input: CatalogEntryInput) {
  assertControls(input.classificationLevel, input.controlPolicy);
  const now = new Date();
  return db.transaction(async (transaction) => {
    const [entry] = await transaction.insert(dataCatalogEntries).values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      ...input,
      classificationStandards: ['GB/T 43697-2024', 'JR/T 0197-2020'],
      controlPolicy: { ...input.controlPolicy },
      status: 'ACTIVE',
      version: 1,
      createdBy: scope.principalId,
      updatedBy: scope.principalId,
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!entry) throw new Error('Data catalog insert returned no row');
    await transaction.insert(dataCatalogHistory).values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      catalogEntryId: entry.id,
      version: 1,
      actorId: scope.principalId,
      changeType: 'CREATED',
      snapshot: entry,
      createdAt: now,
    });
    return entry;
  });
}

export async function listCatalogEntries(scope: TenantContext, input: {
  readonly category?: DataCategory;
  readonly classificationLevel?: ClassificationLevel;
  readonly limit: number;
  readonly offset: number;
}) {
  const conditions = [scopePredicate(dataCatalogEntries, scope), eq(dataCatalogEntries.status, 'ACTIVE')];
  if (input.category) conditions.push(eq(dataCatalogEntries.category, input.category));
  if (input.classificationLevel) conditions.push(eq(dataCatalogEntries.classificationLevel, input.classificationLevel));
  const predicate = and(...conditions);
  const [items, countRows] = await Promise.all([
    db.select().from(dataCatalogEntries).where(predicate).orderBy(desc(dataCatalogEntries.updatedAt)).limit(input.limit).offset(input.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(dataCatalogEntries).where(predicate),
  ]);
  return { items, total: Number(countRows[0]?.count ?? 0) };
}

export async function updateCatalogEntry(scope: TenantContext, input: {
  readonly id: string;
  readonly expectedVersion: number;
  readonly classificationLevel: ClassificationLevel;
  readonly ownerId: string;
  readonly stewardId?: string;
  readonly retentionDays: number;
  readonly legalBasis?: string;
  readonly controlPolicy: ClassificationControls;
  readonly status: 'ACTIVE' | 'ARCHIVED';
}) {
  assertControls(input.classificationLevel, input.controlPolicy);
  return db.transaction(async (transaction) => {
    const [current] = await transaction.select().from(dataCatalogEntries).where(and(
      scopePredicate(dataCatalogEntries, scope), eq(dataCatalogEntries.id, input.id),
    )).limit(1).for('update');
    if (!current) throw new ApiProblem({ status: 404, code: 'DATA_CATALOG_ENTRY_NOT_FOUND', title: 'Data catalog entry not found', detail: 'The entry does not exist in the current application scope.' });
    if (current.version !== input.expectedVersion) throw new ApiProblem({ status: 409, code: 'DATA_CATALOG_VERSION_CONFLICT', title: 'Data catalog version conflict', detail: 'Reload the entry before retrying.' });
    const version = current.version + 1;
    const now = new Date();
    const [updated] = await transaction.update(dataCatalogEntries).set({
      classificationLevel: input.classificationLevel,
      ownerId: input.ownerId,
      stewardId: input.stewardId,
      retentionDays: input.retentionDays,
      legalBasis: input.legalBasis,
      controlPolicy: { ...input.controlPolicy },
      status: input.status,
      version,
      updatedBy: scope.principalId,
      updatedAt: now,
    }).where(and(
      scopePredicate(dataCatalogEntries, scope),
      eq(dataCatalogEntries.id, input.id),
      eq(dataCatalogEntries.version, input.expectedVersion),
    )).returning();
    if (!updated) throw new ApiProblem({ status: 409, code: 'DATA_CATALOG_VERSION_CONFLICT', title: 'Data catalog version conflict', detail: 'Reload the entry before retrying.' });
    await transaction.insert(dataCatalogHistory).values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      catalogEntryId: input.id,
      version,
      actorId: scope.principalId,
      changeType: input.status === 'ARCHIVED' ? 'ARCHIVED' : 'UPDATED',
      previousSnapshot: current,
      snapshot: updated,
      createdAt: now,
    });
    return updated;
  });
}
