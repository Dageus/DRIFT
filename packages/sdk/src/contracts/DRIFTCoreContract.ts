import type { BaseContract, ContractTransactionResponse } from 'ethers';

/**
 * Hand-typed surface of the DRIFTCore ABI actually used by CoreModule. Not generated (no
 * typechain step in this build yet — see packages/sdk/TODO.md section 2), so this must be kept
 * in sync with `packages/contracts/src/core/DRIFTCore.sol`/`IDRIFTCore.sol` by hand. Constructed
 * against the concrete `DRIFTCore.json` ABI (not the narrower `IDRIFTCore.json` interface ABI),
 * matching what `CoreModule` already loads.
 */
export interface DRIFTCoreContract extends BaseContract {
  registerContext(name: string): Promise<ContractTransactionResponse>;
  deactivateContext(contextUID: string): Promise<ContractTransactionResponse>;
  addSchema(contextUID: string, schemaUID: string, adapterAddress: string): Promise<ContractTransactionResponse>;
  removeSchema(contextUID: string, schemaUID: string): Promise<ContractTransactionResponse>;
  setContextPolicy(contextUID: string, policyAddress: string): Promise<ContractTransactionResponse>;
  registerNode(contextUID: string, entryProof: string): Promise<ContractTransactionResponse>;
  deregisterNode(contextUID: string): Promise<ContractTransactionResponse>;
  setNodeStatus(contextUID: string, node: string, status: number): Promise<ContractTransactionResponse>;

  contextAdminRole(contextUID: string): Promise<string>;
  hasRole(role: string, account: string): Promise<boolean>;
  getContextClient(contextUID: string): Promise<string>;
  isRegistered(contextUID: string, node: string): Promise<boolean>;
  contextExists(contextUID: string): Promise<boolean>;
  verifyAttestation(
    contextUID: string,
    schemaUID: string,
    attestationUID: string,
    subject: string,
    attester: string
  ): Promise<boolean>;
  driftToken(): Promise<string>;
}
