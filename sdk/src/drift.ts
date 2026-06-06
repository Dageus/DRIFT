import { Signer, Provider, Contract } from 'ethers';
import { DriftClient, DriftConfig as DriftClientConfig } from './client';
import { DriftSettler } from './settler';
import { DriftFactory } from './factory';
import { EASProvider } from './providers/EAS';
import { LocalTrustStore } from './trust/LocalTrustStore';
import { EigenTrustEngine } from './engines/EigenTrustEngine';
import { WeightedLocalEngine } from './engines/WeightedLocalEngine';
import type { IReputationEngine } from './engines/IReputationEngine';
import type { IAttestationProvider } from './providers/IAttestationProvider';

// Public Configuration ========================================================

export interface DriftConfig {
  /** DRIFTCore proxy address */
  coreAddress: string;
  /** DRIFTFactory address */
  factoryAddress: string;
  /** EAS GraphQL endpoint for the target chain */
  easGraphqlUrl: string;
  /** Optional: token address (auto-resolved from Core if omitted) */
  tokenAddress?: string;
  /** Optional: injected trust store. Defaults to LocalTrustStore */
  storageProvider?: LocalTrustStore;
  /** Optional: injected attestation provider. Defaults to EASProvider */
  attestationProvider?: IAttestationProvider;
}

// Reputation Query Options ====================================================

export interface GlobalReputationOptions {
  mode: 'global';
  /** Context UID (bytes32 hex) */
  context: string;
  /** Role identifier (bytes32 hex). If omitted, sums across all roles. */
  role?: string;
}

export interface LocalReputationOptions {
  mode: 'local';
  /** Context UID (bytes32 hex) */
  context: string;
  /** The viewer whose trust graph to use (address) */
  viewer: string;
  /** EAS schema UID to query */
  schemaUID: string;
  /** ABI type definition for decoding attestation data. Default: "uint256 score" */
  schemaDef?: string;
  /** Optional: override the default engine (EigenTrust + local weights) */
  engine?: IReputationEngine;
}

export interface VotingPowerOptions {
  mode: 'voting';
  /** Governance client contract address */
  governanceClient: string;
}

export type ReputationOptions =
  | GlobalReputationOptions
  | LocalReputationOptions
  | VotingPowerOptions;

// Result Types ================================================================

export interface GlobalReputationResult {
  /** ERC-1155 token balance for the requested context+role */
  balance: bigint;
  /** Breakdown per role (only present when no specific role requested) */
  breakdown?: Record<string, bigint>;
}

export interface LocalReputationResult {
  /** Computed subjective score (0-10000 scaled) */
  score: bigint;
  /** Number of attestations considered */
  attestationsUsed: number;
  /** Engine that produced the score */
  engine: string;
}

export type ReputationResult<T extends ReputationOptions> =
  T extends GlobalReputationOptions ? GlobalReputationResult :
  T extends LocalReputationOptions ? LocalReputationResult :
  T extends VotingPowerOptions ? bigint :
  never;

// DRIFT SDK ===================================================================

/**
 * Unified DRIFT SDK entry point.
 *
 * Provides intent-based reputation queries:
 *   - mode: "global"  → on-chain ERC-1155 balance (objective)
 *   - mode: "local"   → attestation-weighted local score (subjective)
 *   - mode: "voting"  → governance voting power
 *
 * Usage:
 *   const drift = new Drift(signer, {
 *     coreAddress: '0x...',
 *     factoryAddress: '0x...',
 *     easGraphqlUrl: 'https://sepolia.easscan.org/graphql'
 *   });
 *
 *   // Global (on-chain)
 *   const rep = await drift.getReputation("0xSubject...", {
 *     mode: "global", context: "0xContextUID...", role: "0xRole..."
 *   });
 *
 *   // Local (subjective)
 *   const rep = await drift.getReputation("0xSubject...", {
 *     mode: "local", context: "0xContextUID...", viewer: "0xMe...",
 *     schemaUID: "0xSchema..."
 *   });
 */
export class Drift {
  public readonly client: DriftClient;
  public readonly factory: DriftFactory;
  public readonly settler?: DriftSettler;

  private readonly _config: DriftConfig;
  private readonly _provider: Provider;
  private _tokenAddress?: string;
  private _easProvider?: EASProvider;
  private _trustStore?: LocalTrustStore;

  constructor(signerOrProvider: Signer | Provider, config: DriftConfig) {
    this._config = config;
    this._provider = (signerOrProvider as Signer).provider ?? (signerOrProvider as Provider);

    // Validate required config
    if (!config.easGraphqlUrl) {
      throw new Error('Drift: easGraphqlUrl is required in DriftConfig');
    }

    const clientConfig: DriftClientConfig = {
      coreAddress: config.coreAddress,
      factoryAddress: config.factoryAddress,
    };

    this.client = new DriftClient(clientConfig, signerOrProvider);
    this.factory = new DriftFactory(config.factoryAddress, signerOrProvider);

    if ('signMessage' in signerOrProvider) {
      this.settler = new DriftSettler(signerOrProvider as Signer);
    }
  }

  // Reputation Router =========================================================

  /**
   * Unified reputation query — routes to the correct backend based on mode.
   *
   * @param subject  The address being evaluated
   * @param options  Routing configuration (global | local | voting)
   * @returns Type-specific result based on mode
   */
  public async getReputation<T extends ReputationOptions>(
    subject: string,
    options: T
  ): Promise<ReputationResult<T>> {
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

  //  Global ===================================================================

  private async _getGlobalReputation(
    subject: string,
    options: GlobalReputationOptions
  ): Promise<GlobalReputationResult> {
    const tokenAddress = await this._resolveTokenAddress();

    if (options.role) {
      // Specific role query
      const balance = await this.client.getReputationBalance(
        tokenAddress,
        subject,
        options.context,
        options.role
      );
      return { balance };
    }

    // No role specified — query ALL roles by enumerating known role hashes
    // This requires the caller to have registered roles or we use a default set
    const defaultRoles = [
      '0x' + '00'.repeat(32), // bytes32(0) = base role
    ];

    const breakdown: Record<string, bigint> = {};
    let total = 0n;

    for (const role of defaultRoles) {
      try {
        const bal = await this.client.getReputationBalance(
          tokenAddress, subject, options.context, role
        );
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

  private async _getLocalReputation(
    subject: string,
    options: LocalReputationOptions
  ): Promise<LocalReputationResult> {
    // Resolve or create dependencies (lazy initialization)
    const easProvider = this._config.attestationProvider ?? this._resolveEASProvider();
    const trustStore = this._config.storageProvider ?? this._resolveTrustStore();
    const engine = options.engine ?? this._resolveDefaultEngine(options.viewer, options.schemaDef);

    // Fetch all attestations about the subject
    const records = await easProvider.fetchUserRecords(options.context, subject);

    if (records.length === 0) {
      return { score: 0n, attestationsUsed: 0, engine: engine.constructor.name };
    }

    // Filter to requested schema
    const filtered = records.filter((r) => r.schemaUID === options.schemaUID);

    // Compute score
    const score = engine.calculateScore(filtered);

    return {
      score,
      attestationsUsed: filtered.length,
      engine: engine.constructor.name,
    };
  }

  // Voting ====================================================================

  private async _getVotingPower(
    subject: string,
    options: VotingPowerOptions
  ): Promise<bigint> {
    return this.client.getVotingPower(options.governanceClient, subject);
  }

  // Resolvers =================================================================

  private async _resolveTokenAddress(): Promise<string> {
    if (this._tokenAddress) return this._tokenAddress;
    if (this._config.tokenAddress) {
      this._tokenAddress = this._config.tokenAddress;
      return this._tokenAddress;
    }
    // Query from Core
    const core = new Contract(
      this._config.coreAddress,
      ['function driftToken() external view returns (address)'],
      this._provider
    );
    this._tokenAddress = await core.driftToken();
    return this._tokenAddress;
  }

  private _resolveEASProvider(): EASProvider {
    if (!this._easProvider) {
      throw new Error(
        'Drift: No attestationProvider configured and easGraphqlUrl is not set. ' +
        'Provide one in DriftConfig or pass a custom provider.'
      );
    }
    return this._easProvider;
  }

  private _resolveTrustStore(): LocalTrustStore {
    if (!this._trustStore) {
      this._trustStore = new LocalTrustStore();
    }
    return this._trustStore;
  }

  private _resolveDefaultEngine(
    viewer: string,
    schemaDef?: string
  ): IReputationEngine {
    const trustStore = this._resolveTrustStore();
    const weights = trustStore.getWeights(viewer);

    const peerWeights: Record<string, bigint> = {};
    for (const [addr, w] of weights) {
      peerWeights[addr] = BigInt(w);
    }

    if (Object.keys(peerWeights).length > 0) {
      return new WeightedLocalEngine({
        peerWeights,
        defaultWeight: 100n,
        schemaDefinition: schemaDef ?? 'uint256 score',
      });
    }

    return new EigenTrustEngine({
      schemaDefinition: schemaDef ?? 'uint256 score',
      weightResolver: () => 1n,
    });
  }

  // Set Trust Weights =========================================================

  /**
   * Set the viewing user's trust weight for a specific attester.
   * Persists to localStorage (or injected storageProvider).
   */
  public setTrust(viewer: string, attester: string, weight: number): void {
    const store = this._config.storageProvider ?? this._resolveTrustStore();
    store.setWeight(viewer, attester, weight);
  }

  /**
   * Get the viewing user's current trust weights.
   */
  public getTrustGraph(viewer: string): Map<string, number> {
    const store = this._config.storageProvider ?? this._resolveTrustStore();
    return store.getWeights(viewer);
  }
}
