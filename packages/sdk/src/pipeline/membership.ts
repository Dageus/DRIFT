import { Contract, Interface, type Log, type Provider } from 'ethers';
import type { JoinTimes } from '../membership.js';
import type { EpochMember } from '../engines/epoch/protocol.js';

const CORE_IFACE = new Interface([
  'event NodeRegistered(bytes32 indexed contextUID, address indexed node)',
  'event NodeDeregistered(bytes32 indexed contextUID, address indexed node)',
  'event RoleAssigned(bytes32 indexed contextUID, address indexed node, bytes32 role)',
  'function nodeBannedAt(bytes32 contextUID, address node) view returns (uint256)',
  'function nodeHeldRoleAt(bytes32 contextUID, address node, bytes32 role, uint256 timestamp) view returns (bool)'
]);

export interface BoundaryMembership {
  /** Members at the boundary and the time each joined (its registration in effect then). */
  joinedAt: JoinTimes;
  /** Every (node, role) pair held at the boundary, in canonical order: one leaf each. */
  members: EpochMember[];
}

/** Block timestamps, fetched once per block. */
class BlockClock {
  private readonly cache = new Map<number, Promise<bigint>>();
  constructor(private readonly provider: Provider) {}
  at(blockNumber: number): Promise<bigint> {
    let ts = this.cache.get(blockNumber);
    if (!ts) {
      ts = this.provider.getBlock(blockNumber).then((b) => {
        if (!b) throw new Error(`block ${blockNumber} not found`);
        return BigInt(b.timestamp);
      });
      this.cache.set(blockNumber, ts);
    }
    return ts;
  }
}

const byChainOrder = (a: Log, b: Log) => a.blockNumber - b.blockNumber || a.index - b.index;

async function logsUpTo(
  provider: Provider,
  clock: BlockClock,
  core: string,
  event: string,
  contextUID: string,
  boundary: bigint,
  fromBlock: number
): Promise<Log[]> {
  const logs = await provider.getLogs({
    address: core,
    topics: CORE_IFACE.encodeFilterTopics(CORE_IFACE.getEvent(event)!, [contextUID]),
    fromBlock,
    toBlock: 'latest'
  });
  const stamps = await Promise.all(logs.map((l) => clock.at(l.blockNumber)));
  return logs.filter((_, i) => stamps[i]! <= boundary).sort(byChainOrder);
}

/**
 * Reconstructs a context's membership at `boundary` (t_E) from DRIFTCore's logs and views.
 *
 * Members: replaying NodeRegistered and NodeDeregistered up to the boundary gives, for each node,
 * whether it was registered then and since when. The core's `nodeRegisteredAt` view cannot serve:
 * it keeps only the latest registration and survives deregistration, so it misreports a node that
 * left before the boundary or re-registered after it. A node banned at or before the boundary is
 * excluded (`nodeBannedAt`; bans are permanent, so the view is exact).
 *
 * Pairs: candidates are RoleAssigned events up to the boundary, kept when `nodeHeldRoleAt` holds
 * and the node is a member. That is the predicate challengeOmission admits disputes for, so every
 * challengeable pair gets a leaf. The view is conservative after a later reassignment (A6), which
 * challengeOmission shares, so such an omission cannot be challenged either.
 *
 * Reads are deterministic for any caller once the boundary is final (O1): only logs from blocks at
 * or before the boundary count, and the views take the boundary as their reference time.
 */
export async function loadBoundaryMembership(
  provider: Provider,
  core: string,
  contextUID: string,
  boundary: bigint,
  opts: { fromBlock?: number } = {}
): Promise<BoundaryMembership> {
  const clock = new BlockClock(provider);
  const fromBlock = opts.fromBlock ?? 0;
  const [registered, deregistered, assigned] = await Promise.all([
    logsUpTo(provider, clock, core, 'NodeRegistered', contextUID, boundary, fromBlock),
    logsUpTo(provider, clock, core, 'NodeDeregistered', contextUID, boundary, fromBlock),
    logsUpTo(provider, clock, core, 'RoleAssigned', contextUID, boundary, fromBlock)
  ]);

  const state = new Map<string, bigint | null>();
  for (const log of [...registered, ...deregistered].sort(byChainOrder)) {
    const parsed = CORE_IFACE.parseLog(log)!;
    const node = (parsed.args.node as string).toLowerCase();
    state.set(node, parsed.name === 'NodeRegistered' ? await clock.at(log.blockNumber) : null);
  }

  const c = new Contract(core, CORE_IFACE, provider);
  const joinedAt: JoinTimes = new Map();
  await Promise.all(
    [...state].map(async ([node, since]) => {
      if (since === null || since === undefined) return;
      const bannedAt = BigInt(await c.nodeBannedAt!(contextUID, node));
      if (bannedAt !== 0n && bannedAt <= boundary) return;
      joinedAt.set(node, since);
    })
  );

  const candidates = new Map<string, EpochMember>();
  for (const log of assigned) {
    const parsed = CORE_IFACE.parseLog(log)!;
    const node = (parsed.args.node as string).toLowerCase();
    const role = (parsed.args.role as string).toLowerCase();
    if (joinedAt.has(node)) candidates.set(`${node}:${role}`, { node, role });
  }
  const held = await Promise.all(
    [...candidates.values()].map((m) => c.nodeHeldRoleAt!(contextUID, m.node, m.role, boundary) as Promise<boolean>)
  );
  const members = [...candidates.values()]
    .filter((_, i) => held[i])
    .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : a.role < b.role ? -1 : a.role > b.role ? 1 : 0));

  return { joinedAt, members };
}
