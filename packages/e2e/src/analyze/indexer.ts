import { Interface, type Provider } from 'ethers';
import type { RecorderEvent } from '@drift-network/operator';

const EAS_IFACE = new Interface([
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
  'event Revoked(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)'
]);

export interface IndexerCheckParams {
  provider: Pick<Provider, 'getLogs' | 'getBlock'>;
  eas: string;
  schemaUID: string;
  fromBlock: number;
  /** Largest block range per eth_getLogs call (public RPCs cap it). */
  chunk?: number;
}

export interface IndexerCheckRow {
  run: string;
  context: string;
  tier: string;
  epoch: string;
  tE: number;
  /** rawRecords of snapshot.done: what the indexer returned for the schema at t_E. */
  snapshot: number;
  /** Attested minus Revoked for the schema, both in blocks at or before t_E, from EAS logs. */
  chain: number;
  match: boolean;
}

interface Stamped {
  uid: string;
  time: number;
}

async function logs(p: IndexerCheckParams, event: 'Attested' | 'Revoked', toBlock: number, blockTime: (n: number) => Promise<number>): Promise<Stamped[]> {
  const topics = EAS_IFACE.encodeFilterTopics(EAS_IFACE.getEvent(event)!, [null, null, null, p.schemaUID]);
  const chunk = p.chunk ?? 50_000;
  const out: Stamped[] = [];
  for (let from = p.fromBlock; from <= toBlock; from += chunk) {
    const batch = await p.provider.getLogs({ address: p.eas, topics, fromBlock: from, toBlock: Math.min(toBlock, from + chunk - 1) });
    for (const l of batch) {
      const parsed = EAS_IFACE.parseLog(l);
      if (parsed) out.push({ uid: (parsed.args.uid as string).toLowerCase(), time: await blockTime(l.blockNumber) });
    }
  }
  return out;
}

/**
 * Post-hoc check of the indexer assumption: for every snapshot, the number of attestations the
 * indexer returned for the schema at t_E (snapshot.done rawRecords, before the member filter)
 * against the same count rebuilt from EAS's own Attested and Revoked logs. A mismatch means the
 * indexer was stale or wrong for that epoch. All snapshots of one epoch (several Tier 2 owners)
 * are checked. The schema is the one given; contexts on other schemas are not comparable.
 */
export async function indexerCheck(events: RecorderEvent[], p: IndexerCheckParams): Promise<IndexerCheckRow[]> {
  // t_E per (run, process, context, epoch) from the synced o1.checked that preceded the snapshot.
  const boundary = new Map<string, number>();
  for (const e of events) if (e.type === 'o1.checked' && e.synced === true) boundary.set(`${e.runId}|${e.process}|${e.context}|${e.epoch}`, Number(e.boundary));
  const snaps = events
    .filter((e) => e.type === 'snapshot.done')
    .map((e) => ({ e, tE: boundary.get(`${e.runId}|${e.process}|${e.context}|${e.epoch}`) }))
    .filter((s): s is { e: RecorderEvent; tE: number } => s.tE !== undefined);
  if (snaps.length === 0) return [];

  const cache = new Map<number, Promise<number>>();
  const blockTime = (n: number) => {
    let t = cache.get(n);
    if (!t) {
      t = p.provider.getBlock(n).then((b) => {
        if (!b) throw new Error(`block ${n} not found`);
        return b.timestamp;
      });
      cache.set(n, t);
    }
    return t;
  };
  const latest = await p.provider.getBlock('latest');
  if (!latest) throw new Error('could not read the latest block');
  const [attested, revoked] = await Promise.all([logs(p, 'Attested', latest.number, blockTime), logs(p, 'Revoked', latest.number, blockTime)]);

  const rows: IndexerCheckRow[] = snaps.map(({ e, tE }) => {
    const live = new Set(attested.filter((x) => x.time <= tE).map((x) => x.uid));
    for (const r of revoked) if (r.time <= tE) live.delete(r.uid);
    const snapshot = Number(e.rawRecords);
    return { run: e.runId, context: e.context ?? '', tier: e.tier ?? 'none', epoch: e.epoch ?? '', tE, snapshot, chain: live.size, match: snapshot === live.size };
  });
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return rows.sort((x, y) => cmp(x.run, y.run) || cmp(x.context, y.context) || cmp(x.tier, y.tier) || x.tE - y.tE || x.snapshot - y.snapshot);
}
