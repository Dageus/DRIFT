// Synthetic recorder logs for the analyze tests: a Tier 1 settler with a challenge, three Tier 2
// owners (a dead round, then an agreed one, with milestones seen by several owners), a watcher,
// and deliberate data problems (a seq gap, a transaction without receipt, two bad lines).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Fields = Record<string, unknown>;

class Proc {
  readonly lines: string[] = [];
  private seq = 0;
  constructor(
    readonly name: string,
    readonly scope: Fields
  ) {}
  ev(type: string, wallMs: number, fields: Fields = {}, opts: { skipSeq?: number } = {}): this {
    this.seq += 1 + (opts.skipSeq ?? 0);
    this.lines.push(JSON.stringify({ v: 1, type, runId: 'r1', process: this.name, seq: this.seq, wallMs, ...this.scope, ...fields }));
    return this;
  }
  tx(action: string, hash: string, sentMs: number, minedMs: number | null, gasUsed: number, fields: Fields = {}, chainTime = 0, status = 1): this {
    this.ev('tx.sent', sentMs, { action, hash, from: '0x' + '11'.repeat(20), ...fields });
    if (minedMs !== null) {
      const price = 1_200_000_000n;
      this.ev('tx.mined', minedMs, {
        action,
        tx: { hash, from: '0x' + '11'.repeat(20), gasUsed: String(gasUsed), effectiveGasPrice: price.toString(), feeWei: (BigInt(gasUsed) * price).toString(), status, block: 100 },
        chainTime,
        block: 100,
        ...fields
      });
    }
    return this;
  }
  raw(line: string): this {
    this.lines.push(line);
    return this;
  }
}

const h = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const ROOT = h(0xabc);
const P0 = h(0xf0);
const P1 = h(0xf1);
const OWNERS = ['0x' + 'aa'.repeat(20), '0x' + 'bb'.repeat(20), '0x' + 'cc'.repeat(20)];

export function writeFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });

  // Tier 1: two epochs; a challenge on epoch 1; a seq gap before epoch 2's finalization.
  const s = new Proc('settler', { context: 'settler', tier: 'tier1' });
  for (const [epoch, base, chain] of [['1', 10_000, 1000], ['2', 110_000, 2000]] as const) {
    s.ev('epoch.due', base, { epoch, chainTime: chain })
      .ev('o1.checked', base + 1000, { epoch, synced: false, boundary: chain, chainTime: chain - 5 })
      .ev('o1.checked', base + 1500, { epoch, synced: true, boundary: chain, chainTime: chain + 13 })
      .ev('snapshot.done', base + 2000, { epoch, records: 40, rawRecords: 42, members: 10, durationMs: 500 })
      .ev('root.computed', base + 2200, { epoch, root: ROOT, nodes: 10, members: 10, durationMs: 200 })
      .ev('tree.uploaded', base + 2300, { epoch, root: ROOT, treeURI: 'ipfs://t', leaves: 10, durationMs: 100 })
      .ev('tree.pinned', base + 2350, { epoch, treeURI: 'ipfs://t', durationMs: 50 })
      .tx('settle.post', h(epoch === '1' ? 0xa1 : 0xa4), base + 2400, base + 4000, epoch === '1' ? 150_000 : 152_000, { epoch }, chain + 20)
      .ev('settle.posted', base + 4100, { epoch, root: ROOT, txHash: h(0xa1) })
      .ev('epoch.posted', base + 4200, { epoch, root: ROOT, disputeWindowEndsAt: chain + 120, chainTime: chain + 20 });
    if (epoch === '1') {
      s.ev('challenge.detected', base + 5000, { epoch, node: OWNERS[0], role: h(1), openedAt: chain + 25, deadline: chain + 125, chainTime: chain + 27 })
        .tx('challenge.respond', h(0xa2), base + 5100, base + 5900, 61_000, { epoch }, chain + 30)
        .ev('challenge.answered', base + 6000, { epoch, node: OWNERS[0], role: h(1) });
    }
    s.ev('epoch.finalized', base + 10_000, { epoch, chainTime: chain + 130 }, { skipSeq: epoch === '2' ? 1 : 0 })
      .tx('bond.withdraw', h(epoch === '1' ? 0xa3 : 0xa5), base + 10_100, base + 11_000, 50_000, { epoch }, chain + 135)
      .ev('bond.withdrawn', base + 11_000, { epoch });
  }

  // Tier 2: three owners on the same Safe, each with its own context name.
  const owners = ['A', 'B', 'C'].map((x) => new Proc(`owner${x}`, { context: `owner${x}`, tier: 'tier2' }));
  const [a, b, c] = owners as [Proc, Proc, Proc];
  for (const o of owners) o.ev('epoch.due', 20_000 + owners.indexOf(o) * 300, { epoch: '1', chainTime: 1000 });
  // Round 0: proposed, one commit, dead (seen by A and B).
  a.ev('tier2.proposed', 21_000, { epoch: '1', round: '0', proposalId: P0, commitDeadline: 31, revealDeadline: 41 })
    .ev('tier2.committed', 22_000, { epoch: '1', round: '0', proposalId: P0, owner: OWNERS[0] })
    .ev('tier2.round_outcome', 42_000, { epoch: '1', round: '0', proposalId: P0, outcome: 'dead' });
  b.ev('tier2.round_outcome', 43_000, { epoch: '1', round: '0', proposalId: P0, outcome: 'dead' });
  // Round 1: everyone commits and reveals; A and B both record the publication; A and C sign; C executes.
  b.ev('tier2.proposed', 44_000, { epoch: '1', round: '1', proposalId: P1, commitDeadline: 54, revealDeadline: 64 });
  owners.forEach((o, i) => o.ev('tier2.committed', 45_000 + i * 1000, { epoch: '1', round: '1', proposalId: P1, owner: OWNERS[i] }));
  owners.forEach((o, i) => o.ev('tier2.revealed', 55_000 + i * 500, { epoch: '1', round: '1', proposalId: P1, owner: OWNERS[i], seen: 3 }));
  a.ev('tier2.published', 65_000, { epoch: '1', round: '1', proposalId: P1, root: ROOT, treeURI: 'ipfs://t2' });
  b.ev('tier2.published', 65_400, { epoch: '1', round: '1', proposalId: P1, root: ROOT, treeURI: 'ipfs://t2' });
  a.ev('tier2.signed', 66_000, { epoch: '1', round: '1', proposalId: P1, owner: OWNERS[0] });
  c.ev('tier2.signed', 66_500, { epoch: '1', round: '1', proposalId: P1, owner: OWNERS[2] })
    .tx('tier2.execute', h(0xb1), 67_000, 69_000, 255_000, { epoch: '1', round: '1' }, 1100)
    .ev('tier2.executed', 69_100, { epoch: '1', round: '1', proposalId: P1, signatures: 2 })
    .ev('tier2.round_outcome', 69_200, { epoch: '1', round: '1', proposalId: P1, outcome: 'agreed' });
  a.ev('settle.posted', 70_000, { epoch: '1', root: ROOT });
  c.ev('settle.posted', 69_500, { epoch: '1', root: ROOT });
  // An execute B sent that never got a receipt (the process was stopped).
  b.tx('tier2.execute', h(0xdead), 67_200, null, 0, { epoch: '1', round: '1' });
  // A executes the same settlement at the same moment; its transaction reverts.
  a.tx('tier2.execute', h(0xb2), 67_000, 69_000, 52_000, { epoch: '1', round: '1' }, 1100, 0);

  // Watcher: catches an omission, opens a challenge; plus two bad lines.
  const w = new Proc('watcher', { context: 'watch', tier: 'watcher' });
  w.ev('watch.root_seen', 80_000, { epoch: '3', root: ROOT, chainTime: 3020 })
    .ev('watch.recomputed', 81_000, { epoch: '3', postedRoot: ROOT, ourRoot: h(0xdef), agrees: false, treeAvailable: true, omitted: 1, durationMs: 900 })
    .ev('watch.divergence', 81_100, { epoch: '3', postedRoot: ROOT, ourRoot: h(0xdef), omitted: 1, postedAt: 3020, chainTime: 3042 })
    .tx('challenge.open', h(0xc1), 81_200, 83_000, 181_000, { epoch: '3' }, 3050)
    .ev('watch.challenge_opened', 83_100, { epoch: '3', node: OWNERS[1], role: h(1), bond: '1000000000000000' })
    .raw('{not json')
    .raw(JSON.stringify({ v: 1, type: 'made.up', runId: 'r1', process: 'watcher', seq: 99, wallMs: 1 }));

  const procs = [s, a, b, c, w];
  for (const p of procs) writeFileSync(join(dir, `r1.${p.name}.1.jsonl`), p.lines.join('\n') + '\n');
}
