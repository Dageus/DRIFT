import { Signer, Provider, Contract } from 'ethers';
import { IAttestationProvider } from './providers/IAttestationProvider';
import { IReputationEngine } from './engines/IReputationEngine';
import { ENGINES_MAPPING } from './engines/ReputationMapping';
import { CORE_ERROR_DECODER, GOVERNANCE_ERROR_DECODER } from './errors';

const CORE_ABI = [
  'function registerContext(string calldata name, string calldata reputationAlgorithm) external payable returns (bytes32)',
  'function registerNode(bytes32 contextUID, bytes calldata entryProof) external payable',
  'function addSchema(bytes32 contextUID, bytes32 schemaUID, address adapter) external',
  'function setContextPolicy(bytes32 contextUID, address policyContract) external',
  'function isRegistered(bytes32 contextUID, address node) external view returns (bool)',
  'function verifyAttestation(bytes32,bytes32,bytes32,address,address) external view returns (bool)',
  'event ContextRegistered(bytes32 indexed uid, string name, address indexed owner)'
];

const CLIENT_ABI = ['function getVotingPower(address account) external view returns (uint256)'];

const GOVERNANCE_CLIENT_ABI = [
  'function settleReputation(address node, bytes32 role, uint256 score, uint256 epoch, bytes calldata sig) external',
  'function castVote(uint256 proposalId, bool support) external',
  'function createProposal(string calldata description, address target, bytes calldata payload, uint256 durationInDays) external returns (uint256)',
  'function executeProposal(uint256 proposalId) external',
  'function getVotingPower(address account) external view returns (uint256)'
];

export interface DriftConfig {
  coreAddress: string;
  factoryAddress: string;
}

export class DriftClient {
  private readonly _core: Contract;
  public readonly config: DriftConfig;
  private readonly _signer?: Signer;

  constructor(config: DriftConfig, signerOrProvider: Signer | Provider) {
    const connected = signerOrProvider;
    this._signer = 'signMessage' in connected ? (connected as Signer) : undefined;
    this._core = new Contract(config.coreAddress, CORE_ABI, connected);
    this.config = config;
  }

  // Error Decoding Utility ====================================================

  public handleContractError(error: any): never {
    const errorData = error?.data || error?.error?.data || error?.receipt?.data;
    if (errorData && typeof errorData === 'string') {
      const selector = errorData.slice(0, 10).toLowerCase();
      const decoded = CORE_ERROR_DECODER[selector] || GOVERNANCE_ERROR_DECODER[selector];
      if (decoded) {
        throw new Error(`DRIFT Protocol Revert [${decoded.name}]: ${decoded.message}`);
      }
    }
    throw error;
  }

  // Admin operations ==========================================================

  public async registerContext(name: string, reputationAlgorithm: string): Promise<string> {
    if (!ENGINES_MAPPING[reputationAlgorithm]) {
      throw new Error('DriftClient: Unknown reputation algorithm.')
    }

    try {
      const tx = await this._requireSigner().sendTransaction(
        await this._core.registerContext.populateTransaction(name, reputationAlgorithm)
      );
      const receipt = await tx.wait();

      const iface = this._core.interface;
      const log = receipt.logs
        .map((l: any) => {
          try {
            return iface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === 'ContextRegistered');

      if (!log) throw new Error('DriftClient: ContextRegistered event not found.');
      return log.args.uid;
    } catch (err) {
      this.handleContractError(err);
    }
  }

  public async linkSchemaToContext(contextUID: string, schemaUID: string, adapterAddress: string): Promise<void> {
    try {
      const tx = await this._core.connect(this._requireSigner()).addSchema(contextUID, schemaUID, adapterAddress);
      await tx.wait();
    } catch (err) {
      this.handleContractError(err);
    }
  }

  public async setContextPolicy(contextUID: string, policyAddress: string): Promise<void> {
    try {
      const tx = await this._core.connect(this._requireSigner()).setContextPolicy(contextUID, policyAddress);
      await tx.wait();
    } catch (err) {
      this.handleContractError(err);
    }
  }

  public async registerNode(contextUID: string, entryProof: string = '0x'): Promise<void> {
    try {
      const tx = await this._core.connect(this._requireSigner()).registerNode(contextUID, entryProof);
      await tx.wait();
    } catch (err) {
      this.handleContractError(err);
    }
  }

  // Settlements ===============================================================

  public async settleReputation(
    clientAddress: string,
    node: string,
    role: string,
    score: bigint,
    epoch: bigint,
    signature: string
  ): Promise<void> {
    try {
      const tx = await this._governanceClient(clientAddress)
        .connect(this._requireSigner())
        .settleReputation(node, role, score, epoch, signature);
      await tx.wait();
    } catch (err) {
      this.handleContractError(err);
    }
  }

  public async fetchAndSettle(
    clientAddress: string,
    contextUID: string,
    userAddress: string,
    role: string,
    endpointUrl: string
  ): Promise<void> {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextUID, userAddress, role })
    });

    if (!response.ok) {
      throw new Error(`DriftClient: Settlement fetch failed with status ${response.status}`);
    }

    const { score, epoch, signature } = await response.json();

    await this.settleReputation(clientAddress, userAddress, role, BigInt(score), BigInt(epoch), signature);
  }

  // Governance ================================================================

  public async createProposal(
    clientAddress: string,
    description: string,
    target: string,
    payload: string,
    durationDays: number
  ): Promise<bigint> {
    try {
      const gc = this._governanceClient(clientAddress).connect(this._requireSigner());
      const tx = await gc.createProposal(description, target, payload, durationDays);
      const receipt = await tx.wait();

      const log = receipt.logs
        .map((l: any) => {
          try {
            return gc.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === 'ProposalCreated');

      if (!log) throw new Error('DriftClient: ProposalCreated event not found.');
      return BigInt(log.args.proposalId);
    } catch (err) {
      this.handleContractError(err);
    }
  }

  public async castVote(clientAddress: string, proposalId: bigint, support: boolean): Promise<void> {
    try {
      const tx = await this._governanceClient(clientAddress)
        .connect(this._requireSigner())
        .castVote(proposalId, support);
      await tx.wait();
    } catch (err) {
      this.handleContractError(err);
    }
  }

  public async executeProposal(clientAddress: string, proposalId: bigint): Promise<void> {
    try {
      const tx = await this._governanceClient(clientAddress).connect(this._requireSigner()).executeProposal(proposalId);
      await tx.wait();
    } catch (err) {
      this.handleContractError(err);
    }
  }

  // Read operations ===========================================================

  public async isRegistered(contextUID: string, node: string): Promise<boolean> {
    return this._core.isRegistered(contextUID, node);
  }

  public async verifyAttestation(
    contextUID: string,
    schemaUID: string,
    attestationUID: string,
    subject: string,
    attester: string
  ): Promise<boolean> {
    return this._core.verifyAttestation(contextUID, schemaUID, attestationUID, subject, attester);
  }

  public async getTokenBalance(
    tokenAddress: string,
    account: string,
    contextUID: string,
    role: string
  ): Promise<bigint> {
    const token = new Contract(
      tokenAddress,
      ['function balanceOf(address account, uint256 id) external view returns (uint256)'],
      this._core.runner
    );
    const tokenId = keccak256(abi.encode(['bytes32', 'bytes32'], [contextUID, role]));
    return BigInt(await token.balanceOf(account, tokenId));
  }

  public async getVotingPower(clientAddress: string, account: string): Promise<bigint> {
    const client = new Contract(clientAddress, CLIENT_ABI, this._core.runner);
    return BigInt(await client.getVotingPower(account));
  }

  public async getLocalReputation(
    subjectAddress: string,
    contextUID: string,
    provider: IAttestationProvider,
    engine: IReputationEngine
  ): Promise<bigint> {
    const records = await provider.fetchUserRecords(contextUID, subjectAddress);

    if (records.length === 0) return 0n;

    return engine.calculateScore(records);
  }

  // Internal ==================================================================

  private _requireSigner(): Signer {
    if (!this._signer) {
      throw new Error('DriftClient: Write operations require a signer.');
    }
    return this._signer;
  }

  private _governanceClient(clientAddress: string): Contract {
    const runner = this._signer ?? this._core.runner;
    return new Contract(clientAddress, GOVERNANCE_CLIENT_ABI, runner);
  }
}
