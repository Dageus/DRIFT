import type { BaseContract, ContractTransactionResponse } from 'ethers';

/** Hand-typed surface of DRIFTCore's ABI used by CoreModule. Keep in sync with
 *  DRIFTCore.sol/IDRIFTCore.sol by hand (see TODO.md section 2). */
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
  nodeRegisteredAt(contextUID: string, node: string): Promise<bigint>;
  nodeBannedAt(contextUID: string, node: string): Promise<bigint>;
}
