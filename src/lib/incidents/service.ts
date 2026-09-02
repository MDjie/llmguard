import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ApiProblem } from '@/lib/api-security';
import { scopePredicate, type TenantContext } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { incidentTransitions, securityIncidents } from '@/storage/database/shared/schema';
import { assertIncidentTransition, IncidentTransitionError, incidentSlaBreached, type IncidentStatus } from './state-machine';

export interface CreateIncidentInput {
  readonly title: string;
  readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly riskType: string;
  readonly eventAnalysis: string;
  readonly attackTechnique: string;
  readonly impact: string;
  readonly answerEvidence: string;
  readonly assigneeId?: string;
  readonly slaMinutes: number;
}

export function buildIncidentPersistenceRecords(
  scope: TenantContext,
  input: CreateIncidentInput,
  now = new Date(),
  id = randomUUID(),
) {
  const incident = {
    tenantId: scope.tenantId,
    applicationId: scope.applicationId,
    id,
    incidentNumber: 'INC-' + now.toISOString().slice(0, 10).replaceAll('-', '') + '-' + id.slice(0, 8).toUpperCase(),
    title: input.title,
    severity: input.severity,
    status: 'PENDING_REVIEW',
    traceId: input.traceId,
    sessionId: input.sessionId,
    riskType: input.riskType,
    eventAnalysis: input.eventAnalysis,
    attackTechnique: input.attackTechnique,
    impact: input.impact,
    answerEvidence: input.answerEvidence,
    assigneeId: input.assigneeId,
    slaDueAt: new Date(now.getTime() + input.slaMinutes * 60_000),
    version: 1,
    createdBy: scope.principalId,
    createdAt: now,
    updatedAt: now,
  } as const;
  const transition = {
    tenantId: scope.tenantId,
    applicationId: scope.applicationId,
    incidentId: id,
    fromStatus: null,
    toStatus: 'PENDING_REVIEW',
    actorId: scope.principalId,
    note: 'Incident created',
    version: 1,
    createdAt: now,
  } as const;
  return { incident, transition };
}

export async function createIncident(scope: TenantContext, input: CreateIncidentInput) {
  const now = new Date();
  const id = randomUUID();
  const records = buildIncidentPersistenceRecords(scope, input, now, id);
  return db.transaction(async (transaction) => {
    const [incident] = await transaction.insert(securityIncidents).values(records.incident).returning();
    await transaction.insert(incidentTransitions).values(records.transition);
    if (!incident) throw new Error('Incident insert returned no row');
    return incident;
  });
}

export async function listIncidents(scope: TenantContext, input: {
  readonly status?: IncidentStatus;
  readonly severity?: string;
  readonly limit: number;
  readonly offset: number;
}) {
  const conditions = [scopePredicate(securityIncidents, scope)];
  if (input.status) conditions.push(eq(securityIncidents.status, input.status));
  if (input.severity) conditions.push(eq(securityIncidents.severity, input.severity));
  const predicate = and(...conditions);
  const [items, countRows] = await Promise.all([
    db.select().from(securityIncidents).where(predicate).orderBy(desc(securityIncidents.createdAt)).limit(input.limit).offset(input.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(securityIncidents).where(predicate),
  ]);
  const now = new Date();
  return {
    items: items.map((item) => ({ ...item, slaBreached: incidentSlaBreached(item.status as IncidentStatus, item.slaDueAt, now) })),
    total: Number(countRows[0]?.count ?? 0),
  };
}

export async function getIncident(scope: TenantContext, incidentId: string) {
  const [incident] = await db.select().from(securityIncidents).where(and(
    scopePredicate(securityIncidents, scope),
    eq(securityIncidents.id, incidentId),
  )).limit(1);
  if (!incident) return null;
  const transitions = await db.select().from(incidentTransitions).where(and(
    scopePredicate(incidentTransitions, scope),
    eq(incidentTransitions.incidentId, incidentId),
  )).orderBy(incidentTransitions.version);
  return {
    ...incident,
    slaBreached: incidentSlaBreached(incident.status as IncidentStatus, incident.slaDueAt),
    transitions,
  };
}

export async function transitionIncident(scope: TenantContext, input: {
  readonly incidentId: string;
  readonly expectedVersion: number;
  readonly toStatus: IncidentStatus;
  readonly assigneeId?: string;
  readonly note?: string;
}) {
  try {
    return await db.transaction(async (transaction) => {
      const [current] = await transaction.select().from(securityIncidents).where(and(
        scopePredicate(securityIncidents, scope),
        eq(securityIncidents.id, input.incidentId),
      )).limit(1).for('update');
      if (!current) throw new ApiProblem({
        status: 404,
        code: 'INCIDENT_NOT_FOUND',
        title: 'Incident not found',
        detail: 'The incident does not exist in the current application scope.',
      });
      if (current.version !== input.expectedVersion) {
        throw new ApiProblem({
          status: 409,
          code: 'INCIDENT_VERSION_CONFLICT',
          title: 'Incident version conflict',
          detail: 'The incident was changed by another operator. Reload it before retrying.',
        });
      }
      const assigneeId = input.assigneeId ?? current.assigneeId;
      assertIncidentTransition({ from: current.status as IncidentStatus, to: input.toStatus, assigneeId, note: input.note });
      const now = new Date();
      const version = current.version + 1;
      const [updated] = await transaction.update(securityIncidents).set({
        status: input.toStatus,
        assigneeId,
        resolution: input.note ?? current.resolution,
        version,
        updatedAt: now,
        ...(input.toStatus === 'CLOSED' ? { closedAt: now } : {}),
      }).where(and(
        scopePredicate(securityIncidents, scope),
        eq(securityIncidents.id, input.incidentId),
        eq(securityIncidents.version, input.expectedVersion),
      )).returning();
      if (!updated) throw new ApiProblem({
        status: 409,
        code: 'INCIDENT_VERSION_CONFLICT',
        title: 'Incident version conflict',
        detail: 'The incident was changed by another operator. Reload it before retrying.',
      });
      await transaction.insert(incidentTransitions).values({
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        incidentId: input.incidentId,
        fromStatus: current.status,
        toStatus: input.toStatus,
        actorId: scope.principalId,
        note: input.note,
        assigneeId,
        version,
        createdAt: now,
      });
      return updated;
    });
  } catch (error) {
    if (error instanceof IncidentTransitionError) {
      throw new ApiProblem({ status: 409, code: error.code, title: 'Incident transition rejected', detail: error.message });
    }
    throw error;
  }
}
