import { Contract, Interface, type Provider } from 'ethers';
import type { ITreeTransport } from './ITreeTransport.js';
import type { EpochTree } from './epochTree.js';
import { DriftNotFoundError } from '../errors.js';

const CLIENT_IFACE = new Interface([
  'function contextUID() view returns (bytes32)',
  'function epochRoots(uint256) view returns (bytes32)',
  'event EpochRootPosted(bytes32 indexed contextUID, uint256 indexed epoch, bytes32 merkleRoot, string treeURI)'
]);

const ZERO_ROOT = '0x' + '00'.repeat(32);

export interface ResolvedEpochTree {
  tree: EpochTree;
  treeURI: string;
  root: string;
}

/**
 * Goes from chain state to a checked tree for (client, epoch): reads the committed root, finds the
 * `EpochRootPosted` events for that epoch, and fetches the tree each one points at, newest first,
 * until one matches the committed root. Newest first because an epoch that was rolled back and
 * re-posted has several events, and only the one whose root is still committed counts.
 *
 * `fromBlock` bounds the log query; pass the client's deployment block on RPCs that limit ranges.
 */
export async function resolveEpochTree(
  provider: Provider,
  client: string,
  epoch: bigint,
  transport: ITreeTransport,
  opts: { fromBlock?: number } = {}
): Promise<ResolvedEpochTree> {
  const c = new Contract(client, CLIENT_IFACE, provider);
  const [contextUID, root] = (await Promise.all([c.contextUID!(), c.epochRoots!(epoch)])) as [string, string];
  if (root === ZERO_ROOT) {
    throw new DriftNotFoundError(`DRIFT SDK: no root is committed for epoch ${epoch} on ${client} (never posted, or rolled back).`);
  }

  const event = CLIENT_IFACE.getEvent('EpochRootPosted')!;
  const logs = await provider.getLogs({
    address: client,
    topics: CLIENT_IFACE.encodeFilterTopics(event, [contextUID, epoch]),
    fromBlock: opts.fromBlock ?? 0,
    toBlock: 'latest'
  });

  const failures: string[] = [];
  for (const log of [...logs].reverse()) {
    const parsed = CLIENT_IFACE.parseLog(log);
    if (!parsed || (parsed.args.merkleRoot as string).toLowerCase() !== root.toLowerCase()) continue;
    const treeURI = parsed.args.treeURI as string;
    try {
      const tree = await transport.fetchTree(treeURI, { root, contextUID, epoch });
      return { tree, treeURI, root };
    } catch (err) {
      failures.push(`${treeURI}: ${(err as Error).message}`);
    }
  }
  throw new DriftNotFoundError(
    `DRIFT SDK: no retrievable tree matches the committed root ${root} for epoch ${epoch}` +
      (failures.length ? `; tried ${failures.join('; ')}` : ' (no matching EpochRootPosted event)') +
      '.'
  );
}
