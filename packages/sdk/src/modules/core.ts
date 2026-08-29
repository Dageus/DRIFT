import { Signer, Provider, Contract, Interface } from 'ethers';
import CoreArtifact from '../../../contracts/out/DRIFTCore.sol/DRIFTCore.json' with { type: 'json' };
import { handleContractError, isSigner } from '../utils.js';
import { DriftConfigError, DriftNotFoundError } from '../errors.js';
import type { DRIFTCoreContract } from '../contracts/DRIFTCoreContract.js';

export class CoreModule {
  public readonly contract: DRIFTCoreContract;
  private readonly _signer?: Signer;
  private readonly _interface: Interface;

  constructor(coreAddress: string, signerOrProvider: Signer | Provider) {
    this._signer = isSigner(signerOrProvider) ? signerOrProvider : undefined;
    this._interface = new Interface(CoreArtifact.abi);
    this.contract = new Contract(coreAddress, CoreArtifact.abi, signerOrProvider) as unknown as DRIFTCoreContract;
  }

  private _requireSigner(): Signer {
    if (!this._signer) throw new DriftConfigError('DRIFT SDK: Write operations require a connected signer.');
    return this._signer;
  }

  /** The contract instance connected to the required signer, typed back to DRIFTCoreContract
   *  since BaseContract.connect() only returns the untyped base class. */
  private _connected(): DRIFTCoreContract {
    return this.contract.connect(this._requireSigner()) as DRIFTCoreContract;
  }

  // Admin operations ==========================================================

  public async registerContext(name: string): Promise<string> {
    try {
      const tx = await this._connected().registerContext(name);
      const receipt = await tx.wait();

      const log = receipt?.logs
        .map((l) => {
          try {
            return this._interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l) => l?.name === 'ContextRegistered');

      if (!log) throw new DriftNotFoundError('DRIFT SDK: ContextRegistered event not found.');
      return log.args.uid as string;
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async deactivateContext(contextUID: string): Promise<void> {
    try {
      const tx = await this._connected().deactivateContext(contextUID);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async addSchema(contextUID: string, schemaUID: string, adapterAddress: string): Promise<void> {
    try {
      const tx = await this._connected().addSchema(contextUID, schemaUID, adapterAddress);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async removeSchema(contextUID: string, schemaUID: string): Promise<void> {
    try {
      const tx = await this._connected().removeSchema(contextUID, schemaUID);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async setContextPolicy(contextUID: string, policyAddress: string): Promise<void> {
    try {
      const tx = await this._connected().setContextPolicy(contextUID, policyAddress);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  // Node operations ===========================================================

  public async registerNode(contextUID: string, entryProof: string = '0x'): Promise<void> {
    try {
      const tx = await this._connected().registerNode(contextUID, entryProof);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async deregisterNode(contextUID: string): Promise<void> {
    try {
      const tx = await this._connected().deregisterNode(contextUID);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async setNodeStatus(contextUID: string, nodeAddress: string, status: number): Promise<void> {
    try {
      const tx = await this._connected().setNodeStatus(contextUID, nodeAddress, status);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  // Read operations ===========================================================

  public async isContextAdmin(contextUID: string, account: string): Promise<boolean> {
    const adminRole = await this.contract.contextAdminRole(contextUID);
    return await this.contract.hasRole(adminRole, account);
  }

  public async getContextClient(contextUID: string): Promise<string> {
    try {
      return await this.contract.getContextClient(contextUID);
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async isRegistered(contextUID: string, node: string): Promise<boolean> {
    try {
      return await this.contract.isRegistered(contextUID, node);
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async verifyAttestation(
    contextUID: string,
    schemaUID: string,
    attestationUID: string,
    subject: string,
    attester: string
  ): Promise<boolean> {
    try {
      return await this.contract.verifyAttestation(contextUID, schemaUID, attestationUID, subject, attester);
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  /** Unix timestamp `node` was (most recently) registered in `contextUID`, or 0n if never. */
  public async getNodeRegisteredAt(contextUID: string, node: string): Promise<bigint> {
    try {
      return await this.contract.nodeRegisteredAt(contextUID, node);
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }
}
