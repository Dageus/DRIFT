import { Signer, Contract, Provider, Interface } from 'ethers';
import FactoryArtifact from '../../../contracts/out/DRIFTClientFactory.sol/DRIFTClientFactory.json' with { type: 'json' };
import CoreArtifact from '../../../contracts/out/IDRIFTCore.sol/IDRIFTCore.json' with { type: 'json' };
import { handleContractError, isSigner, requireEventLog } from '../utils.js';
import { DriftConfigError } from '../errors.js';
import type { DRIFTClientFactoryContract } from '../contracts/DRIFTClientFactoryContract.js';

export class DriftFactory {
  private readonly contract: DRIFTClientFactoryContract;
  private readonly _signer?: Signer;
  private readonly _interface: Interface;

  constructor(factoryAddress: string, signerOrProvider: Signer | Provider) {
    this._signer = isSigner(signerOrProvider) ? signerOrProvider : undefined;
    this._interface = new Interface(FactoryArtifact.abi);
    this.contract = new Contract(
      factoryAddress,
      FactoryArtifact.abi,
      signerOrProvider
    ) as unknown as DRIFTClientFactoryContract;
  }

  private _requireSigner(): Signer {
    if (!this._signer) throw new DriftConfigError('DRIFT SDK: Write operations require a connected signer.');
    return this._signer;
  }

  public async deployClient(
    contextUID: string,
    implementation: string,
    initData: string,
    salt: string,
    overrides: { nonce?: number } = {}
  ): Promise<string> {
    const signer = this._requireSigner();
    const provider = signer.provider;
    if (!provider) throw new DriftConfigError('DRIFT SDK: Signer is not connected to a provider.');

    try {
      const connectedContract = this.contract.connect(signer) as DRIFTClientFactoryContract;
      const tx = await connectedContract.deployClient(contextUID, implementation, initData, salt, overrides);
      const receipt = await tx.wait();

      const coreInterface = new Interface(CoreArtifact.abi);
      const deployedEvent = requireEventLog(receipt?.logs, coreInterface, 'ClientUpdated', 'in receipt.');

      return deployedEvent.args.client as string;
    } catch (err) {
      handleContractError(err, this._interface);
    }
  }
}
