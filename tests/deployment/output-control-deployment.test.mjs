import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(path, 'utf8');

describe('output-control deployment contract', () => {
  it('requires an independent DLP tokenization key in local Compose', () => {
    const compose = read('docker-compose.yml');
    expect(compose).toContain(
      'DLP_TOKENIZATION_HMAC_KEY: "${DLP_TOKENIZATION_HMAC_KEY:?DLP_TOKENIZATION_HMAC_KEY is required}"',
    );
  });

  it('requires the DLP tokenization key from the external Helm runtime Secret', () => {
    const workload = read('deploy/helm/guardllm/templates/workloads.yaml');
    expect(workload).toContain('name: DLP_TOKENIZATION_HMAC_KEY');
    expect(workload).toContain('key: DLP_TOKENIZATION_HMAC_KEY');
  });

  it('ships an idempotent selector migration with the governed dimensions', () => {
    const migration = read('drizzle/0040_output_control_governance.sql');
    for (const column of [
      'jurisdiction',
      'business_line',
      'legal_disclaimer_version',
      'template_scope',
    ]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(migration).toContain("conname = 'response_templates_scope_check'");
    expect(migration).toContain('response_templates_runtime_selector_idx');
  });
});
