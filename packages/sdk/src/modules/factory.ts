import { Signer, Contract, Provider, Interface } from 'ethers';
import FactoryArtifact from '../../../contracts/out/DRIFTClientFactory.sol/DRIFTClientFactory.json';
import CoreArtifact from '../../../contracts/out/IDRIFTCore.sol/IDRIFTCore.json';

export class DriftFactory {
  private readonly contract: any;
  private readonly _signer?: Signer;

  constructor(factoryAddress: string, signerOrProvider: Signer | Provider) {
    this._signer = 'signMessage' in signerOrProvider ? (signerOrProvider as Signer) : undefined;
    this.contract = new Contract(factoryAddress, FactoryArtifact.abi, signerOrProvider);
  }

  private _requireSigner(): Signer {
    if (!this._signer) throw new Error('DRIFT SDK: Write operations require a connected signer.');
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
    if (!provider) throw new Error('DRIFT SDK: Signer is not connected to a provider.');

    const connectedContract = this.contract.connect(signer) as Contract;

    const tx = await connectedContract.deployClient(contextUID, implementation, initData, salt, overrides);

    const receipt = await tx.wait();

    const coreInterface = new Interface(CoreArtifact.abi);

    const deployedEvent = receipt.logs
      .map((log: any) => {
        try {
          return coreInterface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e: any) => e?.name === 'ClientUpdated');

    if (!deployedEvent) throw new Error('DRIFT SDK: ClientUpdated event not found in receipt.');

    const cloneAddress = deployedEvent.args[1];

    return cloneAddress;
  }
}
