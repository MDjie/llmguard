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
  const sample = family.get(key) ?? { labels: normalizedLabels(labels), value: 0 };
  sample.value += amount;
  family.set(key, sample);
  counters.set(name, family);
}

export function replaceGauge(name: string, samples: readonly { labels: Labels; value: number }[]): void {
  const family = new Map<string, MetricSample>();
  for (const item of samples) {
    const labels = normalizedLabels(item.labels);
    family.set(labelKey(labels), { labels, value: Number.isFinite(item.value) ? item.value : 0 });
  }
  gauges.set(name, family);
}

function setGauge(name: string, labelsInput: Labels, value: number): void {
  const labels = normalizedLabels(labelsInput);
  const family = gauges.get(name) ?? new Map<string, MetricSample>();
  family.set(labelKey(labels), { labels, value: Number.isFinite(value) ? value : 0 });
  gauges.set(name, family);
}

function observe(name: string, labels: Labels, value: number, buckets = DEFAULT_BUCKETS_MS): void {
  const key = labelKey(labels);
  const family = histograms.get(name) ?? new Map<string, HistogramSample>();
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
}): void {
  const labels = {
    direction: input.direction.slice(0, 32),
    action: input.action.slice(0, 16),
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
}): void {
  const labels = {
    domain: input.domain.slice(0, 64),
    action: input.action.slice(0, 24),
    locale: input.locale.slice(0, 32),
    jurisdiction: input.jurisdiction.slice(0, 64),
    industry: input.industry.slice(0, 64),
    recheck: input.recheck,
  };
  increment('guardllm_output_control_decisions_total', labels);
  observe('guardllm_output_control_duration_ms', labels, input.latencyMs);
  for (const entityType of new Set(input.entityTypes)) {
    increment('guardllm_dlp_entities_total', {
      entity_type: entityType.slice(0, 128),
      action: labels.action,
    });
  }
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
