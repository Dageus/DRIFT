import type { ITreeTransport } from './ITreeTransport.js';
import { checkEpochTree, loadEpochTree, type EpochTree, type TreeExpectation } from './epochTree.js';
import { DriftConfigError, DriftProviderError } from '../errors.js';

export interface IPFSTreeTransportConfig {
  /**
   * Kubo-compatible RPC API endpoint for uploads (a local `ipfs daemon`, or any pinning service
   * exposing the standard `/api/v0/add` route). Required for `uploadTree`; `fetchTree` alone
   * doesn't need it, since fetching only reads from `gatewayUrl`.
   */
  apiUrl?: string;
  /** HTTP gateway used to fetch content by CID. Defaults to the public https://ipfs.io gateway. */
  gatewayUrl?: string;
  /** Sent as the `Authorization` header on API requests, for services that require one. */
  authorization?: string;
}

const DEFAULT_GATEWAY = 'https://ipfs.io';

/**
 * ITreeTransport backed by IPFS. Uses plain `fetch`/`FormData`/`Blob` (all global since Node 20.10,
 * this package's minimum) against Kubo's HTTP RPC API — no IPFS client dependency, so any
 * Kubo-compatible node or pinning service works without adding a new SDK dependency.
 *
 * A CID names the tree's content, so `treeURI` cannot be repointed at a different tree after it
 * is posted. A gateway, however, is not trusted to return the content its URL names, and this
 * class does not recompute CIDs. Integrity instead comes from the tree itself: `fetchTree` checks
 * that the tree is internally consistent and, given the on-chain root, that it is the committed
 * tree. `ipfs://<cid>` is the `treeURI` format this class produces and expects; a bare CID or a
 * gateway URL containing `/ipfs/<cid>` is also accepted on fetch.
 */
export class IPFSTreeTransport implements ITreeTransport {
  private readonly apiUrl?: string;
  private readonly gatewayUrl: string;
  private readonly authorization?: string;

  constructor(config: IPFSTreeTransportConfig = {}) {
    this.apiUrl = config.apiUrl?.replace(/\/$/, '');
    this.gatewayUrl = (config.gatewayUrl ?? DEFAULT_GATEWAY).replace(/\/$/, '');
    this.authorization = config.authorization;
  }

  public async uploadTree(tree: EpochTree): Promise<string> {
    if (!this.apiUrl) {
      throw new DriftConfigError(
        'DRIFT SDK: IPFSTreeTransport.uploadTree requires `apiUrl` (a Kubo-compatible /api/v0/add ' +
          'endpoint) — construct with { apiUrl: "http://127.0.0.1:5001" } for a local `ipfs daemon`, ' +
          'or your pinning service’s API URL.'
      );
    }

    const body = new FormData();
    body.append('file', new Blob([JSON.stringify(tree.dump())], { type: 'application/json' }), 'tree.json');

    const res = await fetch(`${this.apiUrl}/api/v0/add?cid-version=1`, {
      method: 'POST',
      headers: this.authorization ? { Authorization: this.authorization } : undefined,
      body
    });
    if (!res.ok) {
      throw new DriftProviderError(`DRIFT SDK: IPFS upload failed (${res.status} ${res.statusText}): ${await res.text()}`);
    }

    const result = (await res.json()) as { Hash: string };
    return `ipfs://${result.Hash}`;
  }

  /**
   * Fetches the tree behind `treeURI` from the gateway and checks it (see `checkEpochTree`).
   * Pass `expected.root`, the root read from chain: without it, a dishonest gateway can return
   * any well-formed tree.
   */
  public async fetchTree(treeURI: string, expected?: TreeExpectation): Promise<EpochTree> {
    const cid = this._extractCID(treeURI);
    const res = await fetch(`${this.gatewayUrl}/ipfs/${cid}`);
    if (!res.ok) {
      throw new DriftProviderError(`DRIFT SDK: IPFS fetch failed for ${treeURI} (${res.status} ${res.statusText})`);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      throw new DriftProviderError(`DRIFT SDK: ${treeURI} did not return JSON`, { cause: err });
    }
    return checkEpochTree(loadEpochTree(data), expected);
  }

  /**
   * Pins `treeURI` on the configured node, so it stays available as long as that node does. A
   * tree pinned only by the settler that uploaded it disappears with that settler; committee
   * members and claimants who depend on it should pin it themselves.
   */
  public async pin(treeURI: string): Promise<void> {
    if (!this.apiUrl) {
      throw new DriftConfigError('DRIFT SDK: IPFSTreeTransport.pin requires `apiUrl`.');
    }
    const cid = this._extractCID(treeURI);
    const res = await fetch(`${this.apiUrl}/api/v0/pin/add?arg=${encodeURIComponent(cid)}`, {
      method: 'POST',
      headers: this.authorization ? { Authorization: this.authorization } : undefined
    });
    if (!res.ok) {
      throw new DriftProviderError(`DRIFT SDK: IPFS pin failed for ${treeURI} (${res.status} ${res.statusText}): ${await res.text()}`);
    }
  }

  private _extractCID(treeURI: string): string {
    if (treeURI.startsWith('ipfs://')) return treeURI.slice('ipfs://'.length);
    const gatewayMatch = /\/ipfs\/([^/?#]+)/.exec(treeURI);
    if (gatewayMatch) return gatewayMatch[1]!;
    return treeURI; // tolerate a bare CID
  }
}
