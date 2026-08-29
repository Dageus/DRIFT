import { id, keccak256, AbiCoder, Interface, Signer, Provider, Log, LogDescription } from 'ethers';
import { DriftContractRevertError, DriftUnknownRevertError, DriftNotFoundError } from './errors.js';

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
 * Parses every log in a transaction receipt against `iface` and returns the first one named
 * `eventName`, or `undefined` if it isn't present. A log from an unrelated event/contract fails
 * `parseLog` and is skipped rather than treated as an error — that's expected, not exceptional,
 * since a receipt commonly carries logs from more than one emitting contract/event.
 */
export function findEventLog(
  logs: readonly Log[] | undefined,
  iface: Interface,
  eventName: string
): LogDescription | undefined {
  return logs
    ?.map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed): parsed is LogDescription => parsed?.name === eventName);
}

/** Like findEventLog, but throws DriftNotFoundError instead of returning undefined. */
export function requireEventLog(
  logs: readonly Log[] | undefined,
  iface: Interface,
  eventName: string,
  context?: string
): LogDescription {
  const log = findEventLog(logs, iface, eventName);
  if (!log) {
    throw new DriftNotFoundError(`DRIFT SDK: ${eventName} event not found.${context ? ` ${context}` : ''}`);
  }
  return log;
}

/**
 * Every module routes caught contract-call errors through this. Always throws — the `never`
 * return type lets callers write `return handleContractError(...)` from a non-void function.
 * Must never be changed to return normally.
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
    let decoded: ReturnType<Interface['parseError']>;
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
