import { Contract, Interface, type Provider } from 'ethers';
import { ReputationModule } from '@drift-network/sdk';
import type { Signer } from 'ethers';

/** The governance client's settlement state, read in one round of calls. */
export interface ClientState {
  contextUID: string;
  currentEpoch: bigint;
  epochLength: bigint;
  epochAnchorTimestamp: bigint;
  disputeWindow: bigint;
  responseWindow: bigint;
  trustedSettler: string;
  settlementBond: bigint;
}

export interface ChallengeView {
  epoch: bigint;
  node: string;
  role: string;
  openedAt: bigint;
  /** Last timestamp at which respondToChallenge is accepted: openedAt + responseWindow. */
  deadline: bigint;
  resolved: boolean;
}

/** Read side of a governance client, as the daemon's jobs need it. Faked in unit tests. */
export interface ClientChain {
  state(): Promise<ClientState>;
  /** Timestamp of the latest block: the clock the contract's windows are measured against. */
  headTimestamp(): Promise<bigint>;
  epochRoot(epoch: bigint): Promise<string>;
  epochPostedAt(epoch: bigint): Promise<bigint>;
  epochBondAmount(epoch: bigint): Promise<bigint>;
  openChallengeCount(epoch: bigint): Promise<bigint>;
  /** Every (node, role) challenge ever opened against `epoch`, with its current on-chain state. */
  challenges(epoch: bigint): Promise<ChallengeView[]>;
}

/** Write side, sent from the hot wallet. Faked in unit tests. */
export interface ClientActions {
  respondToChallenge(epoch: bigint, node: string, role: string, score: bigint, proof: string[]): Promise<void>;
  withdrawSettlementBond(epoch: bigint): Promise<void>;
}

const ZERO_ROOT = '0x' + '00'.repeat(32);

/**
 * Mirrors the contract's `_isFinalized`: a root is posted, the dispute window has passed, and no
 * challenge is open. `now` must be chain time.
 */
export async function isFinalized(chain: ClientChain, state: ClientState, epoch: bigint, now: bigint): Promise<boolean> {
  const [root, postedAt, open] = await Promise.all([chain.epochRoot(epoch), chain.epochPostedAt(epoch), chain.openChallengeCount(epoch)]);
  return root !== ZERO_ROOT && now > postedAt + state.disputeWindow && open === 0n;
}

const CLIENT_IFACE = new Interface([
  'function contextUID() view returns (bytes32)',
  'function currentEpoch() view returns (uint256)',
  'function epochLength() view returns (uint256)',
  'function epochAnchorTimestamp() view returns (uint256)',
  'function disputeWindow() view returns (uint256)',
  'function responseWindow() view returns (uint256)',
  'function trustedSettler() view returns (address)',
  'function settlementBond() view returns (uint256)',
  'function epochRoots(uint256) view returns (bytes32)',
  'function epochPostedAtTimestamp(uint256) view returns (uint256)',
  'function epochBondAmount(uint256) view returns (uint256)',
  'function openChallengeCount(uint256) view returns (uint256)',
  'function challenges(uint256 epoch, address node, bytes32 role) view returns (uint256 openedAtTimestamp, uint256 bond, address challenger, bool resolved)',
  'event ChallengeOpened(bytes32 indexed contextUID, uint256 indexed epoch, address indexed missingNode, bytes32 role, address challenger, uint256 bond)'
]);

/** ClientChain over an ethers provider. `fromBlock` bounds the ChallengeOpened log scan. */
export class EthersClientChain implements ClientChain {
  private readonly c: Contract;
  private contextUID?: string;

  constructor(
    private readonly provider: Provider,
    readonly client: string,
    private readonly fromBlock = 0
  ) {
    this.c = new Contract(client, CLIENT_IFACE, provider);
  }

  async state(): Promise<ClientState> {
    const c = this.c;
    const [contextUID, currentEpoch, epochLength, epochAnchorTimestamp, disputeWindow, responseWindow, trustedSettler, settlementBond] =
      (await Promise.all([
        c.contextUID!(),
        c.currentEpoch!(),
        c.epochLength!(),
        c.epochAnchorTimestamp!(),
        c.disputeWindow!(),
        c.responseWindow!(),
        c.trustedSettler!(),
        c.settlementBond!()
      ])) as [string, bigint, bigint, bigint, bigint, bigint, string, bigint];
    this.contextUID = contextUID;
    return { contextUID, currentEpoch, epochLength, epochAnchorTimestamp, disputeWindow, responseWindow, trustedSettler, settlementBond };
  }

  async headTimestamp(): Promise<bigint> {
    const block = await this.provider.getBlock('latest');
    if (!block) throw new Error('latest block unavailable');
    return BigInt(block.timestamp);
  }

  async epochRoot(epoch: bigint): Promise<string> {
    return (await this.c.epochRoots!(epoch)) as string;
  }
  async epochPostedAt(epoch: bigint): Promise<bigint> {
    return BigInt(await this.c.epochPostedAtTimestamp!(epoch));
  }
  async epochBondAmount(epoch: bigint): Promise<bigint> {
    return BigInt(await this.c.epochBondAmount!(epoch));
  }
  async openChallengeCount(epoch: bigint): Promise<bigint> {
    return BigInt(await this.c.openChallengeCount!(epoch));
  }

  async challenges(epoch: bigint): Promise<ChallengeView[]> {
    const contextUID = this.contextUID ?? (await this.state()).contextUID;
    const responseWindow = BigInt(await this.c.responseWindow!());
    const logs = await this.provider.getLogs({
      address: this.client,
      topics: CLIENT_IFACE.encodeFilterTopics(CLIENT_IFACE.getEvent('ChallengeOpened')!, [contextUID, epoch]),
      fromBlock: this.fromBlock,
      toBlock: 'latest'
    });
    // A pair's challenge slot is reused after a rollback and repost, so several events can name
    // the same pair; the view holds the current state.
    const pairs = new Map<string, { node: string; role: string }>();
    for (const log of logs) {
      const parsed = CLIENT_IFACE.parseLog(log);
      if (!parsed) continue;
      const node = (parsed.args.missingNode as string).toLowerCase();
      const role = (parsed.args.role as string).toLowerCase();
      pairs.set(`${node}:${role}`, { node, role });
    }
    return Promise.all(
      [...pairs.values()].map(async ({ node, role }) => {
        const v = (await this.c.challenges!(epoch, node, role)) as [bigint, bigint, string, boolean];
        const openedAt = BigInt(v[0]);
        return { epoch, node, role, openedAt, deadline: openedAt + responseWindow, resolved: v[3] };
      })
    );
  }
}

/** ClientActions through the SDK's ReputationModule, so reverts decode to DriftContractRevertError. */
export class ReputationClientActions implements ClientActions {
  private readonly m: ReputationModule;
  constructor(
    hotWallet: Signer,
    private readonly client: string
  ) {
    this.m = new ReputationModule(hotWallet);
  }
  respondToChallenge(epoch: bigint, node: string, role: string, score: bigint, proof: string[]): Promise<void> {
    return this.m.respondToChallenge(this.client, epoch, node, role, score, proof);
  }
  withdrawSettlementBond(epoch: bigint): Promise<void> {
    return this.m.withdrawSettlementBond(this.client, epoch);
  }
}
