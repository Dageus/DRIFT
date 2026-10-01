import { getBytes, keccak256, toUtf8Bytes, concat, type Signer } from 'ethers';
import { DriftProviderError, DriftValidationError } from '@drift-network/sdk';
import type { OwnerSignature } from '../safe/SafeSettler.js';
import type { SignedCommitment, SignedReveal, Tier2Proposal } from '../pipeline/commitments.js';
import { decodeRelayJson, encodeRelayJson, type ISettlementRelay, type PublishedSettlement } from '../pipeline/relay.js';

/** Base path of the relay routes. Versioned so the wire format can change without ambiguity. */
export const RELAY_PREFIX = '/relay/v1';

export const SIGNER_HEADER = 'x-drift-signer';
export const SIGNATURE_HEADER = 'x-drift-signature';

/**
 * Digest a writer signs (EIP-191) to authenticate one relay write: keccak256 of
 * "<METHOD> <path>\n" followed by the exact body bytes. Binding the method and path stops a
 * signature for one slot being replayed into another; replaying the same request is harmless,
 * since rewriting identical content is a no-op.
 */
export function relayRequestDigest(method: string, path: string, body: string): string {
  return keccak256(concat([toUtf8Bytes(`${method.toUpperCase()} ${path}\n`), toUtf8Bytes(body)]));
}

const pid = (proposalId: string) => encodeURIComponent(proposalId.toLowerCase());

/**
 * ISettlementRelay over the operator API's relay routes. Reads need no credentials. Every write is
 * signed by `writer`, which must be an owner of the proposal's Safe, and the server also checks
 * that a message naming an owner (a commitment, a reveal, a signature, a proposal's proposer) is
 * written by that owner. Without write authentication, first-writer-wins would let anyone squat a
 * slot with junk before the owner wrote it, stalling the round.
 */
export class HttpSettlementRelay implements ISettlementRelay {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly writer?: Signer
  ) {
    this.base = baseUrl.replace(/\/$/, '') + RELAY_PREFIX;
  }

  private async read<T>(path: string): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(this.base + path);
    } catch (err) {
      throw new DriftProviderError(`DRIFT operator: relay ${this.base} unreachable: ${(err as Error).message}`, { cause: err });
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new DriftProviderError(`DRIFT operator: relay GET ${path} failed (${res.status}): ${await res.text()}`);
    return decodeRelayJson<T>(await res.text());
  }

  private async list<T>(path: string): Promise<T[]> {
    return (await this.read<T[]>(path)) ?? [];
  }

  private async write(method: 'PUT' | 'POST', path: string, value: unknown): Promise<void> {
    if (!this.writer) throw new DriftValidationError('DRIFT operator: this HttpSettlementRelay has no writer key; it is read-only.');
    const body = encodeRelayJson(value);
    const fullPath = RELAY_PREFIX + path;
    const signature = await this.writer.signMessage(getBytes(relayRequestDigest(method, fullPath, body)));
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { 'content-type': 'application/json', [SIGNER_HEADER]: await this.writer.getAddress(), [SIGNATURE_HEADER]: signature },
        body
      });
    } catch (err) {
      throw new DriftProviderError(`DRIFT operator: relay ${this.base} unreachable: ${(err as Error).message}`, { cause: err });
    }
    if (res.ok) return;
    const text = await res.text();
    // Same error class as FileSettlementRelay, so callers treat a lost race identically.
    if (res.status === 409 || res.status === 400 || res.status === 403) {
      throw new DriftValidationError(`DRIFT operator: relay rejected ${method} ${path} (${res.status}): ${text}`);
    }
    throw new DriftProviderError(`DRIFT operator: relay ${method} ${path} failed (${res.status}): ${text}`);
  }

  putProposal(p: Tier2Proposal): Promise<void> {
    return this.write('PUT', `/proposals/${pid(p.proposalId)}`, p);
  }
  getProposal(proposalId: string): Promise<Tier2Proposal | null> {
    return this.read(`/proposals/${pid(proposalId)}`);
  }
  putCommitment(c: SignedCommitment): Promise<void> {
    return this.write('POST', `/proposals/${pid(c.proposalId)}/commitments`, c);
  }
  listCommitments(proposalId: string): Promise<SignedCommitment[]> {
    return this.list(`/proposals/${pid(proposalId)}/commitments`);
  }
  putReveal(r: SignedReveal): Promise<void> {
    return this.write('POST', `/proposals/${pid(r.proposalId)}/reveals`, r);
  }
  listReveals(proposalId: string): Promise<SignedReveal[]> {
    return this.list(`/proposals/${pid(proposalId)}/reveals`);
  }
  putSettlement(s: PublishedSettlement): Promise<void> {
    return this.write('PUT', `/proposals/${pid(s.proposalId)}/settlement`, s);
  }
  getSettlement(proposalId: string): Promise<PublishedSettlement | null> {
    return this.read(`/proposals/${pid(proposalId)}/settlement`);
  }
  putSignature(proposalId: string, s: OwnerSignature): Promise<void> {
    return this.write('POST', `/proposals/${pid(proposalId)}/signatures`, s);
  }
  listSignatures(proposalId: string): Promise<OwnerSignature[]> {
    return this.list(`/proposals/${pid(proposalId)}/signatures`);
  }
}
