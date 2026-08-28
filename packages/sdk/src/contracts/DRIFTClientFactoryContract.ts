import type { BaseContract, ContractTransactionResponse } from 'ethers';

/** Hand-typed surface of the DRIFTClientFactory ABI used by DriftFactory. */
export interface DRIFTClientFactoryContract extends BaseContract {
  deployClient(
    contextUID: string,
    implementation: string,
    initData: string,
    salt: string,
    overrides?: { nonce?: number }
  ): Promise<ContractTransactionResponse>;
}
