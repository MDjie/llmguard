import { describe, expect, it } from 'vitest';
import {
  evaluateHardwareHealth,
  signNetworkBypassPermit,
  transitionNetworkFlow,
  type ApplianceProtocol,
} from '../../src/lib/appliance';

const protocols: readonly ApplianceProtocol[] = [
  'HTTP_1_1', 'HTTP_2', 'HTTPS', 'SSE', 'WEBSOCKET', 'GRPC', 'OPENAI_API', 'MQTT', 'MCP',
];

describe('appliance PAL and HAL', () => {
  it('requires decoding and inspection before forwarding every governed protocol', () => {
    for (const protocol of protocols) {
      const context = {
        tenantId: 'tenant-1', applicationId: 'app-1', protocol,
        protectedTraffic: true, nowEpochMs: 1_000,
      };
      expect(transitionNetworkFlow('NEW', 'INSPECTION_ALLOW', context, () => undefined))
        .toMatchObject({ state: 'BLOCKED', reasonCode: 'NETWORK_PROTOCOL_TRANSITION_INVALID' });
      const decoding = transitionNetworkFlow('NEW', 'START_CLEAR_TEXT', context, () => undefined);
      const inspecting = transitionNetworkFlow(decoding.state, 'FRAME_COMPLETE', context, () => undefined);
      expect(transitionNetworkFlow(inspecting.state, 'INSPECTION_ALLOW', context, () => undefined).state)
        .toBe('FORWARDING');
    }
  });

  it('fails protected traffic closed and permits only signed scoped bypasses for unprotected traffic', () => {
    const permit = signNetworkBypassPermit({
      version: 1, permitId: 'permit-1', tenantId: 'tenant-1', applicationId: 'app-1',
      protocols: ['HTTP_1_1'], reason: 'approved maintenance window',
      approverIds: ['network-owner', 'security-owner'], issuedAtEpochMs: 900, expiresAtEpochMs: 1_100,
    }, 'key-1', 'network-bypass-secret');
    const base = {
      tenantId: 'tenant-1', applicationId: 'app-1', protocol: 'HTTP_1_1' as const,
      nowEpochMs: 1_000, bypassPermit: permit,
    };
    expect(transitionNetworkFlow('INSPECTING', 'INSPECTION_FAILURE', {
      ...base, protectedTraffic: true,
    }, () => 'network-bypass-secret').state).toBe('BLOCKED');
    expect(transitionNetworkFlow('INSPECTING', 'INSPECTION_FAILURE', {
      ...base, protectedTraffic: false,
    }, () => 'network-bypass-secret').state).toBe('BYPASSED');
    expect(transitionNetworkFlow('INSPECTING', 'INSPECTION_FAILURE', {
      ...base, tenantId: 'other', protectedTraffic: false,
    }, () => 'network-bypass-secret').state).toBe('BLOCKED');
  });

  it('drains unhealthy hardware without claiming target compatibility', () => {
    expect(evaluateHardwareHealth({
      cpuUtilization: 0.99, acceleratorUtilization: 0.5, memoryUtilization: 0.7,
      diskUtilization: 0.8, raidHealthy: true, nicLinksUp: 2, nicLinksExpected: 2,
      maximumTemperatureCelsius: 70, powerSuppliesHealthy: 2, powerSuppliesExpected: 2,
      driverDigest: `sha256:${'a'.repeat(64)}`, firmwareDigest: `sha256:${'b'.repeat(64)}`,
      modelInstancesHealthy: 2, modelInstancesExpected: 2, inferenceQueueDepth: 20,
    })).toMatchObject({ action: 'DRAIN', reasonCodes: ['HARDWARE_RESOURCE_EXHAUSTED'] });
  });
});
