import { createHash } from 'node:crypto';

type Labels = Readonly<Record<string, string | number>>;

interface MetricSample {
  readonly labels: Labels;
  value: number;
}

interface HistogramSample {
  readonly labels: Labels;
  readonly buckets: number[];
  readonly counts: number[];
  count: number;
  sum: number;
}

const counters = new Map<string, Map<string, MetricSample>>();
const gauges = new Map<string, Map<string, MetricSample>>();
const histograms = new Map<string, Map<string, HistogramSample>>();
const DEFAULT_BUCKETS_MS = [5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000];
const MAX_SERIES_PER_FAMILY = 2_048;

export function scopeMetricBucket(value: string): string {
  const bucket = createHash('sha256').update(value, 'utf8').digest().readUInt16BE(0) % 64;
  return 'b' + String(bucket).padStart(2, '0');
}

function boundedRiskCategory(value: string | undefined): string {
  if (!value) return 'none';
  const parts = value.toLocaleLowerCase('en-US').split('.').filter(Boolean);
  const root = parts[0] ?? 'other';
  const known = new Set([
    'prompt_injection', 'reasoning_attack', 'resource_abuse', 'insurance', 'illegal_content',
    'malicious_code', 'adult_content', 'self_harm', 'fraud_scam', 'misinformation',
    'copyright_risk', 'business_sensitive', 'output', 'pii', 'financial', 'credential',
    'sensitive_compliance', 'spam_detection', 'ad_detection', 'detector_availability',
  ]);
  if (!known.has(root)) return 'custom';
  return root === 'output' ? parts.slice(0, 2).join('.') || 'output' : root;
}

function boundedLocale(value: string | undefined): string {
  const normalized = value?.trim().toLocaleLowerCase('en-US') ?? '';
  if (normalized.startsWith('zh')) return 'zh';
  if (normalized.startsWith('en')) return 'en';
  if (normalized.startsWith('ja')) return 'ja';
  if (normalized.startsWith('ko')) return 'ko';
  if (normalized.startsWith('ar')) return 'ar';
  if (normalized.startsWith('es')) return 'es';
  if (normalized.startsWith('fr')) return 'fr';
  return normalized ? 'other' : 'und';
}

const OUTPUT_DOMAINS = new Set([
  'output.political', 'output.sexual', 'output.illegal', 'output.credential',
  'output.privacy', 'output.internal', 'output.insurance',
]);
const OUTPUT_INDUSTRIES = new Set([
  'general', 'insurance', 'banking', 'securities', 'healthcare', 'government',
  'telecom', 'retail', 'education', 'technology',
]);
const OUTPUT_JURISDICTIONS = new Set(['GLOBAL', 'CN', 'HK', 'MO', 'TW', 'US', 'EU', 'UK', 'SG', 'JP']);
const OUTPUT_ACTIONS = new Set(['ALLOW', 'WARN', 'MASK', 'REWRITE', 'REQUIRE_REVIEW', 'SAFE_RESPONSE', 'BLOCK']);

function boundedOutputDomain(value: string): string {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  return OUTPUT_DOMAINS.has(normalized) ? normalized : 'output.custom';
}

function boundedIndustry(value: string): string {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  return OUTPUT_INDUSTRIES.has(normalized) ? normalized : normalized ? 'custom' : 'general';
}

function boundedJurisdiction(value: string): string {
  const normalized = value.trim().toLocaleUpperCase('en-US');
  return OUTPUT_JURISDICTIONS.has(normalized) ? normalized : normalized ? 'OTHER' : 'GLOBAL';
}

const KNOWN_DLP_ENTITY_TYPES = new Set([
  'person.name', 'pii.mobile', 'pii.email', 'pii.identity.prc', 'pii.passport',
  'pii.address', 'customer.number', 'customer.phone', 'insurance.policy_number',
  'insurance.claim_number', 'insurance.beneficiary', 'insurance.underwriting',
  'sensitive.health', 'sensitive.medical', 'health.medical', 'financial.bank_card',
  'financial.account_balance', 'financial.income', 'financial.credit',
  'financial.payment', 'internal.system_prompt', 'internal.pricing',
  'internal.unreleased_product', 'internal.rule', 'internal.architecture',
  'internal.staff',
]);

function boundedDlpEntityType(value: string): string {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  return KNOWN_DLP_ENTITY_TYPES.has(normalized) ? normalized : 'custom';
}

function normalizedLabels(labels: Labels): Labels {
  return Object.fromEntries(
    Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key.replace(/[^a-zA-Z0-9_]/g, '_'), String(value).slice(0, 100)]),
  );
}

function labelKey(labels: Labels): string {
  return JSON.stringify(normalizedLabels(labels));
}

function escapeLabel(value: string | number): string {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: Labels, extra: Labels = {}): string {
  const entries = Object.entries({ ...labels, ...extra });
  if (entries.length === 0) return '';
  return '{' + entries.map(([key, value]) => key + '="' + escapeLabel(value) + '"').join(',') + '}';
}

function increment(name: string, labels: Labels, amount = 1): void {
  const key = labelKey(labels);
  const family = counters.get(name) ?? new Map<string, MetricSample>();
  if (!family.has(key) && family.size >= MAX_SERIES_PER_FAMILY) return;
  const sample = family.get(key) ?? { labels: normalizedLabels(labels), value: 0 };
  sample.value += amount;
  family.set(key, sample);
  counters.set(name, family);
}

export function replaceGauge(name: string, samples: readonly { labels: Labels; value: number }[]): void {
  const family = new Map<string, MetricSample>();
  for (const item of samples.slice(0, MAX_SERIES_PER_FAMILY)) {
    const labels = normalizedLabels(item.labels);
    family.set(labelKey(labels), { labels, value: Number.isFinite(item.value) ? item.value : 0 });
  }
  gauges.set(name, family);
}

function setGauge(name: string, labelsInput: Labels, value: number): void {
  const labels = normalizedLabels(labelsInput);
  const family = gauges.get(name) ?? new Map<string, MetricSample>();
  const key = labelKey(labels);
  if (!family.has(key) && family.size >= MAX_SERIES_PER_FAMILY) return;
  family.set(key, { labels, value: Number.isFinite(value) ? value : 0 });
  gauges.set(name, family);
}

function observe(name: string, labels: Labels, value: number, buckets = DEFAULT_BUCKETS_MS): void {
  const key = labelKey(labels);
  const family = histograms.get(name) ?? new Map<string, HistogramSample>();
  if (!family.has(key) && family.size >= MAX_SERIES_PER_FAMILY) return;
  const sample = family.get(key) ?? {
    labels: normalizedLabels(labels),
    buckets: [...buckets],
    counts: buckets.map(() => 0),
    count: 0,
    sum: 0,
  };
  sample.count += 1;
  sample.sum += Math.max(0, value);
  sample.buckets.forEach((boundary, index) => {
    if (value <= boundary) sample.counts[index] += 1;
  });
  family.set(key, sample);
  histograms.set(name, family);
}

export function normalizeMetricPath(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\/[0-9]+(?=\/|$)/g, '/:id')
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:id')
    .slice(0, 160);
}

export function observeHttpRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly latencyMs: number;
}): void {
  const labels = {
    method: input.method.slice(0, 10),
    route: normalizeMetricPath(input.path),
    status_class: Math.floor(input.status / 100) + 'xx',
  };
  increment('guardllm_http_requests_total', labels);
  observe('guardllm_http_request_duration_ms', labels, input.latencyMs);
}

export function observeGuardDecision(input: {
  readonly direction: string;
  readonly action: string;
  readonly latencyMs: number;
  readonly detectorFailures: number;
  readonly riskCategory?: string;
  readonly tenantId?: string;
  readonly applicationId?: string;
  readonly locale?: string;
  readonly modality?: string;
  readonly policyVersion?: string;
  readonly degraded?: boolean;
}): void {
  const labels = {
    direction: input.direction.slice(0, 32),
    action: input.action.slice(0, 16),
    risk_category: boundedRiskCategory(input.riskCategory),
    tenant_bucket: input.tenantId ? scopeMetricBucket(input.tenantId) : 'platform',
    application_bucket: input.applicationId ? scopeMetricBucket(input.applicationId) : 'platform',
    locale: boundedLocale(input.locale),
    modality: (input.modality ?? 'TEXT').replace(/[^A-Z_|]/giu, '').slice(0, 48) || 'OTHER',
    policy_version: (input.policyVersion ?? 'unknown').replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 32),
    outcome: input.degraded ? 'degraded' : 'ok',
  };
  increment('guardllm_guard_decisions_total', labels);
  observe('guardllm_guard_decision_duration_ms', labels, input.latencyMs);
  if (input.detectorFailures > 0) {
    increment('guardllm_required_detector_failures_total', { direction: labels.direction }, input.detectorFailures);
  }
}

export function observeGuardDetectorNode(input: {
  readonly detectorId: string;
  readonly tier: string;
  readonly status: string;
  readonly latencyMs: number;
  readonly queueDelayMs: number;
  readonly attempts: number;
  readonly costUnits: number;
  readonly inputChars: number;
  readonly batchSize: number;
}): void {
  const labels = {
    detector: input.detectorId.slice(0, 128),
    tier: input.tier.slice(0, 4),
    status: input.status.slice(0, 16),
  };
  increment('guardllm_detector_runs_total', labels);
  observe('guardllm_detector_duration_ms', labels, input.latencyMs);
  observe('guardllm_detector_queue_delay_ms', labels, input.queueDelayMs);
  observe(
    'guardllm_detector_input_chars',
    labels,
    input.inputChars,
    [128, 512, 2_048, 8_192, 32_768, 131_072, 524_288, 1_048_576],
  );
  observe('guardllm_detector_batch_size', labels, input.batchSize, [1, 2, 4, 8, 16, 32]);
  increment('guardllm_detector_attempts_total', labels, input.attempts);
  increment('guardllm_detector_cost_units_total', labels, input.costUnits);
}

export function observeDependencyCall(input: {
  readonly dependency: string;
  readonly operation: string;
  readonly status: 'success' | 'failure' | 'timeout' | 'circuit_open';
  readonly latencyMs: number;
}): void {
  const labels = {
    dependency: input.dependency.slice(0, 64),
    operation: input.operation.slice(0, 64),
    status: input.status,
  };
  increment('guardllm_dependency_calls_total', labels);
  observe('guardllm_dependency_duration_ms', labels, input.latencyMs);
}

export function observeRoutingDecision(input: {
  readonly routeId: string;
  readonly outcome: 'selected' | 'no_compliant_route' | 'unhealthy' | 'rollback';
  readonly queueDepth: number;
}): void {
  const labels = { route: input.routeId.slice(0, 64), outcome: input.outcome };
  increment('guardllm_model_routing_decisions_total', labels);
  setGauge('guardllm_model_route_queue_depth', { route: labels.route }, input.queueDepth);
}

export function observeRagGate(input: {
  readonly stage: 'ingest' | 'retrieval' | 'assembly' | 'output';
  readonly action: string;
  readonly rejectedCandidates: number;
}): void {
  const labels = { stage: input.stage, action: input.action.slice(0, 24) };
  increment('guardllm_rag_gate_decisions_total', labels);
  increment('guardllm_rag_rejected_candidates_total', { stage: input.stage }, input.rejectedCandidates);
}

export function observeToolFirewall(input: {
  readonly sideEffect: string;
  readonly disposition: string;
  readonly permitReplay: boolean;
}): void {
  const labels = {
    side_effect: input.sideEffect.slice(0, 32),
    disposition: input.disposition.slice(0, 32),
  };
  increment('guardllm_tool_firewall_decisions_total', labels);
  if (input.permitReplay) increment('guardllm_tool_permit_replays_total', labels);
}

export function observeAuditDelivery(input: {
  readonly destinationType: string;
  readonly state: 'delivered' | 'failed' | 'terminal_failed';
}): void {
  increment('guardllm_audit_delivery_total', {
    destination_type: input.destinationType.slice(0, 32),
    state: input.state,
  });
}

export function observeResourceControl(input: {
  readonly outcome: 'admitted' | 'rejected' | 'cancelled' | 'timeout' | 'degraded';
  readonly reasonCode: string;
  readonly queueDelayMs?: number;
}): void {
  const labels = {
    outcome: input.outcome,
    reason_code: input.reasonCode.replace(/[^A-Z0-9_]/giu, '_').slice(0, 80),
  };
  increment('guardllm_resource_control_total', labels);
  if (input.queueDelayMs !== undefined) {
    observe('guardllm_resource_queue_delay_ms', { outcome: input.outcome }, input.queueDelayMs);
  }
}

export function observeOutputControl(input: {
  readonly domain: string;
  readonly action: string;
  readonly locale: string;
  readonly jurisdiction: string;
  readonly industry: string;
  readonly recheck: 'completed' | 'failed' | 'not_required';
  readonly latencyMs: number;
  readonly entityTypes: readonly string[];
  readonly templateFallback?: boolean;
}): void {
  const normalizedAction = input.action.trim().toLocaleUpperCase('en-US');
  const labels = {
    domain: boundedOutputDomain(input.domain),
    action: OUTPUT_ACTIONS.has(normalizedAction) ? normalizedAction : 'OTHER',
    locale: boundedLocale(input.locale),
    jurisdiction: boundedJurisdiction(input.jurisdiction),
    industry: boundedIndustry(input.industry),
    recheck: input.recheck,
  };
  increment('guardllm_output_control_decisions_total', labels);
  observe('guardllm_output_control_duration_ms', labels, input.latencyMs);
  if (input.templateFallback) {
    increment('guardllm_template_fallback_total', { action: labels.action, domain: labels.domain });
  }
  if (input.recheck === 'failed') {
    increment('guardllm_output_recheck_failures_total', { action: labels.action, domain: labels.domain });
  }
  for (const entityType of new Set(input.entityTypes)) {
    increment('guardllm_dlp_entities_total', {
      entity_type: boundedDlpEntityType(entityType),
      action: labels.action,
    });
  }
}

export function observeShadowComparison(input: {
  readonly actionChanged: boolean;
  readonly activeHit: boolean;
  readonly shadowHit: boolean;
  readonly latencyDeltaMs: number;
}): void {
  const labels = {
    action_changed: input.actionChanged ? 'yes' : 'no',
    hit_diff: input.activeHit === input.shadowHit ? 'same' : input.shadowHit ? 'shadow_only' : 'active_only',
  };
  increment('guardllm_shadow_comparisons_total', labels);
  observe('guardllm_shadow_latency_delta_ms', labels, Math.abs(input.latencyDeltaMs));
}

export function observePolicyBundleGeneration(input: {
  readonly generation: number;
  readonly tenantId: string;
  readonly applicationId: string;
}): void {
  setGauge('guardllm_policy_bundle_generation', {
    tenant_bucket: scopeMetricBucket(input.tenantId),
    application_bucket: scopeMetricBucket(input.applicationId),
  }, input.generation);
}

export function observeHumanReview(input: {
  readonly workflow: 'badcase' | 'security_scan' | 'content_access';
  readonly agreement: 'agree' | 'disagree' | 'pending';
  readonly cycleMs?: number;
}): void {
  const labels = { workflow: input.workflow, agreement: input.agreement };
  increment('guardllm_human_review_total', labels);
  if (input.cycleMs !== undefined) {
    observe('guardllm_human_review_cycle_ms', labels, input.cycleMs, [1_000, 10_000, 60_000, 300_000, 3_600_000, 86_400_000]);
  }
}

export type SafetyAlertType =
  | 'POLICY_BUNDLE_MISSING'
  | 'POLICY_SIGNATURE_INVALID'
  | 'POLICY_DIGEST_MISMATCH'
  | 'POLICY_PUBLIC_KEY_MISMATCH'
  | 'AUDIT_CHAIN_BREAK'
  | 'MANDATORY_DENY_BYPASS'
  | 'STREAM_COMMIT_GATE_FAILURE';

export function observeSafetyAlert(type: SafetyAlertType): void {
  increment('guardllm_safety_alerts_total', { alert_type: type, priority: 'high' });
}

export function renderPrometheusMetrics(): string {
  const lines: string[] = [];
  for (const [name, family] of [...counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('# TYPE ' + name + ' counter');
    for (const sample of family.values()) lines.push(name + renderLabels(sample.labels) + ' ' + sample.value);
  }
  for (const [name, family] of [...gauges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('# TYPE ' + name + ' gauge');
    for (const sample of family.values()) lines.push(name + renderLabels(sample.labels) + ' ' + sample.value);
  }
  for (const [name, family] of [...histograms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('# TYPE ' + name + ' histogram');
    for (const sample of family.values()) {
      sample.buckets.forEach((boundary, index) => {
        lines.push(name + '_bucket' + renderLabels(sample.labels, { le: boundary }) + ' ' + sample.counts[index]);
      });
      lines.push(name + '_bucket' + renderLabels(sample.labels, { le: '+Inf' }) + ' ' + sample.count);
      lines.push(name + '_sum' + renderLabels(sample.labels) + ' ' + sample.sum);
      lines.push(name + '_count' + renderLabels(sample.labels) + ' ' + sample.count);
    }
  }
  return lines.join('\n') + '\n';
}

export function resetMetricsForTests(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}
