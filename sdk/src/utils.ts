import { id, keccak256, AbiCoder, Interface } from 'ethers';

/** Derives the contextUID from a human-readable name. Matches DRIFTCore. */
export const contextUID = (name: string): string => id(name);

/** Derives a role identifier from a human-readable role name. */
export const roleId = (roleName: string): string => id(roleName);

/** Derives the ERC-1155 token ID for a context+role pair. Matches DRIFTToken. */
export const tokenId = (ctxUID: string, role: string): bigint =>
  BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [ctxUID, role])));

export function handleContractError(error: any, iface: Interface): never {
  const errorData = error?.data || error?.error?.data || error?.receipt?.data || error?.info?.error?.data;

  if (errorData && typeof errorData === 'string') {
    let decoded;
    try {
      decoded = iface.parseError(errorData);
    } catch (parseErr: any) {
      throw new Error(
        `DRIFT SDK: Failed to decode contract error. ` +
          `Selector: ${errorData.slice(0, 10)}. ` +
          `Parse error: ${parseErr?.message || parseErr}. ` +
          `Original: ${error?.message || error}`
      );
    }

    if (decoded) {
      throw new Error(`DRIFT Revert [${decoded.name}]`);
    }
  }

  throw error;
}
