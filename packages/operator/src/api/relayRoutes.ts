import { getBytes, isHexString, verifyMessage } from 'ethers';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DriftValidationError } from '@drift-network/sdk';
import { decodeRelayJson, encodeRelayJson, type ISettlementRelay } from '../pipeline/relay.js';
import { RELAY_PREFIX, SIGNATURE_HEADER, SIGNER_HEADER, relayRequestDigest } from '../relay/http.js';

export interface RelayRoutesOptions {
  /** Backing store, normally a FileSettlementRelay. First-writer-wins is enforced there. */
  store: ISettlementRelay;
  /** Safes this relay serves. Writes for proposals naming any other Safe are refused. */
  safes: string[];
  /** Current owners of a Safe (cached by the caller as it sees fit). */
  owners: (safe: string) => Promise<string[]>;
  /** Maximum request body, bytes. Default 64 KiB; a settlement, the largest message, is a few KiB. */
  bodyLimit?: number;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * The Tier 2 settlement relay over HTTP, with ISettlementRelay semantics: append-only,
 * first-writer-wins, and identical rewrites are no-ops (409 on a different rewrite).
 *
 * Reads are open. Writes carry an EIP-191 signature over the request (relayRequestDigest) by an
 * owner of the proposal's Safe, and a message that names an owner must be written by that owner.
 * The relay does not otherwise vouch for content: readers verify every message's own signature,
 * owner set and windows (the Tier 2 steps do). Write authentication exists because
 * first-writer-wins makes the first write to a slot permanent, so an open relay would let anyone
 * stall a round by squatting slots with junk.
 */
export function registerRelayRoutes(app: FastifyInstance, o: RelayRoutesOptions): void {
  const safes = new Set(o.safes.map((s) => s.toLowerCase()));
  const bodyLimit = o.bodyLimit ?? 64 * 1024;

  void app.register(
    async (r) => {
      // Keep the raw body: the write signature covers its exact bytes.
      r.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit }, (_req, body, done) => done(null, body));

      const pidOf = (req: FastifyRequest) => {
        const pid = (req.params as { pid: string }).pid;
        if (!isHexString(pid, 32)) throw new HttpError(400, 'proposal id must be a 32-byte hex string');
        return pid.toLowerCase();
      };

      /** Verifies the write signature and returns the writer, an owner of `safe`. */
      const writer = async (req: FastifyRequest, safe: string): Promise<string> => {
        if (!safes.has(safe.toLowerCase())) throw new HttpError(403, `this relay does not serve Safe ${safe}`);
        const signer = req.headers[SIGNER_HEADER];
        const signature = req.headers[SIGNATURE_HEADER];
        if (typeof signer !== 'string' || typeof signature !== 'string') throw new HttpError(401, 'write requires signer and signature headers');
        let recovered: string;
        try {
          recovered = verifyMessage(getBytes(relayRequestDigest(req.method, req.url.split('?')[0]!, req.body as string)), signature);
        } catch {
          throw new HttpError(401, 'malformed write signature');
        }
        if (!same(recovered, signer)) throw new HttpError(401, 'write signature does not match the signer header');
        if (!(await o.owners(safe)).some((ow) => same(ow, recovered))) throw new HttpError(403, `${recovered} is not an owner of Safe ${safe}`);
        return recovered;
      };

      /** The Safe of an existing proposal; writes other than the proposal need one. */
      const safeOf = async (pid: string): Promise<string> => {
        const p = await o.store.getProposal(pid);
        if (!p) throw new HttpError(409, 'no proposal with this id');
        return p.safe;
      };

      const body = <T>(req: FastifyRequest): T => {
        if (typeof req.body !== 'string') throw new HttpError(415, 'expected application/json');
        try {
          return decodeRelayJson<T>(req.body);
        } catch {
          throw new HttpError(400, 'body is not valid JSON');
        }
      };

      const handle =
        (fn: (req: FastifyRequest) => Promise<unknown>) =>
        async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
          try {
            const out = await fn(req);
            if (out === null) return void reply.code(404).send({ error: 'not found' });
            if (out === undefined) return void reply.code(204).send();
            void reply.type('application/json').send(encodeRelayJson(out));
          } catch (err) {
            if (err instanceof HttpError) return void reply.code(err.status).send({ error: err.message });
            if (err instanceof DriftValidationError) {
              const conflict = /already holds a different/.test(err.message);
              return void reply.code(conflict ? 409 : 400).send({ error: err.message });
            }
            throw err;
          }
        };

      const ownedBy = (named: string, writerAddr: string, what: string) => {
        if (!same(named, writerAddr)) throw new HttpError(403, `${what} names ${named} but was written by ${writerAddr}`);
      };
      const matchesPath = (named: string, pid: string) => {
        if (!same(named, pid)) throw new HttpError(400, 'body proposalId does not match the path');
      };

      r.get('/proposals/:pid', handle(async (req) => o.store.getProposal(pidOf(req))));
      r.put(
        '/proposals/:pid',
        handle(async (req) => {
          const pid = pidOf(req);
          const p = body<{ proposalId: string; safe: string; proposer: string }>(req);
          matchesPath(p.proposalId, pid);
          ownedBy(p.proposer, await writer(req, p.safe), 'proposal');
          await o.store.putProposal(p as never);
          return undefined;
        })
      );

      const perOwner = (kind: 'commitments' | 'reveals', put: (m: never) => Promise<void>, list: (pid: string) => Promise<unknown[]>) => {
        r.get(`/proposals/:pid/${kind}`, handle(async (req) => list(pidOf(req))));
        r.post(
          `/proposals/:pid/${kind}`,
          handle(async (req) => {
            const pid = pidOf(req);
            const m = body<{ proposalId: string; owner: string }>(req);
            matchesPath(m.proposalId, pid);
            ownedBy(m.owner, await writer(req, await safeOf(pid)), kind.slice(0, -1));
            await put(m as never);
            return undefined;
          })
        );
      };
      perOwner('commitments', (m) => o.store.putCommitment(m), (pid) => o.store.listCommitments(pid));
      perOwner('reveals', (m) => o.store.putReveal(m), (pid) => o.store.listReveals(pid));

      r.get('/proposals/:pid/settlement', handle(async (req) => o.store.getSettlement(pidOf(req))));
      r.put(
        '/proposals/:pid/settlement',
        handle(async (req) => {
          const pid = pidOf(req);
          const s = body<{ proposalId: string }>(req);
          matchesPath(s.proposalId, pid);
          await writer(req, await safeOf(pid)); // any owner may publish
          await o.store.putSettlement(s as never);
          return undefined;
        })
      );

      r.get('/proposals/:pid/signatures', handle(async (req) => o.store.listSignatures(pidOf(req))));
      r.post(
        '/proposals/:pid/signatures',
        handle(async (req) => {
          const pid = pidOf(req);
          const s = body<{ signer: string; signature: string }>(req);
          ownedBy(s.signer, await writer(req, await safeOf(pid)), 'signature');
          await o.store.putSignature(pid, s);
          return undefined;
        })
      );
    },
    { prefix: RELAY_PREFIX }
  );
}
