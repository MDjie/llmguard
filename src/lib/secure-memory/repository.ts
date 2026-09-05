import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { guardDecisionSchema } from '@/contracts/http/guard-v1';
import type { GuardRequest, GuardDecision } from '@guardllm/contracts';
import type { MasterKey } from '@/lib/secrets';
import { isConfirmedObservation } from '@/lib/guard-engine-v2/observation-role';
import { receiptReference, sessionRequestHmac } from './request-receipt';
import { loadMasterKey, openSecret, sealSecret } from '@/lib/secrets';
import { db } from '@/storage/database/shared/db';
import {
  guardMemoryEvents,
  guardMemoryGraphEdges,
  guardMemoryRiskLedgers,
  guardSessionRiskStates,
  guardSessionRequestReceipts,
} from '@/storage/database/shared/schema';
import { mergeRiskLedger } from './ledger';
import {
  advanceSessionRiskState,
  closeSessionRiskState,
  type SessionIntentNode,
  type SessionStateTransition,
} from './session-risk-state';
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

export class SecureMemoryReplayError extends Error {
  constructor(readonly code:'SECURE_MEMORY_REQUEST_CONFLICT'|'SECURE_MEMORY_RECEIPT_EXPIRED'|'SECURE_MEMORY_RECEIPT_KEY_UNAVAILABLE') {
    super(code);this.name='SecureMemoryReplayError';
  }
}
function assertRequestScope(scope:AppendSecureMemoryEvaluationInput['scope'],request:GuardRequest,sessionId:string) {
  if(!sessionId || sessionId.length>128 || request.context.sessionId!==sessionId ||
    request.context.tenantId!==scope.tenantId || request.context.applicationId!==scope.applicationId)
    throw new Error('GUARD_SESSION_SCOPE_MISMATCH');
}
function receiptPredicate(request:GuardRequest) {
  return and(eq(guardSessionRequestReceipts.tenantId,request.context.tenantId),
    eq(guardSessionRequestReceipts.applicationId,request.context.applicationId),
    eq(guardSessionRequestReceipts.sessionId,request.context.sessionId!),
    eq(guardSessionRequestReceipts.requestId,request.context.requestId),
    eq(guardSessionRequestReceipts.direction,request.context.direction));
}
function decodeReceipt(row:typeof guardSessionRequestReceipts.$inferSelect,request:GuardRequest,key:MasterKey) {
  if(row.expiresAt.getTime()<=Date.now() || !row.decisionEnvelopes.length)throw new SecureMemoryReplayError('SECURE_MEMORY_RECEIPT_EXPIRED');
  if(row.keyId!==key.id)throw new SecureMemoryReplayError('SECURE_MEMORY_RECEIPT_KEY_UNAVAILABLE');
  if(row.requestHmac!==sessionRequestHmac(request,key))throw new SecureMemoryReplayError('SECURE_MEMORY_REQUEST_CONFLICT');
  const decision:GuardDecision=guardDecisionSchema.parse(JSON.parse(row.decisionEnvelopes.map((envelope,index)=>
    openSecret(envelope,receiptReference(request,index),key)).join('')));
  return {eventId:row.eventId,stateVersion:row.stateVersion,sequenceNumber:row.sequenceNumber,decision};
}
export async function readSecureMemoryReplay(scope:AppendSecureMemoryEvaluationInput['scope'],request:GuardRequest):Promise<GuardDecision|undefined> {
  assertRequestScope(scope,request,request.context.sessionId ?? '');
  const [row]=await db.select().from(guardSessionRequestReceipts).where(receiptPredicate(request)).limit(1);
  if(!row)return undefined;
  const key=loadMasterKey();
  try{return decodeReceipt(row,request,key).decision;}finally{key.bytes.fill(0);}
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

function normalizeRiskState(value: string | undefined): SecureMemorySnapshot['riskState'] {
  switch (value) {
    case 'WATCH':
    case 'ELEVATED': return 'WATCH';
    case 'ESCALATED':
    case 'RESTRICTED':
    case 'REVIEW_REQUIRED': return 'ESCALATED';
    case 'LOCKED':
    case 'BLOCKED': return 'LOCKED';
    default: return 'NORMAL';
  }
}

export async function readSecureMemorySnapshot(
  scope: AppendSecureMemoryEvaluationInput['scope'],
  sessionId: string,
): Promise<SecureMemorySnapshot> {
  if (!sessionId || sessionId.length > 128) throw new Error('GUARD_SESSION_ID_INVALID');
  const [stored, ledger] = await db.transaction(transaction=>Promise.all([
    transaction.select().from(guardSessionRiskStates).where(and(
      eq(guardSessionRiskStates.tenantId, scope.tenantId),
      eq(guardSessionRiskStates.applicationId, scope.applicationId),
      eq(guardSessionRiskStates.sessionId, sessionId),
    )).limit(1).then((rows) => rows[0]),
    transaction.select().from(guardMemoryRiskLedgers).where(and(
      eq(guardMemoryRiskLedgers.tenantId, scope.tenantId),
      eq(guardMemoryRiskLedgers.applicationId, scope.applicationId),
      eq(guardMemoryRiskLedgers.sessionId, sessionId),
    )).limit(1).then((rows) => rows[0]),
  ]),{isolationLevel:'repeatable read',accessMode:'read only'});
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
    riskState: normalizeRiskState(activeLedger?.riskState),
    maxRiskLevel: (activeLedger?.maxRiskLevel ?? 'NONE') as SecureMemorySnapshot['maxRiskLevel'],
    cumulativeScore: activeLedger?.cumulativeScore ?? 0,
    intentNodes: (activeLedger?.intentNodes ?? []) as readonly SessionIntentNode[],
    stateTransitions: (activeLedger?.stateTransitions ?? []) as readonly SessionStateTransition[],
  };
}

export async function appendSecureMemoryEvaluation(
  input: AppendSecureMemoryEvaluationInput,
): Promise<{ readonly eventId: string; readonly stateVersion: number; readonly sequenceNumber: number; readonly decision:GuardDecision }> {
  assertRequestScope(input.scope,input.request,input.sessionId);
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
      // Covers the empty-session race, where SELECT FOR UPDATE alone locks no row.
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${stateReference(input.scope,input.sessionId)}))`);
      const [receipt]=await transaction.select().from(guardSessionRequestReceipts).where(receiptPredicate(input.request)).limit(1);
      if(receipt)return decodeReceipt(receipt,input.request,key);
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
    .filter(isConfirmedObservation)
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
      const previousRiskState = normalizeRiskState(storedLedger?.riskState);
      const riskAssessment = input.riskAssessment ?? advanceSessionRiskState({
        previousState: previousRiskState,
        previousNodes: (storedLedger?.intentNodes ?? []) as readonly SessionIntentNode[],
        previousTransitions: (storedLedger?.stateTransitions ?? []) as readonly SessionStateTransition[],
        request: input.request,
        decision: input.decision,
        occurredAt,
      });
      const nextLedger = {
        ...input.scope,
        sessionId: input.sessionId,
        stateVersion: (storedLedger?.stateVersion ?? 0) + 1,
        riskState: riskAssessment.state,
        maxRiskLevel: ledger.maxRiskLevel,
        cumulativeScore: ledger.cumulativeScore,
        entries: ledger.entries.map((entry) => ({
          ...entry,
          evidenceHmacs: [...entry.evidenceHmacs],
        })),
        intentNodes: riskAssessment.intentNodes.map((node) => ({
          ...node,
          phases: [...node.phases],
          riskTypes: [...node.riskTypes],
          sources: [...node.sources],
          evidenceHmacs: [...node.evidenceHmacs],
        })),
        stateTransitions: riskAssessment.transitions.map((transition) => ({ ...transition })),
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
          intentNodes: nextLedger.intentNodes,
          stateTransitions: nextLedger.stateTransitions,
          sensitivityLabels: nextLedger.sensitivityLabels,
          sourceEnvelopeIds: nextLedger.sourceEnvelopeIds,
          lastDecisionId: nextLedger.lastDecisionId,
          expiresAt: nextLedger.expiresAt,
          updatedAt: nextLedger.updatedAt,
        },
      });
      await transaction.update(guardSessionRiskStates).set({
        riskVector: { ...riskAssessment.riskVector },
        recentRiskTypes: [...riskAssessment.recentRiskTypes],
        escalationLevel: riskAssessment.escalationLevel,
        lastRequestId: input.request.context.requestId,
        updatedAt: occurredAt,
      }).where(and(
        eq(guardSessionRiskStates.tenantId, input.scope.tenantId),
        eq(guardSessionRiskStates.applicationId, input.scope.applicationId),
        eq(guardSessionRiskStates.sessionId, input.sessionId),
      ));
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
      const serializedDecision=JSON.stringify(guardDecisionSchema.parse(input.decision));
      if(Buffer.byteLength(serializedDecision,'utf8')>4*1024*1024)throw new Error('SECURE_MEMORY_RECEIPT_TOO_LARGE');
      await transaction.insert(guardSessionRequestReceipts).values({...input.scope,
        sessionId:input.sessionId,requestId:input.request.context.requestId,direction:input.request.context.direction,
        requestHmac:sessionRequestHmac(input.request,key),keyId:key.id,
        decisionEnvelopes:splitUtf8(serializedDecision).map((part,index)=>sealSecret(part,receiptReference(input.request,index),key)),
        eventId,stateVersion,sequenceNumber,expiresAt,createdAt:occurredAt,
      });
      return { eventId, stateVersion, sequenceNumber, decision:input.decision };
    });
  } finally {
    key.bytes.fill(0);
  }
}

export async function endSecureMemorySession(
  scope: AppendSecureMemoryEvaluationInput['scope'],
  sessionId: string,
  occurredAt = new Date(),
): Promise<void> {
  if (!sessionId || sessionId.length > 128) throw new Error('GUARD_SESSION_ID_INVALID');
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${stateReference(scope,sessionId)}))`);
    const ledger = await transaction.select().from(guardMemoryRiskLedgers).where(and(
      eq(guardMemoryRiskLedgers.tenantId, scope.tenantId),
      eq(guardMemoryRiskLedgers.applicationId, scope.applicationId),
      eq(guardMemoryRiskLedgers.sessionId, sessionId),
    )).limit(1).for('update').then((rows) => rows[0]);
    const closed = closeSessionRiskState({
      previousState: normalizeRiskState(ledger?.riskState),
      previousTransitions: (ledger?.stateTransitions ?? []) as readonly SessionStateTransition[],
      occurredAt,
    });
    if (ledger) {
      await transaction.update(guardMemoryRiskLedgers).set({
        riskState: closed.state,
        intentNodes: [],
        stateTransitions: closed.transitions.map((transition) => ({ ...transition })),
        cumulativeScore: 0,
        stateVersion: ledger.stateVersion + 1,
        expiresAt: occurredAt,
        updatedAt: occurredAt,
      }).where(and(
        eq(guardMemoryRiskLedgers.tenantId, scope.tenantId),
        eq(guardMemoryRiskLedgers.applicationId, scope.applicationId),
        eq(guardMemoryRiskLedgers.sessionId, sessionId),
      ));
    }
    await transaction.update(guardSessionRiskStates).set({
      riskVector: {},
      recentRiskTypes: [],
      escalationLevel: 0,
      expiresAt: occurredAt,
      stateVersion: sql`${guardSessionRiskStates.stateVersion} + 1`,
      updatedAt: occurredAt,
    }).where(and(
      eq(guardSessionRiskStates.tenantId, scope.tenantId),
      eq(guardSessionRiskStates.applicationId, scope.applicationId),
      eq(guardSessionRiskStates.sessionId, sessionId),
    ));
    await transaction.update(guardSessionRequestReceipts).set({expiresAt:occurredAt,decisionEnvelopes:[]}).where(and(
      eq(guardSessionRequestReceipts.tenantId,scope.tenantId),eq(guardSessionRequestReceipts.applicationId,scope.applicationId),
      eq(guardSessionRequestReceipts.sessionId,sessionId)));
  });
}
