// Shared fakes for the daemon job tests: a governance client, hot-wallet actions and a tree
// store, all in memory, with chain time set by the test.
import { DriftContractRevertError, DriftNotFoundError } from '@drift-network/sdk';
import type { EpochTree, IMerkleStore } from '@drift-network/sdk/merkle';
import type { ChallengeView, ClientActions, ClientChain, ClientState } from '../../src/daemon/chain.js';

export const revert = (name: string) => new DriftContractRevertError(name, name, {});

export const ZERO = '0x' + '00'.repeat(32);

/** A governance client held in memory; times are chain seconds. */
export class FakeChain implements ClientChain {
  now = 0n;
  bond = 100n;
  constructor(contextUID: string, trustedSettler: string) {
    this.s.contextUID = contextUID;
    this.s.trustedSettler = trustedSettler;
  }
  s: ClientState = {
    contextUID: '',
    currentEpoch: 0n,
    epochLength: 100n,
    epochAnchorTimestamp: 1000n,
    disputeWindow: 10n,
    responseWindow: 10n,
    trustedSettler: '',
    settlementBond: 1n
  };
  roots = new Map<bigint, string>();
  postedAt = new Map<bigint, bigint>();
  bonds = new Map<bigint, bigint>();
  open = new Map<bigint, bigint>();
  chs: ChallengeView[] = [];
  async state() { return { ...this.s }; }
  async headTimestamp() { return this.now; }
  async epochRoot(e: bigint) { return this.roots.get(e) ?? ZERO; }
  async epochPostedAt(e: bigint) { return this.postedAt.get(e) ?? 0n; }
  async epochBondAmount(e: bigint) { return this.bonds.get(e) ?? 0n; }
  async openChallengeCount(e: bigint) { return this.open.get(e) ?? 0n; }
  async challenges(e: bigint) { return this.chs.filter((c) => c.epoch === e); }
  async requiredChallengeBond() { return this.bond; }
  post(epoch: bigint, root: string, at: bigint) {
    this.s.currentEpoch = epoch;
    this.roots.set(epoch, root);
    this.postedAt.set(epoch, at);
    this.bonds.set(epoch, 1n);
  }
}

export class FakeActions implements ClientActions {
  challengesOpened: { epoch: bigint; node: string; role: string; bond: bigint }[] = [];
  challengeError?: Error;
  async challengeOmission(epoch: bigint, node: string, role: string, bond: bigint) {
    if (this.challengeError) throw this.challengeError;
    this.challengesOpened.push({ epoch, node, role, bond });
  }
  responses: { epoch: bigint; node: string; role: string; score: bigint; proof: string[] }[] = [];
  withdrawn: bigint[] = [];
  respondError?: Error;
  withdrawError?: Error;
  async respondToChallenge(epoch: bigint, node: string, role: string, score: bigint, proof: string[]) {
    if (this.respondError) throw this.respondError;
    this.responses.push({ epoch, node, role, score, proof });
  }
  async withdrawSettlementBond(epoch: bigint) {
    if (this.withdrawError) throw this.withdrawError;
    this.withdrawn.push(epoch);
  }
}

export class MemoryStore implements IMerkleStore {
  trees = new Map<string, EpochTree>();
  async saveTree(c: string, e: bigint, t: EpochTree) { this.trees.set(`${c}:${e}`, t); }
  async loadTree(c: string, e: bigint) {
    const t = this.trees.get(`${c}:${e}`);
    if (!t) throw new DriftNotFoundError('missing');
    return t;
  }
  async loadLeaf(): Promise<string[]> { throw new Error('unused'); }
  async loadLeaves(): Promise<string[][]> { throw new Error('unused'); }
}

