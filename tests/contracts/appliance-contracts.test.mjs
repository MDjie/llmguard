import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findApplianceCompatibilityViolations } from
  '../../packages/contracts-appliance/scripts/check-compatibility.mjs';

const sourceText = readFileSync(
  'packages/contracts-appliance/model/appliance-v1.schema.json',
  'utf8',
);
const source = JSON.parse(sourceText);
const baseline = JSON.parse(readFileSync(
  'packages/contracts-appliance/baseline/appliance-v1.compatibility.json',
  'utf8',
));
const manifest = JSON.parse(readFileSync(
  'packages/contracts-appliance/generated/manifest.json',
  'utf8',
));
const proto = readFileSync(
  'packages/contracts-appliance/proto/appliance/v1/appliance.proto',
  'utf8',
);

describe('B-WP02 appliance v1 contracts', () => {
  it('keeps every object strict and binds generated outputs to the canonical source', () => {
    for (const definition of Object.values(source.$defs)) {
      if (definition.type === 'object') expect(definition.additionalProperties).toBe(false);
    }
    const hash = createHash('sha256').update(sourceText).digest('hex');
    expect(manifest.contractVersion).toBe('1.0');
    expect(manifest.sourceSha256).toBe(hash);
    expect(Object.keys(manifest.outputs)).toHaveLength(5);
    expect(manifest.outputs['generated/go/appliancev1/contracts.go'])
      .toMatch(/^[a-f0-9]{64}$/u);
  });

  it('defines flow, frame, decision, receipt, capability, health and bypass bindings', () => {
    expect(source.$defs.FlowEnvelope.required).toEqual(expect.arrayContaining([
      'deviceId',
      'deviceGroupId',
      'flowId',
      'flowSeq',
      'tenantId',
      'applicationId',
      'protectedTraffic',
      'absoluteDeadlineEpochMs',
      'policyBundleId',
    ]));
    expect(source.$defs.FrameEnvelope.oneOf).toEqual([
      { required: ['inlinePayloadBase64'] },
      { required: ['contentReference'] },
    ]);
    expect(source.$defs.EnforcementDecision.required).toEqual(expect.arrayContaining([
      'contentSha256',
      'evidenceComplete',
      'enforcementToken',
    ]));
    expect(source.$defs.EnforcementReceipt.required).toContain('bytesForwardedBeforeDecision');
    expect(source.$defs.SignedNetworkBypassPermitV2.properties.algorithm.const).toBe('Ed25519');
    expect(source.$defs.CapabilityManifest.properties.hardware.$ref)
      .toBe('#/$defs/HardwareCapability');
  });

  it('exposes streaming inspection and device-control gRPC services', () => {
    expect(source['x-grpc-services'].ApplianceInspectionService.InspectFrame).toEqual({
      request: 'FrameEnvelope',
      response: 'EnforcementDecision',
      requestStream: true,
      responseStream: true,
    });
    expect(proto).toMatch(/service ApplianceInspectionService/u);
    expect(proto).toMatch(
      /rpc InspectFrame\(stream FrameEnvelope\) returns \(stream EnforcementDecision\)/u,
    );
    expect(proto).toMatch(/service ApplianceControlService/u);
    expect(proto).toMatch(/rpc AckBundle\(BundleActivationReceipt\) returns \(BundleAck\)/u);
  });

  it('accepts the committed appliance v1 compatibility baseline', () => {
    expect(findApplianceCompatibilityViolations(source, baseline)).toEqual([]);
  });

  it('detects removed fields, new required fields and changed RPC methods', () => {
    const removed = structuredClone(source);
    delete removed.$defs.EnforcementDecision.properties.enforcementToken;
    expect(findApplianceCompatibilityViolations(removed, baseline)).toContain(
      'removed property EnforcementDecision.enforcementToken',
    );

    const newlyRequired = structuredClone(source);
    newlyRequired.$defs.FlowEnvelope.required.push('sessionId');
    expect(findApplianceCompatibilityViolations(newlyRequired, baseline)).toContain(
      'added required property FlowEnvelope.sessionId',
    );

    const removedRpc = structuredClone(source);
    delete removedRpc['x-grpc-services'].ApplianceInspectionService.RecordEnforcement;
    expect(findApplianceCompatibilityViolations(removedRpc, baseline)).toContain(
      'removed service method ApplianceInspectionService.RecordEnforcement',
    );
  });
});
