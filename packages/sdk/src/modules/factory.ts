import { Signer, Contract, Provider } from 'ethers';
import FactoryArtifact from '../../../contracts/out/DRIFTClientFactory.sol/DRIFTClientFactory.json';

export class DriftFactory {
  private readonly contract: Contract;
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
    salt: string
  ): Promise<string> {
    const connectedContract = this.contract.connect(this._requireSigner()) as Contract;

    // 1. Simulate the transaction to capture the returned clone address
    const cloneAddress = await connectedContract.deployClient.staticCall(contextUID, implementation, initData, salt);

    // 2. Execute the actual deployment transaction
    const tx = await connectedContract.deployClient(contextUID, implementation, initData, salt);
    await tx.wait();

    console.log(tx.receipt)

    return cloneAddress;
  }
}
