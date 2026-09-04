import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type {
  EnforcementDecision,
  EnforcementReceipt,
  FlowAdmission,
  FlowEnvelope,
  FrameEnvelope,
} from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';
import { EvidenceWal, type EvidenceWalStatus } from './evidence-wal';
import {
  FastPathReferenceModel,
  type FastPathSnapshot,
  type ReinjectionAuthorization,
} from './fast-path-reference';
import { InspectionFabric } from './inspection-fabric';
import { PalV2FlowController, type PalV2FlowState } from './pal-v2';

const FORWARD_ACTIONS = new Set([
  'ALLOW', 'RATE_LIMIT', 'REDIRECT', 'MASK', 'REWRITE',
]);

interface VirtualFlowRuntime {
  readonly flow: FlowEnvelope;
  readonly admission: FlowAdmission;
  readonly pal?: PalV2FlowController;
  completedFrames: number;
}

export interface VirtualLabOpenResult {
  readonly admission: FlowAdmission;
  readonly evidenceSequence: number;
  readonly palState?: PalV2FlowState;
}

export interface VirtualLabFrameResult {
  readonly decision: EnforcementDecision;
  readonly receipt: EnforcementReceipt;
  readonly reinjection?: ReinjectionAuthorization;
  readonly releasedPayloadBase64?: string;
  readonly bytesReleasedAfterDecision: number;
  readonly evidenceSequences: readonly [number, number];
  readonly palState: PalV2FlowState;
}

export interface VirtualLabSnapshot {
  readonly activeFlowIds: readonly string[];
  readonly fastPath: FastPathSnapshot;
  readonly evidence: EvidenceWalStatus;
}

export interface VirtualApplianceLabOptions {
  readonly verifyEnforcementToken: (decision: EnforcementDecision) => boolean;
  readonly now?: () => number;
  readonly maximumInlineFrameBytes?: number;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function failureReason(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_:.-]{1,160}$/u.test(error.message)) {
    return error.message;
  }
  return 'VIRTUAL_LAB_PIPELINE_FAILED';
}

/**
 * Deterministic software data-plane harness. It composes the conformance
 * FastPath, PAL v2, Inspection Fabric and evidence WAL, but performs no packet
 * I/O and must not be used as target-NIC or production-throughput evidence.
 */
export class VirtualApplianceLab {
  private readonly flows = new Map<string, VirtualFlowRuntime>();
  private readonly now: () => number;

  constructor(
    private readonly fastPath: FastPathReferenceModel,
    private readonly inspectionFabric: InspectionFabric,
    private readonly evidenceWal: EvidenceWal,
    private readonly options: VirtualApplianceLabOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  openFlow(flow: FlowEnvelope): VirtualLabOpenResult {
    const existing = this.flows.get(flow.flowId);
    if (!existing) this.requireEvidenceCapacity(1);
    const admission = this.fastPath.admitFlow(flow);
    if (existing) {
      return {
        admission: existing.admission,
        evidenceSequence: this.evidenceWal.status().lastSequence,
        ...(existing.pal ? { palState: existing.pal.state } : {}),
      };
    }
    let pal: PalV2FlowController | undefined;
    try {
      if (admission.action === 'INSPECT') {
        pal = new PalV2FlowController(flow, {
          now: this.now,
          verifyEnforcementToken: this.options.verifyEnforcementToken,
          ...(this.options.maximumInlineFrameBytes !== undefined
            ? { maximumInlineFrameBytes: this.options.maximumInlineFrameBytes }
            : {}),
        });
        const palAdmission = pal.open();
        if (palAdmission.action !== 'INSPECT' ||
            palAdmission.policyBundleId !== admission.policyBundleId) {
          throw new Error('VIRTUAL_LAB_ADMISSION_MISMATCH');
        }
      }
      const evidence = this.evidenceWal.append({
        domain: 'NETWORK_SECURITY',
        eventType: 'FLOW_ADMISSION',
        occurredAtEpochMs: this.now(),
        policyBundleId: flow.policyBundleId,
        flowId: flow.flowId,
        payload: {
          action: admission.action,
          reasonCode: admission.reasonCode,
          deploymentMode: flow.deploymentMode,
          protectedTraffic: flow.protectedTraffic,
          ingressInterface: flow.ingressInterface,
          egressInterface: flow.egressInterface,
        },
      });
      if (admission.action === 'INSPECT' || admission.action === 'ALLOW_METADATA_ONLY') {
        this.flows.set(flow.flowId, {
          flow,
          admission,
          ...(pal ? { pal } : {}),
          completedFrames: 0,
        });
      }
      return {
        admission,
        evidenceSequence: evidence.body.sequence,
        ...(pal ? { palState: pal.state } : {}),
      };
    } catch (error) {
      pal?.close();
      this.fastPath.closeFlow(flow.flowId);
      throw error;
    }
  }

  markTlsEstablished(flowId: string): void {
    const runtime = this.requiredInspectedFlow(flowId);
    runtime.pal.markTlsEstablished();
  }

  async inspectFrame(flowId: string, frame: FrameEnvelope): Promise<VirtualLabFrameResult> {
    const runtime = this.requiredInspectedFlow(flowId);
    try {
      this.requireEvidenceCapacity(2);
      if (runtime.completedFrames > 0) this.fastPath.beginFrameInspection(flowId);
      runtime.pal.submitFrame(frame);
      const decision = await this.inspectionFabric.inspect(runtime.flow, frame);
      runtime.pal.applyDecision(decision);
      this.fastPath.applyDecision(decision);
      const reinjection = FORWARD_ACTIONS.has(decision.action)
        ? this.fastPath.authorizeReinjection(flowId)
        : undefined;
      const decisionEvidence = this.evidenceWal.append({
        domain: 'NETWORK_SECURITY',
        eventType: 'ENFORCEMENT_DECISION',
        occurredAtEpochMs: this.now(),
        policyBundleId: decision.policyBundleId,
        decisionId: decision.decisionId,
        flowId,
        payload: {
          frameId: decision.frameId,
          frameSeq: decision.frameSeq,
          contentSha256: decision.contentSha256,
          action: decision.action,
          reasonCode: decision.reasonCode,
          evidenceComplete: decision.evidenceComplete,
          observationDigests: decision.observations.map((item) => item.evidenceDigest),
        },
      });
      const receipt = this.createReceipt(runtime.flow, decision);
      runtime.pal.recordEnforcement(receipt);
      this.fastPath.recordEnforcement(receipt);
      const receiptEvidence = this.evidenceWal.append({
        domain: 'NETWORK_SECURITY',
        eventType: 'ENFORCEMENT_RECEIPT',
        occurredAtEpochMs: receipt.executedAtEpochMs,
        policyBundleId: decision.policyBundleId,
        decisionId: decision.decisionId,
        flowId,
        payload: {
          receiptId: receipt.receiptId,
          action: receipt.action,
          status: receipt.status,
          bytesForwardedBeforeDecision: receipt.bytesForwardedBeforeDecision,
          receiptDigest: receipt.receiptDigest,
        },
      });
      const releasedPayloadBase64 = reinjection
        ? this.releasedPayload(frame, decision)
        : undefined;
      const bytesReleasedAfterDecision = reinjection
        ? releasedPayloadBase64 === undefined
          ? frame.sizeBytes
          : Buffer.from(releasedPayloadBase64, 'base64').length
        : 0;
      if (decision.terminal) {
        this.fastPath.closeFlow(flowId);
        this.flows.delete(flowId);
      } else {
        runtime.completedFrames += 1;
      }
      return {
        decision,
        receipt,
        ...(reinjection ? { reinjection } : {}),
        ...(releasedPayloadBase64 !== undefined ? { releasedPayloadBase64 } : {}),
        bytesReleasedAfterDecision,
        evidenceSequences: [
          decisionEvidence.body.sequence,
          receiptEvidence.body.sequence,
        ],
        palState: runtime.pal.state,
      };
    } catch (error) {
      this.failClosed(runtime, failureReason(error));
      throw error;
    }
  }

  closeFlow(flowId: string): void {
    const runtime = this.flows.get(flowId);
    runtime?.pal?.close();
    this.fastPath.closeFlow(flowId);
    this.flows.delete(flowId);
  }

  snapshot(): VirtualLabSnapshot {
    return {
      activeFlowIds: [...this.flows.keys()].sort(),
      fastPath: this.fastPath.snapshot(),
      evidence: this.evidenceWal.status(),
    };
  }

  private requiredInspectedFlow(flowId: string): VirtualFlowRuntime & {
    readonly pal: PalV2FlowController;
  } {
    const runtime = this.flows.get(flowId);
    if (!runtime?.pal || runtime.admission.action !== 'INSPECT') {
      throw new Error('VIRTUAL_LAB_FLOW_NOT_INSPECTABLE');
    }
    return runtime as VirtualFlowRuntime & { readonly pal: PalV2FlowController };
  }

  private requireEvidenceCapacity(requiredRecords: number): void {
    const status = this.evidenceWal.status();
    if (status.maximumRecords - status.retainedRecords < requiredRecords) {
      throw new Error('VIRTUAL_LAB_EVIDENCE_CAPACITY_EXHAUSTED');
    }
  }

  private createReceipt(
    flow: FlowEnvelope,
    decision: EnforcementDecision,
  ): EnforcementReceipt {
    const executedAtEpochMs = this.now();
    const body = {
      receiptId: 'rcp_' + sha256({
        decisionId: decision.decisionId,
        frameId: decision.frameId,
        executedAtEpochMs,
      }).slice(0, 32),
      decisionId: decision.decisionId,
      deviceId: flow.deviceId,
      flowId: flow.flowId,
      frameId: decision.frameId,
      action: decision.action,
      status: 'APPLIED' as const,
      executedAtEpochMs,
      bytesForwardedBeforeDecision: 0,
    };
    return { ...body, receiptDigest: sha256(body) };
  }

  private releasedPayload(
    frame: FrameEnvelope,
    decision: EnforcementDecision,
  ): string | undefined {
    if (decision.action === 'MASK' || decision.action === 'REWRITE') {
      return decision.transformedPayloadBase64;
    }
    return frame.inlinePayloadBase64;
  }

  private failClosed(runtime: VirtualFlowRuntime, reasonCode: string): void {
    runtime.pal?.close();
    this.fastPath.closeFlow(runtime.flow.flowId);
    this.flows.delete(runtime.flow.flowId);
    if (this.evidenceWal.canAppend()) {
      this.evidenceWal.append({
        domain: 'NETWORK_SECURITY',
        eventType: 'PIPELINE_FAIL_CLOSED',
        occurredAtEpochMs: this.now(),
        policyBundleId: runtime.flow.policyBundleId,
        flowId: runtime.flow.flowId,
        payload: { reasonCode },
      });
    }
  }
}
