import { LATENCIES, instant, pairKey, type LatencyDef, type RecorderEvent, type TxInfo } from './events.js';
import type { EventSink } from './recorder.js';

/** Seconds; covers a sub-second step up to a multi-hour finalization. */
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400];

type Labels = Record<string, string>;
const labelKey = (l: Labels) => JSON.stringify(Object.entries(l).sort(([a], [b]) => (a < b ? -1 : 1)));
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const fmt = (l: Labels) => {
  const parts = Object.entries(l)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};

class Histogram {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string
  ) {}
  observe(labels: Labels, v: number): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) this.series.set(key, (s = { labels, counts: BUCKETS.map(() => 0), sum: 0, count: 0 }));
    BUCKETS.forEach((b, i) => {
      if (v <= b) s.counts[i]!++;
    });
    s.sum += v;
    s.count++;
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of [...this.series.values()].sort((a, b) => (labelKey(a.labels) < labelKey(b.labels) ? -1 : 1))) {
      BUCKETS.forEach((b, i) => out.push(`${this.name}_bucket${fmt({ ...s.labels, le: String(b) })} ${s.counts[i]}`));
      out.push(`${this.name}_bucket${fmt({ ...s.labels, le: '+Inf' })} ${s.count}`);
      out.push(`${this.name}_sum${fmt(s.labels)} ${s.sum}`);
      out.push(`${this.name}_count${fmt(s.labels)} ${s.count}`);
    }
    return out;
  }
}

class Counter {
  private readonly series = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string
  ) {}
  inc(labels: Labels, by = 1): void {
    const key = labelKey(labels);
    const s = this.series.get(key) ?? { labels, value: 0 };
    s.value += by;
    this.series.set(key, s);
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const s of [...this.series.values()].sort((a, b) => (labelKey(a.labels) < labelKey(b.labels) ? -1 : 1))) {
      out.push(`${this.name}${fmt(s.labels)} ${s.value}`);
    }
    return out;
  }
}

/** Bound on pending pair starts kept in memory; older ones are dropped first. */
const MAX_PENDING = 10_000;

/**
 * Prometheus metrics derived from recorder events with the same definitions (LATENCIES) the
 * offline analysis uses, so a live dashboard and the dissertation tables agree. Pair latencies
 * keep the first `from` event per key and observe once, at the first matching `to` event.
 */
export class MetricsSink implements EventSink {
  private readonly latency = new Map<string, Histogram>();
  private readonly pending = new Map<string, number>();
  private readonly done = new Set<string>();
  private readonly events = new Counter('drift_recorder_events_total', 'Recorded events by type.');
  private readonly gas = new Counter('drift_gas_used_total', 'Gas used by mined transactions, by action and tier.');
  private readonly fees = new Counter('drift_fee_wei_total', 'Fees paid by mined transactions (gasUsed x effective gas price), wei.');
  private readonly txs = new Counter('drift_transactions_total', 'Mined transactions by action, tier and status.');
  private readonly rounds = new Counter('drift_tier2_rounds_total', 'Tier 2 rounds by observed outcome.');

  constructor(private readonly defs: LatencyDef[] = LATENCIES) {
    for (const d of defs) this.latency.set(d.name, new Histogram(`drift_${d.name}_seconds`, d.help));
  }

  write(e: RecorderEvent): void {
    const tier = e.tier ?? 'none';
    this.events.inc({ type: e.type });
    if (e.type === 'tx.mined') {
      const tx = e.tx as TxInfo;
      const labels = { action: String(e.action), tier };
      this.gas.inc(labels, Number(tx.gasUsed));
      this.fees.inc(labels, Number(tx.feeWei));
      this.txs.inc({ ...labels, status: String(tx.status) });
    }
    if (e.type === 'tier2.round_outcome') this.rounds.inc({ outcome: String(e.outcome) });

    for (const d of this.defs) {
      const h = this.latency.get(d.name)!;
      if (d.kind === 'single') {
        if (e.type !== d.event) continue;
        const v = d.value(e);
        if (v !== undefined && Number.isFinite(v)) h.observe({ tier }, v);
        continue;
      }
      if (d.where && (e.type === d.from || e.type === d.to) && !d.where(e)) continue;
      const key = pairKey(e, d.key);
      if (key === undefined) continue;
      const slot = `${d.name}|${key}`;
      if (e.type === d.from && !this.pending.has(slot) && !this.done.has(slot)) {
        const t = instant(e, d.clock);
        if (t !== undefined) this.remember(slot, t);
      } else if (e.type === d.to && this.pending.has(slot)) {
        const t = instant(e, d.clock);
        if (t === undefined) continue;
        h.observe({ tier, ...(d.labels?.(e) ?? {}) }, t - this.pending.get(slot)!);
        this.pending.delete(slot);
        this.done.add(slot);
        if (this.done.size > MAX_PENDING) this.done.delete(this.done.values().next().value!);
      }
    }
  }

  private remember(slot: string, t: number): void {
    this.pending.set(slot, t);
    if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
  }

  render(): string {
    const parts = [
      ...[...this.latency.values()].flatMap((h) => h.render()),
      ...this.gas.render(),
      ...this.fees.render(),
      ...this.txs.render(),
      ...this.rounds.render(),
      ...this.events.render()
    ];
    return parts.join('\n') + '\n';
  }
}
