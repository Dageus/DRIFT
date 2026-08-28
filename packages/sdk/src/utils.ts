import { id, keccak256, AbiCoder, Interface, Signer, Provider } from 'ethers';
import { DriftContractRevertError, DriftUnknownRevertError } from './errors.js';

/** Derives the contextUID from a human-readable name. Matches DRIFTCore. */
export const contextUID = (name: string): string => id(name);

/** Derives a role identifier from a human-readable role name. */
export const roleId = (roleName: string): string => id(roleName);

/** Derives the ERC-1155 token ID for a context+role pair. Matches DRIFTToken. */
export const tokenId = (ctxUID: string, role: string): bigint =>
  BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [ctxUID, role])));

/**
 * Type guard distinguishing a connected Signer from a read-only Provider. Ethers v6 has no
 * built-in runtime check for this — `'signMessage' in x` is the standard duck-typing approach,
 * shared here so it's defined once instead of copied into every module that needs it.
 */
export function isSigner(signerOrProvider: Signer | Provider): signerOrProvider is Signer {
  return 'signMessage' in signerOrProvider;
}

/** Best-effort extraction of a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Every module routes caught contract-call errors through this. Always throws — never returns —
 * so callers can write `return handleContractError(err, this._interface)` in a function whose
 * declared return type isn't `void`/`undefined` and have TypeScript accept it as control-flow-
 * terminating (this relies on the `never` return type below, which is why this function must
 * never be changed to sometimes return normally).
 */
export function handleContractError(error: unknown, iface: Interface): never {
  const err = error as {
    data?: unknown;
    error?: { data?: unknown };
    receipt?: { data?: unknown };
    info?: { error?: { data?: unknown } };
    message?: unknown;
  };
  const errorData = err?.data ?? err?.error?.data ?? err?.receipt?.data ?? err?.info?.error?.data;

  if (errorData && typeof errorData === 'string') {
    let decoded: ReturnType<Interface['parseError']> = null;
    try {
      decoded = iface.parseError(errorData);
    } catch (parseErr) {
      throw new DriftUnknownRevertError(
        `DRIFT SDK: Failed to decode contract error. ` +
          `Selector: ${errorData.slice(0, 10)}. ` +
          `Parse error: ${errorMessage(parseErr)}. ` +
          `Original: ${errorMessage(error)}`,
        { cause: error }
      );
    }

    if (decoded) {
      const revertArgs: Record<string, unknown> = {};
      for (const fragment of decoded.fragment.inputs) {
        if (fragment.name) revertArgs[fragment.name] = decoded.args[fragment.name];
      }
      throw new DriftContractRevertError(`DRIFT Revert [${decoded.name}]`, decoded.name, revertArgs, {
        cause: error
      });
    }
  }

  throw new DriftUnknownRevertError(`DRIFT SDK: Contract call failed: ${errorMessage(error)}`, { cause: error });
}
