import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findCompatibilityViolations } from '../../packages/contracts/scripts/check-compatibility.mjs';

const sourceText = readFileSync('packages/contracts/model/guard-v1.schema.json', 'utf8');
const source = JSON.parse(sourceText);
const baseline = JSON.parse(
  readFileSync('packages/contracts/baseline/guard-v1.compatibility.json', 'utf8'),
);
const manifest = JSON.parse(readFileSync('packages/contracts/generated/manifest.json', 'utf8'));
const proto = readFileSync('packages/contracts/proto/guard/v1/guard.proto', 'utf8');

describe('TASK-R1-001 Guard v1 contract source', () => {
  it('is strict for every object definition and keeps one terminal action', () => {
    for (const definition of Object.values(source.$defs)) {
      if (definition.type === 'object') expect(definition.additionalProperties).toBe(false);
    }
    const decisionProperties = source.$defs.GuardDecision.properties;
    expect(decisionProperties.action).toBeDefined();
    expect(decisionProperties.processingAction).toBeUndefined();
    expect(decisionProperties.effectiveAction).toBeUndefined();
  });

  it('binds generated outputs to the canonical source hash', () => {
    const hash = createHash('sha256').update(sourceText).digest('hex');
    expect(manifest.contractVersion).toBe('1.0');
    expect(manifest.sourceSha256).toBe(hash);
    expect(Object.keys(manifest.outputs)).toHaveLength(7);
    expect(manifest.outputs['generated/go/guardv1/contracts.go']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('ACC-001 exposes unary and bidirectional streaming gRPC from the canonical source', () => {
    expect(source['x-grpc-services'].GuardService.Evaluate).toEqual({
      request: 'GuardRequest', response: 'GuardDecision', requestStream: false, responseStream: false,
    });
    expect(proto).toMatch(/service GuardService/);
    expect(proto).toMatch(/rpc Evaluate\(GuardRequest\) returns \(GuardDecision\)/);
    expect(proto).toMatch(/rpc EvaluateStream\(stream GuardRequest\) returns \(stream GuardDecision\)/);
  });

  it('accepts the committed v1 baseline', () => {
    expect(findCompatibilityViolations(source, baseline)).toEqual([]);
  });

  it('defines source-bound context, action intent and auditable risk evidence', () => {
    const contextEnvelope = source.$defs.ContextEnvelope;
    expect(contextEnvelope.required).toEqual(expect.arrayContaining([
      'tenantId',
      'applicationId',
      'sourceType',
      'trustLevel',
      'instructionCapability',
      'contentHash',
      'policyVersion',
      'eventSeq',
    ]));
    expect(source.$defs.GuardContent.properties.envelopes.items.$ref)
      .toBe('#/$defs/ContextEnvelope');
    expect(source.$defs.GuardRequest.properties.actionIntent.$ref)
      .toBe('#/$defs/ActionIntent');
    expect(source.$defs.EvidenceRef.properties.sourceEnvelopeIds).toBeDefined();
    expect(source.$defs.EvidenceRef.properties.tokenStart).toBeDefined();
    expect(source.$defs.Observation.properties.modelVersion).toBeDefined();
    expect(source.$defs.Observation.properties.failMode.$ref).toBe('#/$defs/GuardFailMode');
  });

  it('blocks removed fields and newly required fields', () => {
    const removed = structuredClone(source);
    delete removed.$defs.GuardDecision.properties.action;
    expect(findCompatibilityViolations(removed, baseline)).toContain(
      'removed property GuardDecision.action',
    );

    const required = structuredClone(source);
    required.$defs.GuardError.required.push('details');
    expect(findCompatibilityViolations(required, baseline)).toContain(
      'added required property GuardError.details',
    );

    const removedRpc = structuredClone(source);
    delete removedRpc['x-grpc-services'].GuardService.Evaluate;
    expect(findCompatibilityViolations(removedRpc, baseline)).toContain(
      'removed service method GuardService.Evaluate',
    );

    const narrowedPayload = structuredClone(source);
    narrowedPayload.$defs.GuardEvent.properties.payload.oneOf.pop();
    expect(findCompatibilityViolations(narrowedPayload, baseline)).toEqual([]);

    narrowedPayload.$defs.GuardEvent.properties.payload.oneOf.shift();
    expect(findCompatibilityViolations(narrowedPayload, baseline)).toContain(
      'changed property schema GuardEvent.payload',
    );
  });
});
