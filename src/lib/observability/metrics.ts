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
