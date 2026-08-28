import { Signer, Provider, Contract, Interface } from 'ethers';
import CoreArtifact from '../../../contracts/out/DRIFTCore.sol/DRIFTCore.json' with { type: 'json' };
import { handleContractError } from '../utils.js';

export class CoreModule {
  public readonly contract: any;
  private readonly _signer?: Signer;
  private readonly _interface: Interface;

  constructor(coreAddress: string, signerOrProvider: Signer | Provider) {
    this._signer = 'signMessage' in signerOrProvider ? (signerOrProvider as Signer) : undefined;
    this._interface = new Interface(CoreArtifact.abi);
    this.contract = new Contract(coreAddress, CoreArtifact.abi, signerOrProvider);
  }

  private _requireSigner(): Signer {
    if (!this._signer) throw new Error('DRIFT SDK: Write operations require a connected signer.');
    return this._signer;
  }

  // Admin operations ==========================================================

  public async registerContext(name: string): Promise<string> {
    try {
      const tx = await this.contract.connect(this._requireSigner()).registerContext(name);
      const receipt = await tx.wait();

      const log = receipt.logs
        .map((l: any) => {
          try {
            return this._interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l: any) => l?.name === 'ContextRegistered');

      if (!log) throw new Error('DRIFT SDK: ContextRegistered event not found.');
      return log.args.uid;
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async deactivateContext(contextUID: string): Promise<void> {
    try {
      const tx = await this.contract.connect(this._requireSigner()).deactivateContext(contextUID);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async addSchema(contextUID: string, schemaUID: string, adapterAddress: string): Promise<void> {
    try {
      const tx = await this.contract.connect(this._requireSigner()).addSchema(contextUID, schemaUID, adapterAddress);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async removeSchema(contextUID: string, schemaUID: string): Promise<void> {
    try {
      const tx = await this.contract.connect(this._requireSigner()).removeSchema(contextUID, schemaUID);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async setContextPolicy(contextUID: string, policyAddress: string): Promise<void> {
    try {
      const tx = await this.contract.connect(this._requireSigner()).setContextPolicy(contextUID, policyAddress);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  // Node operations ===========================================================

  public async registerNode(contextUID: string, entryProof: string = '0x'): Promise<void> {
    try {
      const tx = await this.contract.connect(this._requireSigner()).registerNode(contextUID, entryProof);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async deregisterNode(contextUID: string): Promise<void> {
    try {
      const tx = await this.contract.connect(this._requireSigner()).deregisterNode(contextUID);
      await tx.wait();
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }

  public async setNodeStatus(contextUID: string, nodeAddress: string, status: number): Promise<void> {
    try {
      const tx = await this.contract.connect(this._requireSigner()).setNodeStatus(contextUID, nodeAddress, status);
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
}
