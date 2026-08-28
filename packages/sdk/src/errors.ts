/**
 * Typed error hierarchy for the DRIFT SDK. Every error the SDK throws deliberately (as opposed to
 * an unexpected bug) extends `DriftError`, so consumers can do:
 *
 *   try {
 *     await drift.core.registerContext('my.context');
 *   } catch (e) {
 *     if (e instanceof DriftContractRevertError) {
 *       // e.revertName, e.revertArgs — programmatic access to the decoded on-chain revert
 *     } else if (e instanceof DriftError) {
 *       // any other SDK-recognized failure
 *     } else {
 *       throw e; // something unexpected — don't swallow it
 *     }
 *   }
 */

/** Base class for every error the SDK throws intentionally. Never thrown directly. */
export abstract class DriftError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The SDK was asked to do something it isn't configured for: no signer where a write requires
 * one, no provider where a network call requires one, an unrecognized algorithm/mode name, etc.
 * These are caller mistakes discoverable before any network call is made.
 */
export class DriftConfigError extends DriftError {}

/** Caller-supplied input failed a shape/consistency check before anything was sent on-chain. */
export class DriftValidationError extends DriftError {}

/**
 * Something the SDK expected to find — an event in a transaction receipt, a leaf in a Merkle
 * tree, a persisted tree/trust-graph file — wasn't there.
 */
export class DriftNotFoundError extends DriftError {}

/** An external, non-contract data source (an attestation indexer's GraphQL API, etc.) failed. */
export class DriftProviderError extends DriftError {}

/**
 * A contract call reverted and the revert reason was successfully decoded against the ABI.
 * `revertName` and `revertArgs` give programmatic access to exactly what the contract said,
 * instead of forcing consumers to string-match `error.message`.
 */
export class DriftContractRevertError extends DriftError {
  constructor(
    message: string,
    public readonly revertName: string,
    public readonly revertArgs: Record<string, unknown>,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

/**
 * A contract call failed, but the revert data couldn't be decoded against the ABI (or there was
 * no structured revert data at all — a plain require(false), a network error mid-call, etc.).
 * The original error is always available via `.cause`.
 */
export class DriftUnknownRevertError extends DriftError {}
