import { Signer, Contract, Interface, Provider } from 'ethers';
import FactoryArtifact from '../../../contracts/out/DRIFTClientFactory.sol/DRIFTClientFactory.json';

export class DriftFactory {
  private readonly contract: Contract;
  private readonly _factoryInterface: Interface;

  constructor(factoryAddress: string, signerOrProvider: Signer | Provider) {
    this._factoryInterface = new Interface(FactoryArtifact.abi);
    this.contract = new Contract(factoryAddress, FactoryArtifact.abi, signerOrProvider);
  }

  public async deployClient(
    contextUID: string,
    implementation: string,
    initData: string,
    salt: string
  ): Promise<string> {
    const tx = await this.contract.deployClient(contextUID, implementation, initData, salt);
    const receipt = await tx.wait();
    return this._extractClientAddress(receipt);
  }

  private _extractClientAddress(receipt: any): string {
    const log = receipt.logs
      .map((l: any) => {
        try {
          return this._factoryInterface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l: any) => l?.name === 'ClientDeployed');

    if (!log) throw new Error('DriftFactory: ClientDeployed event not found in receipt.');
    return log.args.client;
  }
}
