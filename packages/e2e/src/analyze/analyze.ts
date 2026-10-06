import { LATENCIES, instant, pairKey, type RecorderEvent, type TxInfo } from '@drift-network/operator';
import { summarize, summarizeBig, type BigSummary, type Summary } from './stats.js';
import type { LoadResult, QualityIssue } from './load.js';

// GROUPING =======================================================================================

/**
 * Each daemon names its contexts in its own config, so the owners of one Tier 2 Safe record the
 * same settlement under different context names. Contexts are grouped by what they share on
 * chain: two (process, context) pairs that recorded the same Tier 2 proposalId settle the same
 * epochs, so they form one group. The group label is the sorted list of context names, joined
 * with '+'. Contexts with no proposalId (Tier 1, watchers) are their own group.
 */
export function contextGroups(events: RecorderEvent[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const byProposal = new Map<string, string>();
  for (const e of events) {
    if (e.context === undefined) continue;
    const node = `${e.runId}|${e.process}|${e.context}`;
    add(node);
    const pid = e.proposalId;
    if (typeof pid === 'string') {
      const k = `${e.runId}|${pid.toLowerCase()}`;
      const seen = byProposal.get(k);
      if (seen) union(seen, node);
      else byProposal.set(k, node);
    }
  }
  const members = new Map<string, Set<string>>();
  for (const node of parent.keys()) {
    const root = find(node);
    const set = members.get(root) ?? new Set<string>();
    set.add(node.split('|')[2]!);
    members.set(root, set);
  }
  const label = new Map<string, string>();
  for (const node of parent.keys()) label.set(node, [...members.get(find(node))!].sort().join('+'));
  return label;
}

/** The event with its context replaced by its group label (process-level events: `process:<name>`). */
function regroup(e: RecorderEvent, groups: Map<string, string>): RecorderEvent {
  const context = e.context === undefined ? `process:${e.process}` : groups.get(`${e.runId}|${e.process}|${e.context}`)!;
  return { ...e, context };
}

// DEDUPLICATION ==================================================================================

const lc = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');

/**
 * Identity of a milestone: events with the same identity record the same fact, seen by several
 * processes (two owners both recording tier2.published) or twice by one. Measurement events
 * (durations of work each process really did) have no identity and are all kept.
 */
function identity(e: RecorderEvent): string | undefined {
  const g = `${e.runId}|${e.context}|${e.tier ?? ''}|${e.epoch ?? ''}`;
  switch (e.type) {
    case 'tx.sent':
      return `${e.runId}|tx.sent|${lc(e.hash)}`;
    case 'tx.mined':
      return `${e.runId}|tx.mined|${lc((e.tx as TxInfo).hash)}`;
    case 'tier2.proposed':
    case 'tier2.published':
    case 'tier2.executed':
    case 'tier2.round_outcome':
      return `${e.runId}|${e.type}|${lc(e.proposalId)}`;
    case 'tier2.committed':
    case 'tier2.revealed':
    case 'tier2.signed':
      return `${e.runId}|${e.type}|${lc(e.proposalId)}|${lc(e.owner)}`;
    case 'epoch.due':
    case 'epoch.finalized':
    case 'bond.withdrawn':
      return `${g}|${e.type}`;
    case 'epoch.posted':
    case 'settle.posted':
    case 'watch.root_seen':
      return `${g}|${e.type}|${lc(e.root)}`;
    case 'watch.divergence':
      return `${g}|${e.type}|${lc(e.postedRoot)}`;
    case 'challenge.detected':
    case 'challenge.answered':
    case 'challenge.unanswerable':
    case 'challenge.expired':
    case 'challenge.claimed':
    case 'watch.challenge_opened':
      return `${g}|${e.type}|${lc(e.node)}|${lc(e.role)}`;
    default:
      return undefined;
  }
}

/** Total order: wall time, then process, then seq. Ties are broken the same way on every run. */
export const eventOrder = (a: RecorderEvent, b: RecorderEvent): number =>
  a.wallMs - b.wallMs || (a.process < b.process ? -1 : a.process > b.process ? 1 : 0) || a.seq - b.seq;

/** Keeps the earliest event of each identity; returns the kept events in eventOrder and the count dropped. */
export function dedupe(events: RecorderEvent[]): { events: RecorderEvent[]; duplicates: number } {
  const sorted = [...events].sort(eventOrder);
  const seen = new Set<string>();
  const out: RecorderEvent[] = [];
  for (const e of sorted) {
    const id = identity(e);
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(e);
  }
  return { events: out, duplicates: sorted.length - out.length };
}

// LATENCIES ======================================================================================

export interface LatencySample {
  latency: string;
  tier: string;
  /** Extra label, e.g. the tx action for tx_inclusion; '' when none. */
  label: string;
  /** The pairing key (or event identity) the sample belongs to. */
  key: string;
  run: string;
  context: string;
  epoch: string;
  seconds: number;
}

/**
 * Applies the operator's LATENCIES definitions to the merged, deduplicated events. A pair latency
 * uses, per key, the earliest `from` and the earliest `to` instant over all processes, which is the
 * union of what the processes observed. A negative pair (the `to` seen before the `from`, e.g. an
 * owner that joined late) is reported as a quality issue and left out.
 */
export function latencySamples(events: RecorderEvent[], issues: QualityIssue[]): LatencySample[] {
  const out: LatencySample[] = [];
  for (const def of LATENCIES) {
    if (def.kind === 'single') {
      for (const e of events) {
        if (e.type !== def.event) continue;
        const v = def.value(e);
        if (v === undefined) continue;
        out.push({ latency: def.name, tier: e.tier ?? 'none', label: '', key: `${e.process}#${e.seq}`, run: e.runId, context: e.context ?? '', epoch: e.epoch ?? '', seconds: v });
      }
      continue;
    }
    const from = new Map<string, number>();
    const to = new Map<string, { t: number; e: RecorderEvent }>();
    for (const e of events) {
      if (e.type !== def.from && e.type !== def.to) continue;
      if (def.where && !def.where(e)) continue;
      const k = pairKey(e, def.key);
      const t = instant(e, def.clock);
      if (k === undefined || t === undefined) continue;
      if (e.type === def.from) from.set(k, Math.min(from.get(k) ?? Infinity, t));
      if (e.type === def.to) {
        const cur = to.get(k);
        if (!cur || t < cur.t) to.set(k, { t, e });
      }
    }
    for (const [k, end] of [...to].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const start = from.get(k);
      if (start === undefined) continue;
      const seconds = end.t - start;
      if (seconds < 0) {
        issues.push({ kind: 'negative_latency', file: '-', detail: `${def.name} ${k}: ${seconds.toFixed(3)} s` });
        continue;
      }
      const labels = def.labels?.(end.e) ?? {};
      const label = Object.keys(labels).sort().map((n) => labels[n]).join(',');
      out.push({ latency: def.name, tier: end.e.tier ?? 'none', label, key: k, run: end.e.runId, context: end.e.context ?? '', epoch: end.e.epoch ?? '', seconds });
    }
  }
  return out;
}

export interface LatencyRow extends Summary {
  latency: string;
  tier: string;
  label: string;
}

export function latencyTable(samples: LatencySample[]): LatencyRow[] {
  const groups = new Map<string, { latency: string; tier: string; label: string; values: number[] }>();
  for (const s of samples) {
    const k = `${s.latency}\u0000${s.tier}\u0000${s.label}`;
    const g = groups.get(k) ?? { latency: s.latency, tier: s.tier, label: s.label, values: [] };
    g.values.push(s.seconds);
    groups.set(k, g);
  }
  const order = new Map(LATENCIES.map((d, i) => [d.name, i]));
  return [...groups.values()]
    .map((g) => ({ latency: g.latency, tier: g.tier, label: g.label, ...summarize(g.values) }))
    .sort((a, b) => order.get(a.latency)! - order.get(b.latency)! || cmp(a.tier, b.tier) || cmp(a.label, b.label));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Compares decimal strings numerically; '' (no epoch or round) sorts first. */
const cmpNum = (a: string, b: string) => (a === b ? 0 : a === '' ? -1 : b === '' ? 1 : BigInt(a) < BigInt(b) ? -1 : 1);

// GAS AND FEES ===================================================================================

export interface MinedTx {
  run: string;
  context: string;
  tier: string;
  epoch: string;
  action: string;
  tx: TxInfo;
}

export interface GasRow {
  tier: string;
  action: string;
  /** Gas and fee of the successful transactions; n = 0 when every one reverted. */
  gas: BigSummary;
  fee: BigSummary;
  reverted: number;
  revertedGas: bigint;
  /** Everything paid for this action, reverted transactions included. */
  totalFeeWei: bigint;
}

const EMPTY: BigSummary = { n: 0, median: 0n, min: 0n, max: 0n, total: 0n };

export function minedTxs(events: RecorderEvent[]): MinedTx[] {
  return events
    .filter((e) => e.type === 'tx.mined')
    .map((e) => ({ run: e.runId, context: e.context ?? '', tier: e.tier ?? 'none', epoch: e.epoch ?? '', action: String(e.action), tx: e.tx as TxInfo }));
}

export function gasTable(txs: MinedTx[]): GasRow[] {
  const groups = new Map<string, MinedTx[]>();
  for (const t of txs) {
    const k = `${t.tier}\u0000${t.action}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.values()]
    .map((g) => {
      // A reverted transaction (e.g. two Safe owners executing the same settlement at once) costs
      // gas but is not a sample of the action's cost, so it is counted apart.
      const ok = g.filter((t) => t.tx.status === 1);
      const bad = g.filter((t) => t.tx.status !== 1);
      return {
        tier: g[0]!.tier,
        action: g[0]!.action,
        gas: ok.length ? summarizeBig(ok.map((t) => BigInt(t.tx.gasUsed))) : EMPTY,
        fee: ok.length ? summarizeBig(ok.map((t) => BigInt(t.tx.feeWei))) : EMPTY,
        reverted: bad.length,
        revertedGas: bad.reduce((s, t) => s + BigInt(t.tx.gasUsed), 0n),
        totalFeeWei: g.reduce((s, t) => s + BigInt(t.tx.feeWei), 0n)
      };
    })
    .sort((a, b) => cmp(a.tier, b.tier) || cmp(a.action, b.action));
}

export interface EpochCostRow {
  run: string;
  context: string;
  tier: string;
  epoch: string;
  txs: number;
  gas: bigint;
  feeWei: bigint;
}

/** Cost per settled epoch. Transactions outside an epoch (setup, ad hoc) have epoch ''. */
export function epochCosts(txs: MinedTx[]): EpochCostRow[] {
  const groups = new Map<string, EpochCostRow>();
  for (const t of txs) {
    const k = `${t.run}\u0000${t.context}\u0000${t.tier}\u0000${t.epoch}`;
    const r = groups.get(k) ?? { run: t.run, context: t.context, tier: t.tier, epoch: t.epoch, txs: 0, gas: 0n, feeWei: 0n };
    r.txs++;
    r.gas += BigInt(t.tx.gasUsed);
    r.feeWei += BigInt(t.tx.feeWei);
    groups.set(k, r);
  }
  return [...groups.values()].sort((a, b) => cmp(a.run, b.run) || cmp(a.context, b.context) || cmp(a.tier, b.tier) || cmpNum(a.epoch, b.epoch));
}

export interface TierCostRow {
  tier: string;
  epochs: number;
  totalFeeWei: bigint;
  perEpoch: BigSummary;
}

/** Totals per tier; per-epoch statistics cover rows with an epoch only. */
export function tierCosts(rows: EpochCostRow[]): TierCostRow[] {
  const tiers = [...new Set(rows.map((r) => r.tier))].sort();
  return tiers.map((tier) => {
    const all = rows.filter((r) => r.tier === tier);
    const withEpoch = all.filter((r) => r.epoch !== '');
    return {
      tier,
      epochs: withEpoch.length,
      totalFeeWei: all.reduce((s, r) => s + r.feeWei, 0n),
      perEpoch: withEpoch.length ? summarizeBig(withEpoch.map((r) => r.feeWei)) : { n: 0, median: 0n, min: 0n, max: 0n, total: 0n }
    };
  });
}

// TIER 2 =========================================================================================

export interface RoundRow {
  run: string;
  context: string;
  epoch: string;
  round: string;
  proposalId: string;
  outcome: string;
  commits: number;
  reveals: number;
  signatures: number;
  executed: boolean;
}

export interface Tier2StepSample {
  step: 'commit' | 'reveal' | 'publish' | 'sign' | 'execute';
  seconds: number;
}

const num = (v: unknown) => Number(v);

/**
 * Rounds and their step latencies, on the wall clock (Tier 2 windows are wall-clock deadlines):
 * commit and its owner measured from the proposal; reveal from the commit deadline; publish from
 * the reveal deadline; signatures and execution from publication.
 */
export function tier2Rounds(events: RecorderEvent[]): { rounds: RoundRow[]; steps: Tier2StepSample[] } {
  const rounds: RoundRow[] = [];
  const steps: Tier2StepSample[] = [];
  const byPid = new Map<string, RecorderEvent[]>();
  for (const e of events) {
    if (!e.type.startsWith('tier2.') || typeof e.proposalId !== 'string') continue;
    const k = `${e.runId}|${e.proposalId.toLowerCase()}`;
    byPid.set(k, [...(byPid.get(k) ?? []), e]);
  }
  for (const evs of byPid.values()) {
    const proposed = evs.find((e) => e.type === 'tier2.proposed');
    const of = (t: string) => evs.filter((e) => e.type === t);
    const published = of('tier2.published')[0];
    const executed = of('tier2.executed')[0];
    const outcome = of('tier2.round_outcome')[0];
    const any = proposed ?? evs[0]!;
    rounds.push({
      run: any.runId,
      context: any.context ?? '',
      epoch: any.epoch ?? '',
      round: any.round ?? '',
      proposalId: String(any.proposalId).toLowerCase(),
      outcome: outcome ? String(outcome.outcome) : executed ? 'agreed' : 'unknown',
      commits: of('tier2.committed').length,
      reveals: of('tier2.revealed').length,
      signatures: of('tier2.signed').length,
      executed: executed !== undefined
    });
    const w = (e: RecorderEvent) => e.wallMs / 1000;
    if (proposed) {
      for (const c of of('tier2.committed')) steps.push({ step: 'commit', seconds: w(c) - w(proposed) });
      for (const r of of('tier2.revealed')) steps.push({ step: 'reveal', seconds: w(r) - num(proposed.commitDeadline) });
      if (published) steps.push({ step: 'publish', seconds: w(published) - num(proposed.revealDeadline) });
    }
    if (published) {
      for (const s of of('tier2.signed')) steps.push({ step: 'sign', seconds: w(s) - w(published) });
      if (executed) steps.push({ step: 'execute', seconds: w(executed) - w(published) });
    }
  }
  rounds.sort((a, b) => cmp(a.run, b.run) || cmp(a.context, b.context) || cmpNum(a.epoch, b.epoch) || cmpNum(a.round, b.round));
  return { rounds, steps };
}

export interface RoundsPerEpochRow {
  run: string;
  context: string;
  epoch: string;
  rounds: number;
  dead: number;
  settled: boolean;
}

export function roundsPerEpoch(rounds: RoundRow[]): RoundsPerEpochRow[] {
  const groups = new Map<string, RoundsPerEpochRow>();
  for (const r of rounds) {
    const k = `${r.run}\u0000${r.context}\u0000${r.epoch}`;
    const g = groups.get(k) ?? { run: r.run, context: r.context, epoch: r.epoch, rounds: 0, dead: 0, settled: false };
    g.rounds++;
    if (r.outcome === 'dead') g.dead++;
    if (r.executed) g.settled = true;
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => cmp(a.run, b.run) || cmp(a.context, b.context) || cmpNum(a.epoch, b.epoch));
}

// DISPUTES =======================================================================================

export interface DisputeCounts {
  tier: string;
  detected: number;
  answered: number;
  unanswerable: number;
  expired: number;
  claimed: number;
}

export interface WatchCounts {
  rootsSeen: number;
  recomputed: number;
  divergences: number;
  omittedPairs: number;
  challengesOpened: number;
  challengesSkipped: number;
}

export function disputeCounts(events: RecorderEvent[]): { settler: DisputeCounts[]; watcher: WatchCounts } {
  const tiers = [...new Set(events.filter((e) => e.type.startsWith('challenge.')).map((e) => e.tier ?? 'none'))].sort();
  const count = (tier: string, type: string) => events.filter((e) => e.type === type && (e.tier ?? 'none') === tier).length;
  const settler = tiers.map((tier) => ({
    tier,
    detected: count(tier, 'challenge.detected'),
    answered: count(tier, 'challenge.answered'),
    unanswerable: count(tier, 'challenge.unanswerable'),
    expired: count(tier, 'challenge.expired'),
    claimed: count(tier, 'challenge.claimed')
  }));
  const n = (type: string) => events.filter((e) => e.type === type).length;
  const watcher: WatchCounts = {
    rootsSeen: n('watch.root_seen'),
    recomputed: n('watch.recomputed'),
    divergences: n('watch.divergence'),
    omittedPairs: events.filter((e) => e.type === 'watch.divergence').reduce((s, e) => s + Number(e.omitted), 0),
    challengesOpened: n('watch.challenge_opened'),
    challengesSkipped: n('watch.challenge_skipped')
  };
  return { settler, watcher };
}

// TIMELINE =======================================================================================

export interface TimelineRow {
  run: string;
  context: string;
  tier: string;
  epoch: string;
  /** t_E, chain seconds (from epoch.due). */
  tE?: number;
  o1Wait?: number;
  snapshot?: number;
  compute?: number;
  settleTotal?: number;
  finalization?: number;
  bondWithdrawal?: number;
  rounds?: number;
  txs: number;
  feeWei: bigint;
}

/** One row per (run, context, tier, epoch) that fell due or was posted. */
export function timeline(events: RecorderEvent[], samples: LatencySample[], costs: EpochCostRow[], perEpochRounds: RoundsPerEpochRow[]): TimelineRow[] {
  const rows = new Map<string, TimelineRow>();
  const key = (run: string, context: string, tier: string, epoch: string) => `${run}\u0000${context}\u0000${tier}\u0000${epoch}`;
  const row = (run: string, context: string, tier: string, epoch: string): TimelineRow => {
    const k = key(run, context, tier, epoch);
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { run, context, tier, epoch, txs: 0, feeWei: 0n }));
    return r;
  };
  for (const e of events) {
    if ((e.type === 'epoch.due' || e.type === 'epoch.posted') && e.tier !== 'watcher' && e.epoch !== undefined) {
      const r = row(e.runId, e.context ?? '', e.tier ?? 'none', e.epoch);
      if (e.type === 'epoch.due' && typeof e.chainTime === 'number') r.tE = e.chainTime;
    }
  }
  const field: Record<string, keyof TimelineRow> = {
    o1_wait: 'o1Wait',
    snapshot: 'snapshot',
    compute: 'compute',
    settle_total: 'settleTotal',
    finalization: 'finalization',
    bond_withdrawal: 'bondWithdrawal'
  };
  for (const s of samples) {
    const f = field[s.latency];
    const r = rows.get(key(s.run, s.context, s.tier, s.epoch));
    if (!f || !r) continue;
    // Several Tier 2 owners compute the same epoch: keep the earliest completed (smallest) value.
    const cur = r[f] as number | undefined;
    (r as unknown as Record<string, number>)[f] = cur === undefined ? s.seconds : Math.min(cur, s.seconds);
  }
  for (const c of costs) {
    const r = rows.get(key(c.run, c.context, c.tier, c.epoch));
    if (!r) continue;
    r.txs += c.txs;
    r.feeWei += c.feeWei;
  }
  for (const p of perEpochRounds) {
    const r = rows.get(key(p.run, p.context, 'tier2', p.epoch));
    if (r) r.rounds = p.rounds;
  }
  return [...rows.values()].sort((a, b) => cmp(a.run, b.run) || cmp(a.context, b.context) || cmp(a.tier, b.tier) || cmpNum(a.epoch, b.epoch));
}

// ALL ============================================================================================

export interface Analysis {
  /** The merged events: contexts grouped, duplicate observations removed, in eventOrder. */
  events: RecorderEvent[];
  inputs: LoadResult['files'];
  issues: QualityIssue[];
  counts: { events: number; duplicates: number; runs: string[]; processes: string[]; groups: string[] };
  samples: LatencySample[];
  latency: LatencyRow[];
  gas: GasRow[];
  epochCosts: EpochCostRow[];
  tierCosts: TierCostRow[];
  rounds: RoundRow[];
  roundsPerEpoch: RoundsPerEpochRow[];
  tier2Steps: { step: string; summary: Summary }[];
  disputes: ReturnType<typeof disputeCounts>;
  timeline: TimelineRow[];
}

export function analyze(loaded: LoadResult): Analysis {
  const issues = [...loaded.issues];
  const raw = loaded.events.map((l) => l.event);
  const groups = contextGroups(raw);
  const { events, duplicates } = dedupe(raw.map((e) => regroup(e, groups)));

  const mined = new Set(events.filter((e) => e.type === 'tx.mined').map((e) => `${e.runId}|${lc((e.tx as TxInfo).hash)}`));
  for (const e of events) {
    if (e.type === 'tx.sent' && !mined.has(`${e.runId}|${lc(e.hash)}`)) {
      issues.push({ kind: 'tx_without_receipt', file: `${e.process}`, detail: `${String(e.action)} ${String(e.hash)} (seq ${e.seq})` });
    }
  }

  const samples = latencySamples(events, issues);
  const txs = minedTxs(events);
  const costs = epochCosts(txs);
  const { rounds, steps } = tier2Rounds(events);
  const perEpoch = roundsPerEpoch(rounds);
  const stepOrder = ['commit', 'reveal', 'publish', 'sign', 'execute'];
  const tier2Steps = stepOrder
    .map((step) => ({ step, values: steps.filter((s) => s.step === step).map((s) => s.seconds) }))
    .filter((s) => s.values.length)
    .map((s) => ({ step: s.step, summary: summarize(s.values) }));

  issues.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.detail, b.detail));
  return {
    events,
    inputs: loaded.files,
    issues,
    counts: {
      events: events.length,
      duplicates,
      runs: [...new Set(events.map((e) => e.runId))].sort(),
      processes: [...new Set(events.map((e) => e.process))].sort(),
      groups: [...new Set(events.map((e) => e.context ?? ''))].sort()
    },
    samples: [...samples].sort((a, b) => cmp(a.latency, b.latency) || cmp(a.tier, b.tier) || cmp(a.label, b.label) || cmp(a.key, b.key)),
    latency: latencyTable(samples),
    gas: gasTable(txs),
    epochCosts: costs,
    tierCosts: tierCosts(costs),
    rounds,
    roundsPerEpoch: perEpoch,
    tier2Steps,
    disputes: disputeCounts(events),
    timeline: timeline(events, samples, costs, perEpoch)
  };
}
