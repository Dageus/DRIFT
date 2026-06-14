import { Signer, Provider, Contract } from 'ethers';
import { DriftFactory } from './modules/factory';
import { CoreModule } from './modules/core';
import { ReputationModule } from './modules/reputation';
import { GovernanceModule } from './modules/governance';
import { DriftSettler } from './settler';
import { LocalTrustStore } from './trust/LocalTrustStore';
import type { ITrustStore } from './trust/ITrustStore';
import type { IReputationEngine } from './engines/IReputationEngine';
import type { IAttestationProvider } from './providers/IAttestationProvider';
import type {
  ReputationOptions,
  ReputationResult,
  GlobalReputationOptions,
  GlobalReputationResult,
  LocalReputationOptions,
  LocalReputationResult,
  VotingPowerOptions
} from './types';
import { REPUTATION_ENGINES } from './engines/EnginesMapping';

export interface DriftConfig {
  coreAddress: string;
  factoryAddress: string;
  attestationProvider: IAttestationProvider;
  tokenAddress?: string;
  storageProvider?: ITrustStore;
}

/**
 * Unified DRIFT SDK entry point.
 *
 * Usage:
 *   const drift = new Drift(signer, {
 *     coreAddress: '0x...',
 *     factoryAddress: '0x...',
 *     attestationProvider: myAttestationProvider
 *   });
 *
 *   await drift.core.registerContext('my-context');
 *   await drift.governance.castVote(clientAddress, proposalId, true);
 *   await drift.reputation.settleReputation(...);
 */
export class Drift {
  // Modules — direct access, no .client. indirection
  public readonly core: CoreModule;
  public readonly reputation: ReputationModule;
  public readonly governance: GovernanceModule;
  public readonly factory: DriftFactory;
  public readonly settler?: DriftSettler;

  private readonly _config: DriftConfig;
  private readonly _provider: Provider;
  private _tokenAddress?: string;

  private _attestationProvider: IAttestationProvider;
  private _trustStore: ITrustStore;

  constructor(signerOrProvider: Signer | Provider, config: DriftConfig) {
    this._config = config;
    this._provider = (signerOrProvider as Signer).provider ?? (signerOrProvider as Provider);

    this._attestationProvider = config.attestationProvider;
    this._trustStore = config.storageProvider ?? new LocalTrustStore();

    // Direct module instantiation — one hop, not two
    this.core = new CoreModule(config.coreAddress, signerOrProvider);
    this.reputation = new ReputationModule(signerOrProvider);
    this.governance = new GovernanceModule(signerOrProvider);
    this.factory = new DriftFactory(config.factoryAddress, signerOrProvider);

    if ('signMessage' in signerOrProvider) {
      this.settler = new DriftSettler(signerOrProvider as Signer);
    }
  }

  // Reputation Router =========================================================

  public async getReputation<T extends ReputationOptions>(subject: string, options: T): Promise<ReputationResult<T>> {
    switch (options.mode) {
      case 'global':
        return (await this._getGlobalReputation(subject, options)) as ReputationResult<T>;
      case 'local':
        return (await this._getLocalReputation(subject, options)) as ReputationResult<T>;
      case 'voting':
        return (await this._getVotingPower(subject, options)) as ReputationResult<T>;
      default:
        throw new Error(`Drift: Unknown reputation mode: ${(options as any).mode}`);
    }
  }

  // Global ===================================================================

  private async _getGlobalReputation(
    subject: string,
    options: GlobalReputationOptions
  ): Promise<GlobalReputationResult> {
    const tokenAddress = await this._resolveTokenAddress();

    if (options.role) {
      const balance = await this.reputation.getReputationBalance(
        tokenAddress,
        subject,
        options.context,
        options.role
      );
      return { balance };
    }

    const defaultRoles = ['0x' + '00'.repeat(32)];

    const breakdown: Record<string, bigint> = {};
    let total = 0n;

    for (const role of defaultRoles) {
      try {
        const bal = await this.reputation.getReputationBalance(tokenAddress, subject, options.context, role);
        if (bal > 0n) {
          breakdown[role] = bal;
          total += bal;
        }
      } catch {
        // Role may not exist — skip
      }
    }

    return { balance: total, breakdown };
  }

  // Local =====================================================================

  private async _getLocalReputation(subject: string, options: LocalReputationOptions): Promise<LocalReputationResult> {
    const engine = options.engine ?? (await this._resolveDefaultEngine(options.context, options.viewer, options.schemaDef));

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

  // Voting ====================================================================

  private async _getVotingPower(subject: string, options: VotingPowerOptions): Promise<bigint> {
    return this.governance.getVotingPower(options.governanceClient, subject);
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
      throw new Error(`DRIFT SDK: Unknown on-chain algorithm '${algorithmLabel}'.`);
    }

    const weightsMap = await this._trustStore.getWeights(viewer);
    return engineFactory({
      schemaDefinition: schemaDef ?? 'uint256 score',
      weightResolver: (attester) => BigInt(weightsMap.get(attester.toLowerCase()) ?? 1)
    });
  }

  // Trust Weights =============================================================

  public async setTrust(viewer: string, attester: string, weight: number): Promise<void> {
    await this._trustStore.setWeight(viewer, attester, weight);
  }

  public async getTrustGraph(viewer: string): Promise<Map<string, number>> {
    return await this._trustStore.getWeights(viewer);
  }

  public get provider(): Provider {
    return this._provider;
  }
}
