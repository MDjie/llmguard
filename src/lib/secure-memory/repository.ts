import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { loadMasterKey, openSecret, sealSecret } from '@/lib/secrets';
import { db } from '@/storage/database/shared/db';
import {
  guardMemoryEvents,
  guardMemoryGraphEdges,
  guardMemoryRiskLedgers,
  guardSessionRiskStates,
} from '@/storage/database/shared/schema';
import { mergeRiskLedger } from './ledger';
import type {
  AppendSecureMemoryEvaluationInput,
  RiskLedgerEntry,
  SecureMemoryEventType,
  SecureMemorySnapshot,
} from './types';

const MAX_SESSION_HOT_WINDOW_CHARS = 4_096;
const MAX_EVENT_PLAINTEXT_BYTES = 12 * 1_024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export class SecureMemoryVersionConflictError extends Error {
  constructor() {
    super('SECURE_MEMORY_VERSION_CONFLICT');
    this.name = 'SecureMemoryVersionConflictError';
  }
}

function stateReference(scope: AppendSecureMemoryEvaluationInput['scope'], sessionId: string): string {
  return ['guard-session', scope.tenantId, scope.applicationId, sessionId].join(':');
}

function eventReference(
  scope: AppendSecureMemoryEvaluationInput['scope'],
  eventId: string,
  part: number,
): string {
  return ['guard-memory-event', scope.tenantId, scope.applicationId, eventId, part].join(':');
}

function ttlMs(): number {
  const configured = Number(process.env.GUARD_SESSION_STATE_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(configured)
    ? Math.min(MAX_TTL_MS, Math.max(60_000, Math.floor(configured)))
    : DEFAULT_TTL_MS;
}

function splitUtf8(value: string): string[] {
  const chunks: string[] = [];
  let characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > MAX_EVENT_PLAINTEXT_BYTES && characters.length > 0) {
      chunks.push(characters.join(''));
      characters = [];
      bytes = 0;
    }
    characters.push(character);
    bytes += size;
  }
  if (characters.length > 0) chunks.push(characters.join(''));
  return chunks;
}

function eventType(direction: AppendSecureMemoryEvaluationInput['request']['context']['direction']): SecureMemoryEventType {
  switch (direction) {
    case 'OUTPUT_CHUNK':
    case 'OUTPUT_COMPLETE': return 'MODEL_OUTPUT';
    case 'RAG_INGEST': return 'RAG_INGEST';
    case 'RAG_CONTEXT': return 'RAG_RECALL';
    case 'TOOL_REQUEST': return 'TOOL_REQUEST';
    case 'TOOL_RESULT': return 'TOOL_RESPONSE';
    default: return 'MESSAGE';
  }
}

function uniqueBounded(values: readonly string[], maximum: number): string[] {
  return [...new Set(values)].slice(-maximum);
}

export async function readSecureMemorySnapshot(
  scope: AppendSecureMemoryEvaluationInput['scope'],
  sessionId: string,
): Promise<SecureMemorySnapshot> {
  if (!sessionId || sessionId.length > 128) throw new Error('GUARD_SESSION_ID_INVALID');
  const [stored, ledger] = await Promise.all([
    db.select().from(guardSessionRiskStates).where(and(
      eq(guardSessionRiskStates.tenantId, scope.tenantId),
      eq(guardSessionRiskStates.applicationId, scope.applicationId),
      eq(guardSessionRiskStates.sessionId, sessionId),
    )).limit(1).then((rows) => rows[0]),
    db.select().from(guardMemoryRiskLedgers).where(and(
      eq(guardMemoryRiskLedgers.tenantId, scope.tenantId),
      eq(guardMemoryRiskLedgers.applicationId, scope.applicationId),
      eq(guardMemoryRiskLedgers.sessionId, sessionId),
    )).limit(1).then((rows) => rows[0]),
  ]);
  const active = stored && stored.expiresAt.getTime() > Date.now();
  let hotWindow = '';
  if (active) {
    const key = loadMasterKey();
    try {
      hotWindow = openSecret(stored.tailEnvelope, stateReference(scope, sessionId), key);
    } finally {
      key.bytes.fill(0);
    }
  }
  const activeLedger = ledger && ledger.expiresAt.getTime() > Date.now() ? ledger : undefined;
  return {
    hotWindow,
    hasHistory: hotWindow.length > 0,
    turnCount: active ? stored.turnCount : 0,
    stateVersion: stored?.stateVersion ?? 0,
    lastEventSequence: stored?.lastEventSequence ?? 0,
    riskLedger: activeLedger?.entries ?? [],
    riskState: (activeLedger?.riskState ?? 'NORMAL') as SecureMemorySnapshot['riskState'],
    maxRiskLevel: (activeLedger?.maxRiskLevel ?? 'NONE') as SecureMemorySnapshot['maxRiskLevel'],
    cumulativeScore: activeLedger?.cumulativeScore ?? 0,
  };
}

export async function appendSecureMemoryEvaluation(
  input: AppendSecureMemoryEvaluationInput,
): Promise<{ readonly eventId: string; readonly stateVersion: number; readonly sequenceNumber: number }> {
  if (!input.sessionId || input.sessionId.length > 128) throw new Error('GUARD_SESSION_ID_INVALID');
  if (input.tokenCount !== undefined && (!Number.isSafeInteger(input.tokenCount) || input.tokenCount < 0)) {
    throw new Error('GUARD_SESSION_TOKEN_COUNT_INVALID');
  }
  const text = input.request.content.text ?? '';
  const eventId = randomUUID();
  const occurredAt = new Date();
  const expiresAt = new Date(occurredAt.getTime() + ttlMs());
  const key = loadMasterKey();
  try {
    const serialized = JSON.stringify({ text });
    const payloadEnvelopes = splitUtf8(serialized).map((part, index) =>
      sealSecret(part, eventReference(input.scope, eventId, index), key));
    return await db.transaction(async (transaction) => {
      const [stored] = await transaction.select().from(guardSessionRiskStates).where(and(
        eq(guardSessionRiskStates.tenantId, input.scope.tenantId),
        eq(guardSessionRiskStates.applicationId, input.scope.applicationId),
        eq(guardSessionRiskStates.sessionId, input.sessionId),
      )).limit(1).for('update');
      const actualVersion = stored?.stateVersion ?? 0;
      if (actualVersion !== input.expectedStateVersion) {
        throw new SecureMemoryVersionConflictError();
      }
      const active = stored && stored.expiresAt.getTime() > occurredAt.getTime() ? stored : undefined;
      const previous = active
        ? openSecret(active.tailEnvelope, stateReference(input.scope, input.sessionId), key)
        : '';
      const combined = previous ? previous + '\n[guard-turn-boundary]\n' + text : text;
      const hotWindow = combined.slice(-MAX_SESSION_HOT_WINDOW_CHARS) || '[empty]';
      const tailEnvelope = sealSecret(
        hotWindow,
        stateReference(input.scope, input.sessionId),
        key,
      );
      const sequenceNumber = (stored?.lastEventSequence ?? 0) + 1;
      const stateVersion = actualVersion + 1;
      const sourceEnvelopeIds = uniqueBounded(
        (input.request.content.envelopes ?? []).map((envelope) => envelope.envelopeId),
        512,
      );
      const sensitivityLabels = uniqueBounded(
        (input.request.content.envelopes ?? []).flatMap((envelope) => envelope.sensitivityLabels),
        256,
      );
      const riskLabels = uniqueBounded(input.decision.observations
        .filter((observation) => observation.status === 'MATCH')
        .map((observation) => observation.riskType), 256);
      await transaction.insert(guardMemoryEvents).values({
        ...input.scope,
        id: eventId,
        sessionId: input.sessionId,
        sequenceNumber,
        eventType: eventType(input.request.context.direction),
        contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
        payloadEnvelopes,
        sourceEnvelopeIds,
        parentEventIds: [],
        sensitivityLabels,
        riskLabels,
        policyBundleId: input.request.context.policyBundleId,
        decisionId: input.decision.decisionId,
        tokenizerId: input.tokenizerId ?? input.request.context.tokenizerId,
        tokenCount: input.tokenCount,
        expiresAt,
        createdAt: occurredAt,
      });
      const nextState = {
        ...input.scope,
        sessionId: input.sessionId,
        tailEnvelope,
        hotWindowTokenCount: input.tokenCount ?? 0,
        tokenizerId: input.tokenizerId ?? input.request.context.tokenizerId,
        lastEventSequence: sequenceNumber,
        turnCount: (active?.turnCount ?? 0) + 1,
        stateVersion,
        expiresAt,
        updatedAt: occurredAt,
      };
      await transaction.insert(guardSessionRiskStates).values(nextState).onConflictDoUpdate({
        target: [
          guardSessionRiskStates.tenantId,
          guardSessionRiskStates.applicationId,
          guardSessionRiskStates.sessionId,
        ],
        set: {
          tailEnvelope: nextState.tailEnvelope,
          hotWindowTokenCount: nextState.hotWindowTokenCount,
          tokenizerId: nextState.tokenizerId,
          lastEventSequence: nextState.lastEventSequence,
          turnCount: nextState.turnCount,
          stateVersion: nextState.stateVersion,
          expiresAt: nextState.expiresAt,
          updatedAt: nextState.updatedAt,
        },
      });
      const [storedLedger] = await transaction.select().from(guardMemoryRiskLedgers).where(and(
        eq(guardMemoryRiskLedgers.tenantId, input.scope.tenantId),
        eq(guardMemoryRiskLedgers.applicationId, input.scope.applicationId),
        eq(guardMemoryRiskLedgers.sessionId, input.sessionId),
      )).limit(1).for('update');
      const previousEntries: readonly RiskLedgerEntry[] = storedLedger
        && storedLedger.expiresAt.getTime() > occurredAt.getTime()
        ? storedLedger.entries
        : [];
      const ledger = mergeRiskLedger(previousEntries, input.decision, occurredAt);
      const nextLedger = {
        ...input.scope,
        sessionId: input.sessionId,
        stateVersion: (storedLedger?.stateVersion ?? 0) + 1,
        riskState: ledger.riskState,
        maxRiskLevel: ledger.maxRiskLevel,
        cumulativeScore: ledger.cumulativeScore,
        entries: ledger.entries.map((entry) => ({
          ...entry,
          evidenceHmacs: [...entry.evidenceHmacs],
        })),
        sensitivityLabels: uniqueBounded([
          ...(storedLedger?.sensitivityLabels ?? []),
          ...sensitivityLabels,
        ], 256),
        sourceEnvelopeIds: uniqueBounded([
          ...(storedLedger?.sourceEnvelopeIds ?? []),
          ...sourceEnvelopeIds,
        ], 512),
        lastDecisionId: input.decision.decisionId,
        expiresAt,
        updatedAt: occurredAt,
      };
      await transaction.insert(guardMemoryRiskLedgers).values(nextLedger).onConflictDoUpdate({
        target: [
          guardMemoryRiskLedgers.tenantId,
          guardMemoryRiskLedgers.applicationId,
          guardMemoryRiskLedgers.sessionId,
        ],
        set: {
          stateVersion: nextLedger.stateVersion,
          riskState: nextLedger.riskState,
          maxRiskLevel: nextLedger.maxRiskLevel,
          cumulativeScore: nextLedger.cumulativeScore,
          entries: nextLedger.entries,
          sensitivityLabels: nextLedger.sensitivityLabels,
          sourceEnvelopeIds: nextLedger.sourceEnvelopeIds,
          lastDecisionId: nextLedger.lastDecisionId,
          expiresAt: nextLedger.expiresAt,
          updatedAt: nextLedger.updatedAt,
        },
      });
      const graphEdges = (input.request.content.envelopes ?? []).flatMap((envelope) => [
        {
          ...input.scope,
          sessionId: input.sessionId,
          fromNodeType: 'CONTEXT_ENVELOPE',
          fromNodeId: envelope.envelopeId,
          toNodeType: 'MEMORY_EVENT',
          toNodeId: eventId,
          relation: 'CONTRIBUTED_TO',
          riskLabels,
        },
        ...envelope.parentEnvelopeIds.map((parentEnvelopeId) => ({
          ...input.scope,
          sessionId: input.sessionId,
          fromNodeType: 'CONTEXT_ENVELOPE',
          fromNodeId: parentEnvelopeId,
          toNodeType: 'CONTEXT_ENVELOPE',
          toNodeId: envelope.envelopeId,
          relation: 'DERIVED_INTO',
          riskLabels,
        })),
      ]);
      if (graphEdges.length > 0) {
        await transaction.insert(guardMemoryGraphEdges).values(graphEdges).onConflictDoNothing();
      }
      return { eventId, stateVersion, sequenceNumber };
    });
  } finally {
    key.bytes.fill(0);
  }
}
