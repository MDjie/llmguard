import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(path, 'utf8');

describe('production deployment invariants', () => {
  it('keeps immutable images, hardened pods and availability controls mandatory', () => {
    const values = read('deploy/helm/guardllm/values.yaml');
    const workloads = read('deploy/helm/guardllm/templates/workloads.yaml');
    const availability = read('deploy/helm/guardllm/templates/availability.yaml');
    expect(values).toContain('digest: "sha256:');
    expect(workloads).toContain('runAsNonRoot: true');
    expect(workloads).toContain('readOnlyRootFilesystem: true');
    expect(workloads).toContain('capabilities: { drop: ["ALL"] }');
    expect(availability).toContain('kind: PodDisruptionBudget');
    expect(availability).toContain('kind: HorizontalPodAutoscaler');
  });

  it('prevents model bypass and enables strict workload mTLS', () => {
    const network = read('deploy/helm/guardllm/templates/network-policies.yaml');
    const mesh = read('deploy/helm/guardllm/templates/service-mesh.yaml');
    expect(network).toContain('name: guardllm-default-deny');
    expect(network).toContain('name: inference-only-from-gateway');
    expect(mesh).toContain('mode: STRICT');
    expect(mesh).toContain('name: model-only-from-gateway');
  });

  it('exposes the gRPC gateway only with an application-level mTLS identity', () => {
    const values = read('deploy/helm/guardllm/values.yaml');
    const workloads = read('deploy/helm/guardllm/templates/workloads.yaml');
    const network = read('deploy/helm/guardllm/templates/network-policies.yaml');
    const schema = JSON.parse(read('deploy/helm/guardllm/values.schema.json'));
    expect(values).toMatch(/gatewayGrpc:\s*[\s\S]*?enabled: true[\s\S]*?tlsRequired: true/);
    expect(workloads).toContain('name: GUARD_GRPC_MTLS_REQUIRED');
    expect(workloads).toContain('name: gateway-grpc-mtls');
    expect(workloads).toContain('appProtocol: grpc');
    expect(network).toContain('.Values.gatewayGrpc.port');
    expect(schema.required).toContain('gatewayGrpc');
    expect(schema.properties.gatewayGrpc.properties.enabled.const).toBe(true);
    expect(schema.properties.gatewayGrpc.properties.tlsRequired.const).toBe(true);
  });

  it('keeps distributed gateway quotas fail-closed in production values', () => {
    const values = read('deploy/helm/guardllm/values.yaml');
    expect(values).toContain('GUARD_REDIS_URI: rediss://');
    expect(values).toContain('GUARD_RATE_LIMIT_ENABLED: "true"');
    expect(values).toContain('GUARD_RATE_LIMIT_FAIL_CLOSED: "true"');
    expect(values).toContain('GUARD_MODEL_ROUTES_JSON:');
  });

  it('tracks exactly 15 POCs and 101 canonical requirements without claiming pass', () => {
    const pocs = JSON.parse(read('acceptance/poc-manifest.json'));
    const requirements = JSON.parse(read('acceptance/generated/requirements.json'));
    expect(pocs.pocs).toHaveLength(15);
    expect(requirements.requirementCount).toBe(101);
    expect(requirements.requirements).toHaveLength(101);
    expect(requirements.requirements.every((item) => item.acceptanceStatus === 'PENDING_SIGNED_EVIDENCE')).toBe(true);
  });

  it('provides independent app, worker, gateway and analyzer container targets', () => {
    expect(read('Dockerfile')).toContain('FROM builder AS worker');
    expect(read('services/guard-gateway/Dockerfile')).toContain('USER 10001');
    const analyzer = read('services/media-analyzer/Dockerfile');
    const values = read('deploy/helm/guardllm/values.yaml');
    expect(analyzer).toContain('tesseract-ocr');
    expect(analyzer).toContain('USER analyzer');
    expect(analyzer).toContain('/app/server.mjs');
    expect(values).toContain('args: ["/app/server.mjs"]');
    expect(values).not.toContain('args: ["/app/server.js"]');
    expect(read('deploy/helm/guardllm/templates/network-policies.yaml'))
      .toContain('name: analyzer-from-media-workers');
  });

  it('builds portable images and keeps accelerator scheduling environment-owned', () => {
    const workflow = read('.github/workflows/portability.yml');
    const workloads = read('deploy/helm/guardllm/templates/workloads.yaml');
    const ascend = read('deploy/helm/guardllm/values-ascend-example.yaml');
    expect(workflow).toContain('linux/amd64,linux/arm64');
    expect(workflow).toContain('services/guard-gateway/Dockerfile');
    expect(workflow).toContain('services/media-analyzer/Dockerfile');
    expect(workloads).toContain('runtimeClassName:');
    expect(workloads).toContain('nodeSelector:');
    expect(workloads).toContain('tolerations:');
    expect(workloads).toContain('affinity:');
    expect(ascend).toContain('huawei.com/Ascend910');
    expect(ascend).toContain('kubernetes.io/arch: arm64');
  });

  it('keeps local runtime commands cross-platform and standalone assets deployable', () => {
    const packageJson = JSON.parse(read('package.json'));
    const developmentLauncher = read('scripts/dev.mjs');
    const productionLauncher = read('scripts/start.mjs');

    expect(packageJson.scripts.dev).toBe('node ./scripts/dev.mjs');
    expect(packageJson.scripts.start).toBe('node ./scripts/start.mjs');
    expect(packageJson.scripts.preinstall).toBe('node ./scripts/enforce-pnpm.mjs');
    expect(packageJson.devDependencies).not.toHaveProperty('only-allow');
    expect(developmentLauncher).not.toContain('bash');
    expect(productionLauncher).toContain("loadEnvConfig(workspaceDirectory, false)");
    expect(productionLauncher).toContain("path.join(workspaceDirectory, '.next', 'static')");
    expect(productionLauncher).toContain("path.join(workspaceDirectory, 'public')");
  });
});
