import type { GuardDecision, GuardRequest, RiskLevel } from '@guardllm/contracts';
import type { TenantScope } from '@/lib/tenancy';
import type {
  SessionIntentNode,
  SessionRiskAssessment,
  SessionStateTransition,
} from './session-risk-state';

export type SecureMemoryEventType =
  | 'MESSAGE'
  | 'RAG_INGEST'
  | 'RAG_RECALL'
  | 'TOOL_REQUEST'
  | 'TOOL_RESPONSE'
  | 'MEMORY_WRITE'
  | 'MEMORY_RECALL'
  | 'MODEL_OUTPUT'
  | 'POLICY_SWITCH'
  | 'HUMAN_APPROVAL';

export type SecureMemoryRiskState = 'NORMAL' | 'WATCH' | 'ESCALATED' | 'LOCKED';

export interface RiskLedgerEntry {
  readonly riskType: string;
  readonly maxScore: number;
  readonly occurrences: number;
  readonly lastAction: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly evidenceHmacs: readonly string[];
}

export interface SecureMemorySnapshot {
  readonly hotWindow: string;
  readonly hasHistory: boolean;
  readonly turnCount: number;
  readonly stateVersion: number;
  readonly lastEventSequence: number;
  readonly riskLedger: readonly RiskLedgerEntry[];
  readonly riskState: SecureMemoryRiskState;
  readonly maxRiskLevel: RiskLevel;
  readonly cumulativeScore: number;
  readonly intentNodes: readonly SessionIntentNode[];
  readonly stateTransitions: readonly SessionStateTransition[];
}

export interface AppendSecureMemoryEvaluationInput {
  readonly scope: TenantScope;
  readonly sessionId: string;
  readonly expectedStateVersion: number;
  readonly request: GuardRequest;
  readonly decision: GuardDecision;
  readonly tokenizerId?: string;
  readonly tokenCount?: number;
  readonly riskAssessment?: SessionRiskAssessment;
}
