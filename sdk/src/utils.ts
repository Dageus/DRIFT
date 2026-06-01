import { id, keccak256, AbiCoder } from 'ethers';

/** Derives the contextUID from a human-readable name. Matches DRIFTCore. */
export const contextUID = (name: string): string => id(name);

/** Derives a role identifier from a human-readable role name. */
export const roleId = (roleName: string): string => id(roleName);

/** Derives the ERC-1155 token ID for a context+role pair. Matches DRIFTToken. */
export const tokenId = (ctxUID: string, role: string): bigint =>
  BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [ctxUID, role])));
