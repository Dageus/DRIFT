import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { isHexString } from 'ethers';
import type { OwnerSignature, SafeTx } from '../safe/SafeSettler.js';
import type { SignedCommitment, SignedReveal, Tier2Proposal } from './commitments.js';
import { DriftValidationError } from '@drift-network/sdk';

/** What publishEpochTreeTier2 puts on the relay once the reveals agree. */
export interface PublishedSettlement {
  proposalId: string;
  root: string;
  inputDigest: string;
  treeURI: string;
  bond: bigint;
  tx: SafeTx;
  safeTxHash: string;
}

/**
 * Shared, untrusted message board for one Safe's Tier 2 settlements. It stores what owners post
 * and verifies nothing: every step re-checks signatures, owners and windows itself. Writes are
 * first-writer-wins: posting a different value under a key that already holds one (a second,
 * different commitment from the same owner, say) is rejected, and posting the same value again is
 * a no-op, which is what makes the steps idempotent.
 */
export interface ISettlementRelay {
  putProposal(p: Tier2Proposal): Promise<void>;
  getProposal(proposalId: string): Promise<Tier2Proposal | null>;
  putCommitment(c: SignedCommitment): Promise<void>;
  listCommitments(proposalId: string): Promise<SignedCommitment[]>;
  putReveal(r: SignedReveal): Promise<void>;
  listReveals(proposalId: string): Promise<SignedReveal[]>;
  putSettlement(s: PublishedSettlement): Promise<void>;
  getSettlement(proposalId: string): Promise<PublishedSettlement | null>;
  putSignature(proposalId: string, s: OwnerSignature): Promise<void>;
  listSignatures(proposalId: string): Promise<OwnerSignature[]>;
}

/** Relay wire format: JSON with bigints as { "$bigint": "<decimal>" }. Shared by the file and HTTP relays. */
export const encodeRelayJson = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? { $bigint: x.toString() } : x), 2);
export const decodeRelayJson = <T>(s: string): T =>
  JSON.parse(s, (_, x) => (x && typeof x === 'object' && typeof x.$bigint === 'string' ? BigInt(x.$bigint) : x)) as T;
const toJson = encodeRelayJson;
const fromJson = decodeRelayJson;

/**
 * ISettlementRelay over a directory, one JSON file per message:
 *   <dir>/<proposalId>/proposal.json, settlement.json,
 *   commitments/<owner>.json, reveals/<owner>.json, signatures/<owner>.json
 * Useful when owners share a filesystem (a synced folder, a mounted volume) and for tests. Each
 * write goes to a temporary file that is then hard-linked into place, which fails if the target
 * exists, so concurrent writers cannot overwrite each other and readers never see a partial file.
 */
export class FileSettlementRelay implements ISettlementRelay {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private _proposalDir(proposalId: string): string {
    if (!isHexString(proposalId, 32)) throw new DriftValidationError(`DRIFT SDK: proposalId must be bytes32, got ${proposalId}.`);
    return path.join(this.dir, proposalId.toLowerCase());
  }

  private _ownerFile(proposalId: string, kind: string, owner: string): string {
    if (!isHexString(owner, 20)) throw new DriftValidationError(`DRIFT SDK: owner must be an address, got ${owner}.`);
    return path.join(this._proposalDir(proposalId), kind, `${owner.toLowerCase()}.json`);
  }

  private async _putOnce(file: string, value: unknown, what: string): Promise<void> {
    const body = toJson(value);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmp, body);
    try {
      await fs.promises.link(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = await fs.promises.readFile(file, 'utf-8');
      if (existing !== body) {
        throw new DriftValidationError(`DRIFT SDK: relay already holds a different ${what}; it cannot be replaced.`);
      }
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }

  private async _read<T>(file: string): Promise<T | null> {
    try {
      return fromJson<T>(await fs.promises.readFile(file, 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async _list<T>(proposalId: string, kind: string): Promise<T[]> {
    const dir = path.join(this._proposalDir(proposalId), kind);
    let names: string[];
    try {
      names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out = await Promise.all(names.map((n) => this._read<T>(path.join(dir, n))));
    return out.filter((x): x is Awaited<T> => x !== null);
  }

  putProposal(p: Tier2Proposal): Promise<void> {
    return this._putOnce(path.join(this._proposalDir(p.proposalId), 'proposal.json'), p, `proposal ${p.proposalId}`);
  }
  getProposal(proposalId: string): Promise<Tier2Proposal | null> {
    return this._read(path.join(this._proposalDir(proposalId), 'proposal.json'));
  }
  putCommitment(c: SignedCommitment): Promise<void> {
    return this._putOnce(this._ownerFile(c.proposalId, 'commitments', c.owner), c, `commitment from ${c.owner}`);
  }
  listCommitments(proposalId: string): Promise<SignedCommitment[]> {
    return this._list(proposalId, 'commitments');
  }
  putReveal(r: SignedReveal): Promise<void> {
    return this._putOnce(this._ownerFile(r.proposalId, 'reveals', r.owner), r, `reveal from ${r.owner}`);
  }
  listReveals(proposalId: string): Promise<SignedReveal[]> {
    return this._list(proposalId, 'reveals');
  }
  putSettlement(s: PublishedSettlement): Promise<void> {
    return this._putOnce(path.join(this._proposalDir(s.proposalId), 'settlement.json'), s, `settlement for ${s.proposalId}`);
  }
  getSettlement(proposalId: string): Promise<PublishedSettlement | null> {
    return this._read(path.join(this._proposalDir(proposalId), 'settlement.json'));
  }
  putSignature(proposalId: string, s: OwnerSignature): Promise<void> {
    return this._putOnce(this._ownerFile(proposalId, 'signatures', s.signer), s, `signature from ${s.signer}`);
  }
  listSignatures(proposalId: string): Promise<OwnerSignature[]> {
    return this._list(proposalId, 'signatures');
  }
}
