/**
 * In-process metrics: counters, gauges and latency histograms.
 *
 * The replica had only logs plus `/health`. A deployable panel needs to be scrapeable, so
 * this module keeps a small Prometheus-compatible registry without pulling a metrics
 * dependency:
 *
 *   - counters are keyed by name + sorted label pairs;
 *   - histograms use explicit buckets (default: HTTP latency in seconds);
 *   - exposition is the Prometheus text format 0.0.4, rendered on demand.
 *
 * Scraping is gated by `middlewares/metrics_auth.ts` (token or loopback), so the endpoint
 * never becomes an anonymous inventory of traffic shapes.
 */

export type Labels = Record<string, string>;

const labelKey = (labels: Labels = {}) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, "_")}"`)
    .join(",");

const withLabels = (name: string, labels: Labels) =>
  labelKey(labels) ? `${name}{${labelKey(labels)}}` : name;

type Counter = { name: string; help: string; values: Map<string, number> };
type Gauge = { name: string; help: string; values: Map<string, number> };
type Histogram = {
  name: string;
  help: string;
  buckets: number[];
  values: Map<string, { counts: number[]; sum: number; count: number }>;
};

const counters = new Map<string, Counter>();
const gauges = new Map<string, Gauge>();
const histograms = new Map<string, Histogram>();

export const DEFAULT_HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function counter(name: string, help: string): void {
  if (!counters.has(name)) counters.set(name, { name, help, values: new Map() });
}

export function gauge(name: string, help: string): void {
  if (!gauges.has(name)) gauges.set(name, { name, help, values: new Map() });
}

export function histogram(name: string, help: string, buckets: number[] = DEFAULT_HTTP_BUCKETS): void {
  if (!histograms.has(name))
    histograms.set(name, { name, help, buckets: [...buckets].sort((a, b) => a - b), values: new Map() });
}

export function incr(name: string, labels: Labels = {}, by = 1): void {
  counter(name, "");
  const entry = counters.get(name)!;
  const key = labelKey(labels);
  entry.values.set(key, (entry.values.get(key) ?? 0) + by);
}

export function setGauge(name: string, value: number, labels: Labels = {}): void {
  gauge(name, "");
  gauges.get(name)!.values.set(labelKey(labels), value);
}

export function observe(name: string, seconds: number, labels: Labels = {}): void {
  histogram(name, "");
  const entry = histograms.get(name)!;
  const key = labelKey(labels);
  const current = entry.values.get(key) ?? {
    counts: new Array(entry.buckets.length).fill(0),
    sum: 0,
    count: 0,
  };
  for (let i = 0; i < entry.buckets.length; i++) if (seconds <= entry.buckets[i]) current.counts[i] += 1;
  current.sum += seconds;
  current.count += 1;
  entry.values.set(key, current);
}

/** Prometheus text exposition (version 0.0.4). */
export function render(): string {
  const out: string[] = [];
  const sample = (name: string, key: string, value: number) =>
    key ? `${name}{${key}} ${value}` : `${name} ${value}`;
  for (const { name, help, values } of counters.values()) {
    out.push(`# HELP ${name} ${help || name}`, `# TYPE ${name} counter`);
    for (const [key, value] of values) out.push(sample(name, key, value));
    if (values.size === 0) out.push(`${name} 0`);
  }
  for (const { name, help, values } of gauges.values()) {
    out.push(`# HELP ${name} ${help || name}`, `# TYPE ${name} gauge`);
    for (const [key, value] of values) out.push(sample(name, key, value));
    if (values.size === 0) out.push(`${name} 0`);
  }
  for (const { name, help, buckets, values } of histograms.values()) {
    out.push(`# HELP ${name} ${help || name}`, `# TYPE ${name} histogram`);
    for (const [key, value] of values) {
      const prefix = key ? `${name}_bucket{${key},le=` : `${name}_bucket{le=`;
      for (let i = 0; i < buckets.length; i++) out.push(`${prefix}"${buckets[i]}"} ${value.counts[i]}`);
      out.push(`${prefix}"+Inf"} ${value.count}`);
      out.push(key ? `${name}_sum{${key}} ${value.sum}` : `${name}_sum ${value.sum}`);
      out.push(key ? `${name}_count{${key}} ${value.count}` : `${name}_count ${value.count}`);
    }
  }
  return out.join("\n") + "\n";
}

/** Test helper. */
export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}
