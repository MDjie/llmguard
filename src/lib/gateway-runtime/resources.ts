import { and, eq, gte, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { gatewayAdmissionWindows, gatewayExecutionEvents, gatewayRequestResources, gatewayRequests } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import type { RuntimeManifest } from '../../../packages/contracts/generated/typescript/gateway-v2';
import type { GatewayTransaction } from './snapshot-factory';
import { canonicalJson, GatewayError } from './protocol';
import { evidenceHmac } from './security';

const terminalStates = ['COMPLETED', 'TERMINATED', 'REVIEW_REQUIRED', 'UPSTREAM_OUTCOME_UNKNOWN'];
const admissionSchema = z.object({
  version: z.literal('1.0'), unit: z.literal('UTF16_CODE_UNITS'), snapshotId: z.string(),
  limits: z.object({ requestsPerMinute: z.number().int().positive(), concurrentRequests: z.number().int().positive(), reservedChars: z.number().int().positive() }).strict(),
  reserved: z.object({ inputChars: z.number().int().nonnegative(), outputChars: z.number().int().nonnegative(), inspectionSteps: z.number().int().positive(), references: z.number().int().nonnegative() }).strict(),
  expiresAt: z.number().int(), rateWindow: z.number().int(), tokenMeasurement: z.literal('NOT_MEASURED'), monetaryCost: z.literal('NOT_PRICED'),
}).strict();

function setting(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new GatewayError('GATEWAY_ADMISSION_CONFIGURATION_INVALID', 503);
  return value;
}

/** Call in the same transaction as the request claim, before any reference reads or detection. */
export async function admitGatewayResources(tx: GatewayTransaction, input: TenantScope & {
  requestId: string; snapshotId: string; budgets: RuntimeManifest['budgets']; expiresAt: number; references: number;
}): Promise<void> {
  const limits = { requestsPerMinute: setting('GATEWAY_BUSINESS_REQUESTS_PER_MINUTE', 600, 1_000_000),
    concurrentRequests: setting('GATEWAY_BUSINESS_CONCURRENCY', 128, 10_000), reservedChars: setting('GATEWAY_RESERVED_CHARS_PER_APPLICATION', 50_331_648, 2_000_000_000) };
  const now = Date.now(), start = new Date(Math.floor(now / 60_000) * 60_000);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.tenantId + ':' + input.applicationId + ':gateway-admission'}, 0))`);
  const [window] = await tx.select().from(gatewayAdmissionWindows).where(and(scopePredicate(gatewayAdmissionWindows, input), eq(gatewayAdmissionWindows.windowStart, start)));
  if ((window?.admitted ?? 0) >= limits.requestsPerMinute) throw new GatewayError('BUSINESS_REQUEST_RATE_EXCEEDED', 429);
  // The newly claimed request participates in this count. Expired requests cannot send again.
  const [active] = await tx.select({ count: sql<number>`count(*)::int`, chars: sql<number>`coalesce(sum((${gatewayRequestResources.admission}->'reserved'->>'inputChars')::bigint + (${gatewayRequestResources.admission}->'reserved'->>'outputChars')::bigint),0)::float8` })
    .from(gatewayRequests).leftJoin(gatewayRequestResources, eq(gatewayRequests.id, gatewayRequestResources.requestId))
    .where(and(scopePredicate(gatewayRequests, input), notInArray(gatewayRequests.state, terminalStates), gte(gatewayRequests.expiresAt, new Date(now))));
  if (active.count > limits.concurrentRequests) throw new GatewayError('BUSINESS_CONCURRENCY_EXCEEDED', 429);
  const reserved = { inputChars: input.budgets.maxInputChars, outputChars: input.budgets.maxOutputChars, inspectionSteps: input.budgets.maxSteps, references: input.references };
  if (active.chars + reserved.inputChars + reserved.outputChars > limits.reservedChars) throw new GatewayError('BUSINESS_RESOURCE_CAPACITY_EXCEEDED', 429);
  const admission = admissionSchema.parse({ version: '1.0', unit: 'UTF16_CODE_UNITS', snapshotId: input.snapshotId, limits, reserved, expiresAt: input.expiresAt, rateWindow: start.getTime(), tokenMeasurement: 'NOT_MEASURED', monetaryCost: 'NOT_PRICED' });
  await tx.insert(gatewayRequestResources).values({ tenantId: input.tenantId, applicationId: input.applicationId, requestId: input.requestId, admission, admissionHmac: evidenceHmac(canonicalJson(admission)) });
  await tx.insert(gatewayAdmissionWindows).values({ tenantId: input.tenantId, applicationId: input.applicationId, windowStart: start, admitted: 1 })
    .onConflictDoUpdate({ target: [gatewayAdmissionWindows.tenantId, gatewayAdmissionWindows.applicationId, gatewayAdmissionWindows.windowStart], set: { admitted: sql`${gatewayAdmissionWindows.admitted} + 1` } });
}

export async function preparedGatewayResources(tx: GatewayTransaction, scope: TenantScope, id: string, chars: number, references: number): Promise<void> {
  const [row] = await tx.select().from(gatewayRequestResources).where(and(scopePredicate(gatewayRequestResources, scope), eq(gatewayRequestResources.requestId, id))).for('update');
  if (!row || row.state !== 'RESERVED') throw new GatewayError('REQUEST_PREPARATION_CLOSED', 409);
  const admission = admissionSchema.parse(row.admission);
  if (chars > admission.reserved.inputChars || references > admission.reserved.references) throw new GatewayError('PREPARED_RESOURCE_BUDGET_EXCEEDED', 413);
  await tx.update(gatewayRequestResources).set({ preparedInputChars: chars, preparedReferences: references }).where(eq(gatewayRequestResources.requestId, id));
}

export async function measureGatewayInspection(tx: GatewayTransaction, scope: TenantScope, id: string, chars: number): Promise<void> {
  const [row] = await tx.select().from(gatewayRequestResources).where(and(scopePredicate(gatewayRequestResources, scope), eq(gatewayRequestResources.requestId, id))).for('update');
  if (!row) return; // Expanded schema remains compatible with requests admitted by the previous binary.
  if (row.state !== 'RESERVED') throw new GatewayError('RESOURCE_RESERVATION_CLOSED', 409);
  const admission = admissionSchema.parse(row.admission);
  if (row.inspectionSteps >= admission.reserved.inspectionSteps) throw new GatewayError('INTERNAL_STEP_BUDGET_EXCEEDED', 429);
  await tx.update(gatewayRequestResources).set({ inspectedChars: row.inspectedChars + chars, inspectionSteps: row.inspectionSteps + 1 }).where(eq(gatewayRequestResources.requestId, id));
}

/** Request lock and terminal event must precede settlement in this transaction. */
export async function settleGatewayResources(tx: GatewayTransaction, scope: TenantScope, id: string, terminal: string): Promise<void> {
  if (!terminalStates.includes(terminal)) return;
  const [row] = await tx.select().from(gatewayRequestResources).where(and(scopePredicate(gatewayRequestResources, scope), eq(gatewayRequestResources.requestId, id))).for('update');
  if (!row || row.state !== 'RESERVED') return;
  const admission = admissionSchema.parse(row.admission);
  const events = await tx.select({ kind: gatewayExecutionEvents.kind, start: gatewayExecutionEvents.rangeStart, end: gatewayExecutionEvents.rangeEnd }).from(gatewayExecutionEvents)
    .where(and(scopePredicate(gatewayExecutionEvents, scope), eq(gatewayExecutionEvents.requestId, id)));
  const sent = events.some(event => event.kind === 'UPSTREAM_SEND_STARTED');
  const releasedChars = events.filter(event => event.kind === 'WRITE_ACCEPTED').reduce((sum, event) => sum + Math.max(0, (event.end ?? 0) - (event.start ?? 0)), 0);
  const unknown = terminal === 'UPSTREAM_OUTCOME_UNKNOWN';
  const settlement = { version: '1.0', unit: 'UTF16_CODE_UNITS', terminal,
    observed: { preparedInputChars: row.preparedInputChars, inspectedChars: row.inspectedChars, inspectionSteps: row.inspectionSteps, preparedReferences: row.preparedReferences, serverAcceptedOutputChars: releasedChars, upstreamSendStarted: sent },
    released: { concurrencySlots: 1, inspectionSteps: admission.reserved.inspectionSteps - row.inspectionSteps, outputChars: !sent && !unknown ? admission.reserved.outputChars : null },
    unmeasured: ['MODEL_INPUT_TOKENS', 'MODEL_OUTPUT_TOKENS', 'MONETARY_COST', ...(sent ? ['MODEL_TOTAL_GENERATED_CHARS'] : []), ...(row.preparedReferences === null ? ['REFERENCE_PREPARATION_OUTCOME'] : [])],
    businessRequestCharge: 1, modelOutcome: unknown ? 'UNKNOWN' : sent ? 'SEE_EXECUTION_EVENTS' : 'NOT_SENT',
    note: 'Admission capacity is released at terminal or deadline; unknown model consumption is never refunded as known unused quota.' };
  await tx.update(gatewayRequestResources).set({ state: unknown ? 'UNKNOWN' : 'SETTLED', settlement, settlementHmac: evidenceHmac(canonicalJson(settlement)), settledAt: new Date() }).where(eq(gatewayRequestResources.requestId, id));
}
