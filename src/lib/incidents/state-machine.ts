export const INCIDENT_STATUSES = [
  'PENDING_REVIEW',
  'IN_PROGRESS',
  'FALSE_POSITIVE',
  'BLOCKED',
  'REMEDIATED',
  'CLOSED',
] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

const ALLOWED_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  PENDING_REVIEW: ['IN_PROGRESS', 'FALSE_POSITIVE', 'BLOCKED'],
  IN_PROGRESS: ['FALSE_POSITIVE', 'BLOCKED', 'REMEDIATED', 'CLOSED'],
  FALSE_POSITIVE: ['IN_PROGRESS', 'CLOSED'],
  BLOCKED: ['IN_PROGRESS', 'REMEDIATED', 'CLOSED'],
  REMEDIATED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

export class IncidentTransitionError extends Error {
  constructor(readonly code: 'INCIDENT_TRANSITION_INVALID' | 'INCIDENT_ASSIGNEE_REQUIRED' | 'INCIDENT_CLOSURE_NOTE_REQUIRED', message: string) {
    super(message);
    this.name = 'IncidentTransitionError';
  }
}

export function assertIncidentTransition(input: {
  readonly from: IncidentStatus;
  readonly to: IncidentStatus;
  readonly assigneeId?: string | null;
  readonly note?: string;
}): void {
  if (!ALLOWED_TRANSITIONS[input.from].includes(input.to)) {
    throw new IncidentTransitionError('INCIDENT_TRANSITION_INVALID', `Transition ${input.from} -> ${input.to} is not allowed`);
  }
  if (input.to === 'IN_PROGRESS' && !input.assigneeId?.trim()) {
    throw new IncidentTransitionError('INCIDENT_ASSIGNEE_REQUIRED', 'An assignee is required when work starts');
  }
  if ((input.to === 'FALSE_POSITIVE' || input.to === 'REMEDIATED' || input.to === 'CLOSED') && !input.note?.trim()) {
    throw new IncidentTransitionError('INCIDENT_CLOSURE_NOTE_REQUIRED', 'A disposition note is required');
  }
}

export function incidentSlaBreached(status: IncidentStatus, slaDueAt: Date, now = new Date()): boolean {
  return status !== 'CLOSED' && slaDueAt.getTime() < now.getTime();
}
