import { Signer, Provider, Contract } from 'ethers';
import { DriftFactory } from './modules/factory.js';
import { CoreModule } from './modules/core.js';
import { ReputationModule } from './modules/reputation.js';
import { GovernanceModule } from './modules/governance.js';
import { DriftSettler } from './settler.js';
import type { ProofOfStatePayload } from './settler.js';
import { LocalTrustStore } from './trust/LocalTrustStore.js';
import { NodeTrustStore } from './trust/NodeTrustStore.js';
import type { ITrustStore } from './trust/ITrustStore.js';
import type { IReputationEngine } from './engines/IReputationEngine.js';
import type { IAttestationProvider } from './providers/IAttestationProvider.js';
import type {
  ReputationOptions,
  ReputationResult,
  GlobalReputationOptions,
  GlobalReputationResult,
  LocalReputationOptions,
  LocalReputationResult,
  VotingPowerOptions
} from './types.js';
import { REPUTATION_ENGINES } from './engines/EnginesMapping.js';
import { isSigner, errorMessage } from './utils.js';
import { DriftConfigError, DriftValidationError } from './errors.js';

export interface DriftConfig {
  coreAddress: string;
  factoryAddress: string;
  attestationProvider: IAttestationProvider;
  tokenAddress?: string;
  storageProvider?: ITrustStore;
  /**
   * Called when a non-fatal per-role reputation lookup fails inside `getReputation({ mode:
   * 'global' })` (one bad role shouldn't abort the whole balance breakdown). Defaults to
   * `console.warn` — pass your own to route this into structured logging, or a no-op to silence
   * it entirely.
   */
  onWarning?: (message: string, error: unknown) => void;
}

/**
 * Main SDK entry point. Wraps DRIFTCore, the client factory, and a governance client's
 * settlement/voting surface behind `core`/`factory`/`reputation`/`governance`, and adds
 * `getReputation` as a single router across all three query modes. `settler` is only populated
 * when constructed with a `Signer` (epoch settlement requires signing, not just reading).
 */
export class Drift {
  public readonly core: CoreModule;
  public readonly reputation: ReputationModule;
  public readonly governance: GovernanceModule;
  public readonly factory: DriftFactory;
  public readonly settler?: DriftSettler;

  private readonly _config: DriftConfig;
  private readonly _provider: Provider;
  private readonly _onWarning: (message: string, error: unknown) => void;
  private _tokenAddress?: string;

  private _attestationProvider: IAttestationProvider;
  private _trustStore: ITrustStore;

  constructor(signerOrProvider: Signer | Provider, config: DriftConfig) {
    this._config = config;
    this._onWarning = config.onWarning ?? ((message) => console.warn(message));

    if (isSigner(signerOrProvider)) {
      if (!signerOrProvider.provider) {
        throw new DriftConfigError(
          'DRIFT SDK: Signer must be connected to a provider (e.g. wallet.connect(provider)).'
        );
      }
      this._provider = signerOrProvider.provider;
    } else {
      this._provider = signerOrProvider;
    }

    this._attestationProvider = config.attestationProvider;
    // A7: `localStorage` (LocalTrustStore's backing store) does not exist under Node, where it
    // would silently no-op on every read/write. Fall back to a filesystem-backed store there so
    // server-side SDK use persists trust weights instead of losing them.
    this._trustStore =
      config.storageProvider ?? (typeof localStorage !== 'undefined' ? new LocalTrustStore() : new NodeTrustStore());

    this.core = new CoreModule(config.coreAddress, signerOrProvider);
    this.reputation = new ReputationModule(signerOrProvider);
    this.governance = new GovernanceModule(signerOrProvider);
    this.factory = new DriftFactory(config.factoryAddress, signerOrProvider);

    if (isSigner(signerOrProvider)) {
      this.settler = new DriftSettler(signerOrProvider);
    }
  }

  // Reputation Router =========================================================

  /**
   * Single entry point for all three reputation query modes:
   *  - `{ mode: 'global' }`  — on-chain ERC-1155 balance (optionally one role, else all roles summed)
   *  - `{ mode: 'local' }`   — off-chain subjective score from a viewer's trust graph
   *  - `{ mode: 'voting' }`  — Merkle-proven voting power for a governance client
   * The return type is inferred from `options.mode` (see `ReputationResult`).
   */
  public async getReputation<T extends ReputationOptions>(subject: string, options: T): Promise<ReputationResult<T>> {
    switch (options.mode) {
      case 'global':
        return (await this._getGlobalReputation(subject, options)) as ReputationResult<T>;
      case 'local':
        return (await this._getLocalReputation(subject, options)) as ReputationResult<T>;
      case 'voting':
        return (await this._getVotingPower(subject, options)) as ReputationResult<T>;
      default: {
        const unknownMode: string = (options as { mode: string }).mode;
        throw new DriftValidationError(`DRIFT SDK: Unknown reputation mode: ${unknownMode}`);
      }
    }
  }

  // Global Reputation =========================================================

  private async _getGlobalReputation(
    subject: string,
    options: GlobalReputationOptions
  ): Promise<GlobalReputationResult> {
    const tokenAddress = await this._resolveTokenAddress();
    const clientAddress = await this.core.getContextClient(options.context);

    // If a specific role is requested, return just that balance.
    if (options.role) {
      const balance = await this.reputation.getReputationBalance(tokenAddress, subject, options.context, options.role);
      return { balance };
    }

    // Otherwise, query all active roles and sum.
    const roles = await this.governance.getActiveRoles(clientAddress);
    const breakdown: Record<string, bigint> = {};
    let total = 0n;

    for (const role of roles) {
      try {
        const bal = await this.reputation.getReputationBalance(tokenAddress, subject, options.context, role);
        if (bal > 0n) {
          breakdown[role] = bal;
          total += bal;
        }
      } catch (err) {
        this._onWarning(`DRIFT SDK: Failed to fetch reputation balance for role ${role}: ${errorMessage(err)}`, err);
      }
    }

    return { balance: total, breakdown };
  }

  // Local Reputation ==========================================================

  private async _getLocalReputation(subject: string, options: LocalReputationOptions): Promise<LocalReputationResult> {
    const engine =
      options.engine ?? (await this._resolveDefaultEngine(options.context, options.viewer, options.schemaDef));

    const records = await this._attestationProvider.fetchUserRecords(options.context, subject);

    if (records.length === 0) {
      return { score: 0n, attestationsUsed: 0, engine: engine.constructor.name };
    }

    const filtered = records.filter((r) => r.schemaUID === options.schemaUID);
    const score = engine.calculateScore(filtered);

    return {
      score,
      attestationsUsed: filtered.length,
      engine: engine.constructor.name
    };
  }

  // Voting Power ==============================================================

  private async _getVotingPower(subject: string, options: VotingPowerOptions): Promise<bigint> {
    const opts = options as VotingPowerOptions & {
      epoch?: bigint;
      payload?: ProofOfStatePayload;
    };

    if (!opts.epoch || !opts.payload) {
      throw new DriftValidationError(
        'DRIFT SDK: Voting power query requires Proof-of-State parameters. ' +
          'Provide `epoch` (the snapshot epoch) and `payload` (the Merkle proof arrays).'
      );
    }

    return this.governance.simulateVotingPower(options.governanceClient, subject, opts.epoch, opts.payload);
  }

  // Resolvers =================================================================

  private async _resolveTokenAddress(): Promise<string> {
    if (this._tokenAddress) return this._tokenAddress;
    if (this._config.tokenAddress) {
      this._tokenAddress = this._config.tokenAddress;
      return this._tokenAddress;
    }
    const core = new Contract(
      this._config.coreAddress,
      ['function driftToken() external view returns (address)'],
      this._provider
    );
    this._tokenAddress = await core.driftToken();
    return this._tokenAddress!;
  }

  private async _resolveDefaultEngine(
    contextUID: string,
    viewer: string,
    schemaDef?: string
  ): Promise<IReputationEngine> {
    const clientAddress = await this.core.getContextClient(contextUID);
    const clientContract = new Contract(
      clientAddress,
      ['function reputationAlgorithm() external view returns (string)'],
      this.core.contract.runner
    );
    const algorithmLabel = await clientContract.reputationAlgorithm();

    const engineFactory = REPUTATION_ENGINES[algorithmLabel];
    if (!engineFactory) {
      throw new DriftConfigError(`DRIFT SDK: Unknown on-chain algorithm '${algorithmLabel}'.`);
    }

    const weightsMap = await this._trustStore.getWeights(viewer);
    return engineFactory({
      schemaDefinition: schemaDef ?? 'uint256 score',
      weightResolver: (attester) => BigInt(weightsMap.get(attester.toLowerCase()) ?? 1)
    });
  }

  // Trust Weights =============================================================

  /** Sets `viewer`'s subjective trust weight (0-10000) for `attester`. Feeds `{ mode: 'local' }`
   *  reputation queries; persisted via the configured `storageProvider` (or the platform default). */
  public async setTrust(viewer: string, attester: string, weight: number): Promise<void> {
    await this._trustStore.setWeight(viewer, attester, weight);
  }

  /** Returns `viewer`'s full trust graph as a map of lowercase attester address to weight. */
  public async getTrustGraph(viewer: string): Promise<Map<string, number>> {
    return await this._trustStore.getWeights(viewer);
  }

  public get provider(): Provider {
    return this._provider;
  }
}
