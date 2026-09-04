import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type {
  ApplicationProtocol,
  EnforcementDecision,
  EnforcementReceipt,
  FlowAdmission,
  FlowEnvelope,
} from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';

export type FastPathAclAction = 'DENY' | 'DEEP_INSPECT' | 'ALLOW_METADATA_ONLY';

export interface FastPathAclRule {
  readonly ruleId: string;
  readonly priority: number;
  readonly action: FastPathAclAction;
  readonly tenantIds?: readonly string[];
  readonly applicationIds?: readonly string[];
  readonly sourceIps?: readonly string[];
  readonly destinationIps?: readonly string[];
  readonly destinationPorts?: readonly number[];
  readonly protocols?: readonly ApplicationProtocol[];
}

export interface FastPathPolicy {
  readonly policyBundleId: string;
  readonly ingressToEgress: Readonly<Record<string, string>>;
  readonly maximumActiveConnections: number;
  readonly maximumConnectionsPerSource: number;
  readonly admissionTtlMs: number;
  readonly reinjectionTtlMs: number;
  readonly aclRules: readonly FastPathAclRule[];
}

export interface ReinjectionAuthorization {
  readonly authorizationId: string;
  readonly flowId: string;
  readonly frameId: string;
  readonly decisionId: string;
  readonly egressInterface: string;
  readonly action: 'ALLOW' | 'RATE_LIMIT' | 'REDIRECT' | 'MASK' | 'REWRITE';
  readonly policyBundleId: string;
  readonly contentSha256: string;
  readonly expiresAtEpochMs: number;
  readonly authorizationDigest: string;
}

export interface FastPathSnapshot {
  readonly activeConnections: number;
  readonly sourceConnections: Readonly<Record<string, number>>;
  readonly states: Readonly<Record<string, string>>;
}

type FlowState = 'INSPECTING' | 'AUTHORIZED' | 'FORWARDING' | 'BLOCKED';

interface ConnectionEntry {
  readonly flow: FlowEnvelope;
  readonly admission: FlowAdmission;
  state: FlowState;
  decision?: EnforcementDecision;
}

const FORWARD_ACTIONS = new Set([
  'ALLOW', 'RATE_LIMIT', 'REDIRECT', 'MASK', 'REWRITE',
]);
const BLOCKING_ACTIONS = new Set(['BLOCK', 'RESET', 'QUARANTINE']);
const RAW_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function digest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validRule(rule: FastPathAclRule): boolean {
  return rule.ruleId.length > 0 && Number.isSafeInteger(rule.priority) &&
    (rule.destinationPorts?.every((port) =>
      Number.isSafeInteger(port) && port >= 0 && port <= 65_535) ?? true) &&
    (rule.tenantIds?.every((value) => value.length > 0) ?? true) &&
    (rule.applicationIds?.every((value) => value.length > 0) ?? true) &&
    (rule.sourceIps?.every((value) => value.length > 0) ?? true) &&
    (rule.destinationIps?.every((value) => value.length > 0) ?? true);
}

function ruleMatches(rule: FastPathAclRule, flow: FlowEnvelope): boolean {
  return (rule.tenantIds?.includes(flow.tenantId) ?? true) &&
    (rule.applicationIds?.includes(flow.applicationId) ?? true) &&
    (rule.sourceIps?.includes(flow.source.ip) ?? true) &&
    (rule.destinationIps?.includes(flow.destination.ip) ?? true) &&
    (rule.destinationPorts?.includes(flow.destination.port) ?? true) &&
    (rule.protocols?.includes(flow.applicationProtocol) ?? true);
}

/**
 * Control-plane conformance model for a selected kernel/OEM fast path. It does
 * not perform packet I/O and cannot be used as target-NIC performance evidence.
 */
export class FastPathReferenceModel {
  private readonly connections = new Map<string, ConnectionEntry>();
  private readonly sourceConnections = new Map<string, number>();
  private readonly rules: readonly FastPathAclRule[];
  private readonly now: () => number;

  constructor(
    private readonly policy: FastPathPolicy,
    private readonly verifyEnforcementToken: (decision: EnforcementDecision) => boolean,
    options: { readonly now?: () => number } = {},
  ) {
    const ruleIds = policy.aclRules.map((rule) => rule.ruleId);
    const rulePriorities = policy.aclRules.map((rule) => rule.priority);
    if (policy.policyBundleId.length === 0 ||
        Object.keys(policy.ingressToEgress).length === 0 ||
        Object.entries(policy.ingressToEgress).some(([ingress, egress]) =>
          ingress.length === 0 || egress.length === 0 || ingress === egress) ||
        !Number.isSafeInteger(policy.maximumActiveConnections) ||
        policy.maximumActiveConnections < 1 ||
        !Number.isSafeInteger(policy.maximumConnectionsPerSource) ||
        policy.maximumConnectionsPerSource < 1 ||
        !Number.isSafeInteger(policy.admissionTtlMs) || policy.admissionTtlMs < 1 ||
        !Number.isSafeInteger(policy.reinjectionTtlMs) || policy.reinjectionTtlMs < 1 ||
        new Set(ruleIds).size !== ruleIds.length ||
        new Set(rulePriorities).size !== rulePriorities.length ||
        policy.aclRules.some((rule) => !validRule(rule))) {
      throw new Error('FAST_PATH_POLICY_INVALID');
    }
    this.rules = [...policy.aclRules].sort((left, right) => left.priority - right.priority);
    this.now = options.now ?? Date.now;
  }

  admitFlow(flow: FlowEnvelope): FlowAdmission {
    const existing = this.connections.get(flow.flowId);
    if (existing) {
      if (digest(existing.flow) !== digest(flow)) throw new Error('FAST_PATH_FLOW_ID_CONFLICT');
      return existing.admission;
    }
    const at = this.now();
    const egress = this.policy.ingressToEgress[flow.ingressInterface];
    if (flow.contractVersion !== '1.0' || flow.flowId.length < 8 ||
        flow.policyBundleId !== this.policy.policyBundleId || egress !== flow.egressInterface ||
        flow.absoluteDeadlineEpochMs <= at) {
      return this.admission(flow, 'BLOCK', 'FAST_PATH_FLOW_BINDING_INVALID', at);
    }
    if (flow.deploymentMode === 'TAP_MIRROR') {
      return this.admission(
        flow,
        flow.protectedTraffic ? 'BLOCK' : 'MIRROR_ONLY',
        flow.protectedTraffic ? 'FAST_PATH_TAP_CANNOT_ENFORCE' : 'FAST_PATH_MIRROR_ONLY',
        at,
      );
    }
    if (this.connections.size >= this.policy.maximumActiveConnections ||
        (this.sourceConnections.get(flow.source.ip) ?? 0) >=
          this.policy.maximumConnectionsPerSource) {
      return this.admission(flow, 'BLOCK', 'FAST_PATH_CONNECTION_LIMIT_EXCEEDED', at);
    }
    const rule = this.rules.find((candidate) => ruleMatches(candidate, flow));
    const action = rule?.action ?? 'DEEP_INSPECT';
    if (action === 'DENY') {
      return this.admission(flow, 'BLOCK', 'FAST_PATH_ACL_DENY:' + rule?.ruleId, at);
    }
    if (action === 'ALLOW_METADATA_ONLY' && !flow.protectedTraffic) {
      const admission = this.admission(flow, 'ALLOW_METADATA_ONLY',
        'FAST_PATH_ACL_METADATA_ALLOW:' + rule?.ruleId, at);
      this.trackConnection(flow, admission, 'FORWARDING');
      return admission;
    }
    const admission = this.admission(flow, 'INSPECT',
      'FAST_PATH_DEEP_INSPECTION_REQUIRED' + (rule ? ':' + rule.ruleId : ''), at);
    this.trackConnection(flow, admission, 'INSPECTING');
    return admission;
  }

  applyDecision(decision: EnforcementDecision): void {
    const entry = this.connections.get(decision.flowId);
    if (!entry || entry.state !== 'INSPECTING' ||
        decision.contractVersion !== '1.0' ||
        decision.flowSeq !== entry.flow.flowSeq ||
        decision.policyBundleId !== entry.flow.policyBundleId ||
        decision.frameId.length < 8 || !Number.isSafeInteger(decision.frameSeq) ||
        decision.frameSeq < 0 || !RAW_SHA256_PATTERN.test(decision.contentSha256) ||
        decision.issuedAtEpochMs > this.now() || decision.expiresAtEpochMs <= this.now() ||
        (entry.flow.protectedTraffic && decision.action === 'ALLOW' &&
          !decision.evidenceComplete) ||
        (BLOCKING_ACTIONS.has(decision.action) && !decision.terminal) ||
        (['MASK', 'REWRITE'].includes(decision.action) &&
          decision.transformedPayloadBase64 === undefined) ||
        decision.action === 'MIRROR_ONLY' ||
        !this.verifyEnforcementToken(decision)) {
      throw new Error('FAST_PATH_DECISION_INVALID');
    }
    entry.decision = decision;
    entry.state = FORWARD_ACTIONS.has(decision.action) ? 'AUTHORIZED' : 'BLOCKED';
  }

  beginFrameInspection(flowId: string): void {
    const entry = this.connections.get(flowId);
    if (!entry || entry.state !== 'FORWARDING') {
      throw new Error('FAST_PATH_FRAME_INSPECTION_INVALID');
    }
    entry.decision = undefined;
    entry.state = 'INSPECTING';
  }

  authorizeReinjection(flowId: string): ReinjectionAuthorization {
    const entry = this.connections.get(flowId);
    const decision = entry?.decision;
    if (!entry || entry.state !== 'AUTHORIZED' || !decision ||
        !FORWARD_ACTIONS.has(decision.action)) {
      throw new Error('FAST_PATH_REINJECTION_NOT_AUTHORIZED');
    }
    const expiresAtEpochMs = Math.min(
      decision.expiresAtEpochMs,
      this.now() + this.policy.reinjectionTtlMs,
    );
    const body = {
      authorizationId: 'rja_' + digest({
        flowId, decisionId: decision.decisionId, expiresAtEpochMs,
      }).slice(7, 39),
      flowId,
      frameId: decision.frameId,
      decisionId: decision.decisionId,
      egressInterface: entry.flow.egressInterface,
      action: decision.action as ReinjectionAuthorization['action'],
      policyBundleId: decision.policyBundleId,
      contentSha256: decision.contentSha256,
      expiresAtEpochMs,
    };
    return { ...body, authorizationDigest: digest(body) };
  }

  recordEnforcement(receipt: EnforcementReceipt): void {
    const entry = this.connections.get(receipt.flowId);
    const decision = entry?.decision;
    if (!entry || !decision || receipt.decisionId !== decision.decisionId ||
        receipt.deviceId !== entry.flow.deviceId || receipt.frameId !== decision.frameId ||
        receipt.action !== decision.action || receipt.status !== 'APPLIED' ||
        receipt.bytesForwardedBeforeDecision !== 0) {
      if (entry) entry.state = 'BLOCKED';
      throw new Error('FAST_PATH_ENFORCEMENT_RECEIPT_INVALID');
    }
    entry.state = FORWARD_ACTIONS.has(decision.action) ? 'FORWARDING' : 'BLOCKED';
  }

  closeFlow(flowId: string): void {
    const entry = this.connections.get(flowId);
    if (!entry) return;
    this.connections.delete(flowId);
    const remaining = (this.sourceConnections.get(entry.flow.source.ip) ?? 1) - 1;
    if (remaining <= 0) this.sourceConnections.delete(entry.flow.source.ip);
    else this.sourceConnections.set(entry.flow.source.ip, remaining);
  }

  snapshot(): FastPathSnapshot {
    return {
      activeConnections: this.connections.size,
      sourceConnections: Object.fromEntries(
        [...this.sourceConnections.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      states: Object.fromEntries(
        [...this.connections.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([flowId, entry]) => [flowId, entry.state]),
      ),
    };
  }

  private trackConnection(
    flow: FlowEnvelope,
    admission: FlowAdmission,
    state: FlowState,
  ): void {
    this.connections.set(flow.flowId, { flow, admission, state });
    this.sourceConnections.set(
      flow.source.ip,
      (this.sourceConnections.get(flow.source.ip) ?? 0) + 1,
    );
  }

  private admission(
    flow: FlowEnvelope,
    action: FlowAdmission['action'],
    reasonCode: string,
    at: number,
  ): FlowAdmission {
    return {
      flowId: flow.flowId,
      flowSeq: flow.flowSeq,
      action,
      reasonCode,
      policyBundleId: this.policy.policyBundleId,
      expiresAtEpochMs: Math.min(flow.absoluteDeadlineEpochMs, at + this.policy.admissionTtlMs),
    };
  }
}
