import { Signer, Provider, Contract, Interface, AbiCoder, keccak256 } from 'ethers';
import SettlerArtifact from '../../../contracts/out/IDRIFTSettler.sol/IDRIFTSettler.json' with { type: 'json' };
import { handleContractError } from '../utils.js';

export class ReputationModule {
  private readonly _signer?: Signer;
  private readonly _runner: Signer | Provider;
  private readonly _interface: Interface;

  constructor(signerOrProvider: Signer | Provider) {
    this._runner = signerOrProvider;
    this._signer = 'signMessage' in signerOrProvider ? (signerOrProvider as Signer) : undefined;
    this._interface = new Interface(SettlerArtifact.abi);
  }

  private _requireSigner(): Signer {
    if (!this._signer) throw new Error('DRIFT SDK: Write operations require a connected signer.');
    return this._signer;
  }

  private _reputationClient(clientAddress: string): any {
    return new Contract(clientAddress, SettlerArtifact.abi, this._runner);
  }

  // Merkle Operations =========================================================

  /**
   * Posts a signed epoch root. `bondAmount` must equal the client's current `settlementBond`
   * (queryable via the client contract's `settlementBond()` view) — `postEpochRoot` is payable
   * and reverts with `InsufficientBond` if `msg.value` doesn't match exactly.
   */
  public async postEpochRoot(
    clientAddress: string,
    epoch: bigint,
    merkleRoot: string,
    treeURI: string,
    signature: string,
    bondAmount: bigint
  ): Promise<void> {
    try {
      const tx = await this._reputationClient(clientAddress)
        .connect(this._requireSigner())
        .postEpochRoot(epoch, merkleRoot, treeURI, signature, { value: bondAmount });
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async claimReputation(
    clientAddress: string,
    node: string,
    role: string,
    score: bigint,
    epoch: bigint,
    merkleProof: string[]
  ): Promise<void> {
    try {
      const tx = await this._reputationClient(clientAddress)
        .connect(this._requireSigner())
        .claimReputation(node, role, score, epoch, merkleProof);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async setTrustedSettler(clientAddress: string, newSettler: string): Promise<void> {
    try {
      const tx = await this._reputationClient(clientAddress)
        .connect(this._requireSigner())
        .setTrustedSettler(newSettler);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  // B1 — Non-inclusion disputes ===============================================

  /**
   * Opens a challenge claiming `missingNode` was admitted at `epoch`'s boundary but has no leaf
   * in that epoch's posted root. `bondAmount` must equal the client's current `challengeBond`.
   */
  public async challengeOmission(
    clientAddress: string,
    epoch: bigint,
    missingNode: string,
    bondAmount: bigint
  ): Promise<void> {
    try {
      const tx = await this._reputationClient(clientAddress)
        .connect(this._requireSigner())
        .challengeOmission(epoch, missingNode, { value: bondAmount });
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  /**
   * Defeats an open challenge by proving `node` does have a leaf in `epoch`'s root.
   * Permissionless — callable by anyone with the published tree data (see
   * `DriftSettler.generateChallengeResponse` for building `role`/`score`/`merkleProof`).
   */
  public async respondToChallenge(
    clientAddress: string,
    epoch: bigint,
    node: string,
    role: string,
    score: bigint,
    merkleProof: string[]
  ): Promise<void> {
    try {
      const tx = await this._reputationClient(clientAddress)
        .connect(this._requireSigner())
        .respondToChallenge(epoch, node, role, score, merkleProof);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  /**
   * Finalizes an unanswered challenge once its response window has elapsed: the settler's bond
   * is forfeited to the original challenger and the epoch root is rolled back for correction.
   * Permissionless trigger — still requires a connected signer to pay gas, but need not be the
   * original challenger.
   */
  public async claimUnansweredChallenge(clientAddress: string, epoch: bigint, node: string): Promise<void> {
    try {
      const tx = await this._reputationClient(clientAddress)
        .connect(this._requireSigner())
        .claimUnansweredChallenge(epoch, node);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  /**
   * Refunds a challenger's own bond for a challenge rendered moot by a *different* concurrent
   * challenge against the same epoch already invalidating its root.
   */
  public async reclaimMootChallenge(clientAddress: string, epoch: bigint, node: string): Promise<void> {
    try {
      const tx = await this._reputationClient(clientAddress)
        .connect(this._requireSigner())
        .reclaimMootChallenge(epoch, node);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  /**
   * Withdraws the settler's escrowed bond for an epoch that finalized cleanly (dispute + response
   * windows elapsed, no successful challenge). Callable by anyone; pays out to `trustedSettler`.
   */
  public async withdrawSettlementBond(clientAddress: string, epoch: bigint): Promise<void> {
    try {
      const tx = await this._reputationClient(clientAddress)
        .connect(this._requireSigner())
        .withdrawSettlementBond(epoch);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  // Read Operations ===========================================================

  public async getReputationBalance(
    tokenAddress: string,
    account: string,
    contextUID: string,
    role: string
  ): Promise<bigint> {
    try {
      const token = new Contract(
        tokenAddress,
        ['function balanceOf(address account, uint256 id) external view returns (uint256)'],
        this._runner
      );

      const tokenId = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [contextUID, role]));
      return BigInt(await token.balanceOf(account, tokenId));
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }
}
