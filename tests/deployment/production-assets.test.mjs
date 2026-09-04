import { existsSync, readFileSync } from 'node:fs';
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
    expect(read('Dockerfile')).toContain('AS worker');
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

  it('keeps local Compose complete, loopback-only, and explicit about HTTP/TLS exceptions', () => {
    const compose = read('docker-compose.yml');
    const rootDockerfile = read('Dockerfile');
    const values = read('deploy/helm/guardllm/values.yaml');
    const analyzerDockerfile = read('services/media-analyzer/Dockerfile');
    const applianceDockerfile = read('services/appliance-agent/Dockerfile');
    const workers = [
      'evaluation-worker',
      'security-scan-worker',
      'artifact-worker',
      'multimodal-worker',
      'media-worker',
      'content-marking-worker',
      'rag-worker',
      'callback-worker',
      'audit-export-worker',
      'audit-timestamp-worker',
    ];

    expect(compose).toContain('127.0.0.1:${APP_PORT:-58082}:5000');
    expect(compose).toContain('SESSION_COOKIE_SECURE: "${SESSION_COOKIE_SECURE:-false}"');
    expect(compose).toContain('DATABASE_PLAINTEXT_ALLOWED_HOSTS: "${DATABASE_PLAINTEXT_ALLOWED_HOSTS:-postgres}"');
    expect(compose).toContain('GUARDLLM_ENABLE_EXPERIMENTAL_LABS: "${GUARDLLM_ENABLE_EXPERIMENTAL_LABS:-false}"');
    expect(compose).toContain('scripts/run-worker.mjs');
    expect(rootDockerfile).toContain('scripts/run-worker.mjs');
    expect(values).not.toContain('command: ["pnpm"]');
    expect(values).toContain('args: ["--import", "tsx", "scripts/run-worker.mjs", "evaluation"]');
    expect(compose).toContain('./drizzle/0035_guard_quota_ledger.sql');
    expect(compose).toContain('./drizzle/0037_targeted_whitelist_rules.sql');
    expect(compose).toContain('./drizzle/0038_policy_governance.sql');
    expect(compose).toContain('media-analyzer:');
    for (const worker of workers) expect(compose).toContain(`  ${worker}:`);
    for (const dockerfile of [rootDockerfile, analyzerDockerfile, applianceDockerfile]) {
      expect(dockerfile.indexOf('COPY scripts/enforce-pnpm.mjs'))
        .toBeLessThan(dockerfile.indexOf('RUN pnpm install --frozen-lockfile'));
    }
  });

  it('mounts only policy verification material and gates readiness on a verified bundle', () => {
    const compose = read('docker-compose.yml');
    const values = read('deploy/helm/guardllm/values.yaml');
    const workloads = read('deploy/helm/guardllm/templates/workloads.yaml');
    const schema = JSON.parse(read('deploy/helm/guardllm/values.schema.json'));
    const gitignore = read('.gitignore');
    const dockerignore = read('.dockerignore');

    expect(compose).toContain('POLICY_SIGNING_PUBLIC_KEY_FILE: /run/secrets/guardllm-policy-signing/public.pem');
    expect(compose).toContain('./.guardllm/policy-signing/public:/run/secrets/guardllm-policy-signing:ro');
    expect(compose).not.toMatch(/POLICY_SIGNING_PRIVATE_KEY(?:_FILE)?/);
    expect(compose).toContain('/app/.next/cache:size=256m,uid=1000,gid=1000,mode=0750');
    expect(compose).toContain("fetch('http://127.0.0.1:5000/api/health/policy')");
    expect(values).toContain('GUARDLLM_DEPLOYMENT_PROFILE: production');
    expect(values).toContain('POLICY_LKG_MAX_AGE_MS: "300000"');
    expect(values).toContain('readinessPath: /api/health/policy');
    expect(values).toContain('livenessPath: /api/health/live');
    expect(workloads).toContain('name: POLICY_SIGNING_PUBLIC_KEY_FILE');
    expect(workloads).toContain('name: POLICY_SIGNING_KEY_ID');
    expect(workloads).toContain('default $workload.healthPath $workload.readinessPath');
    expect(workloads).toContain('default $workload.healthPath $workload.livenessPath');
    expect(workloads).toContain('name: policy-verification');
    expect(workloads).toContain('readOnly: true');
    expect(workloads).not.toMatch(/POLICY_SIGNING_PRIVATE_KEY(?:_FILE)?/);
    expect(schema.required).toContain('policyVerification');
    expect(schema.properties.policyVerification.properties.signingKeyId.pattern)
      .toBe('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
    expect(gitignore).toContain('.guardllm/');
    expect(dockerignore).toContain('.guardllm');
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

  it('keeps legacy seed and request-time initialization modules out of the product', () => {
    expect(existsSync('src/app/api/init-database/route.ts')).toBe(false);
    expect(existsSync('src/lib/db/seed.ts')).toBe(false);
    expect(existsSync('src/lib/db/seed-supabase.ts')).toBe(false);
    expect(existsSync('src/lib/detection/init-database.ts')).toBe(false);
  });
});
