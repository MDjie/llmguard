export interface HardwareTelemetry {
  readonly cpuUtilization: number;
  readonly acceleratorUtilization: number;
  readonly memoryUtilization: number;
  readonly diskUtilization: number;
  readonly raidHealthy: boolean;
  readonly nicLinksUp: number;
  readonly nicLinksExpected: number;
  readonly maximumTemperatureCelsius: number;
  readonly powerSuppliesHealthy: number;
  readonly powerSuppliesExpected: number;
  readonly driverDigest: string;
  readonly firmwareDigest: string;
  readonly modelInstancesHealthy: number;
  readonly modelInstancesExpected: number;
  readonly inferenceQueueDepth: number;
}

export interface HardwareHealthDecision {
  readonly action: 'HEALTHY' | 'DEGRADE' | 'DRAIN';
  readonly reasonCodes: readonly string[];
}

export function evaluateHardwareHealth(telemetry: HardwareTelemetry): HardwareHealthDecision {
  const ratios = [
    telemetry.cpuUtilization, telemetry.acceleratorUtilization,
    telemetry.memoryUtilization, telemetry.diskUtilization,
  ];
  const counts = [
    telemetry.nicLinksUp, telemetry.nicLinksExpected,
    telemetry.powerSuppliesHealthy, telemetry.powerSuppliesExpected,
    telemetry.modelInstancesHealthy, telemetry.modelInstancesExpected,
    telemetry.inferenceQueueDepth,
  ];
  if (ratios.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
      counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      !Number.isFinite(telemetry.maximumTemperatureCelsius) ||
      !/^sha256:[a-f0-9]{64}$/u.test(telemetry.driverDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(telemetry.firmwareDigest)) {
    throw new Error('HARDWARE_TELEMETRY_INVALID');
  }
  const reasons = [
    ...(!telemetry.raidHealthy ? ['HARDWARE_RAID_UNHEALTHY'] : []),
    ...(telemetry.nicLinksUp < telemetry.nicLinksExpected ? ['HARDWARE_NIC_LINK_DOWN'] : []),
    ...(telemetry.powerSuppliesHealthy < telemetry.powerSuppliesExpected ? ['HARDWARE_POWER_DEGRADED'] : []),
    ...(telemetry.modelInstancesHealthy < telemetry.modelInstancesExpected ? ['HARDWARE_MODEL_INSTANCE_UNHEALTHY'] : []),
    ...(telemetry.maximumTemperatureCelsius >= 90 ? ['HARDWARE_TEMPERATURE_CRITICAL']
      : telemetry.maximumTemperatureCelsius >= 80 ? ['HARDWARE_TEMPERATURE_HIGH'] : []),
    ...(Math.max(...ratios) >= 0.98 ? ['HARDWARE_RESOURCE_EXHAUSTED']
      : Math.max(...ratios) >= 0.9 ? ['HARDWARE_RESOURCE_SATURATED'] : []),
    ...(telemetry.inferenceQueueDepth > 10_000 ? ['HARDWARE_INFERENCE_QUEUE_EXCEEDED'] : []),
  ];
  const drainReasons = new Set([
    'HARDWARE_RAID_UNHEALTHY', 'HARDWARE_NIC_LINK_DOWN', 'HARDWARE_TEMPERATURE_CRITICAL',
    'HARDWARE_RESOURCE_EXHAUSTED', 'HARDWARE_INFERENCE_QUEUE_EXCEEDED',
  ]);
  return {
    action: reasons.some((reason) => drainReasons.has(reason))
      ? 'DRAIN'
      : reasons.length > 0 ? 'DEGRADE' : 'HEALTHY',
    reasonCodes: reasons,
  };
}
