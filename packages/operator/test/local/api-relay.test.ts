import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBytes, id, Wallet, type HDNodeWallet } from 'ethers';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { DriftValidationError } from '@drift-network/sdk';
import { buildApi } from '../../src/api/server.js';
import { FileSettlementRelay, encodeRelayJson } from '../../src/pipeline/relay.js';
import { HttpSettlementRelay, relayRequestDigest, SIGNATURE_HEADER, SIGNER_HEADER } from '../../src/relay/http.js';
import type { SignedCommitment, Tier2Proposal } from '../../src/pipeline/commitments.js';

const owners: [HDNodeWallet, HDNodeWallet] = [Wallet.createRandom(), Wallet.createRandom()];
const outsider = Wallet.createRandom();
const SAFE = Wallet.createRandom().address;
const PID = id('proposal').toLowerCase();

const proposal = (over: Partial<Tier2Proposal> = {}): Tier2Proposal => ({
  proposalId: PID,
  chainId: 31337n,
  safe: SAFE,
  client: '0x' + 'c1'.repeat(20),
  contextUID: id('ctx'),
  epoch: 1n,
  safeNonce: 0n,
  commitDeadline: 100n,
  revealDeadline: 200n,
  proposer: owners[0].address,
  signature: '0x01',
  ...over
});
const commitment = (owner: string, c = id('c')): SignedCommitment => ({ proposalId: PID, owner, commitment: c, signature: '0x02' });

describe('HTTP settlement relay', () => {
  let dir: string;
  let app: FastifyInstance;
  let url: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'drift-relay-'));
    app = buildApi({
      logger: pino({ level: 'silent' }),
      status: () => ({ startedAt: 0, ticks: 0, contexts: [] }),
      ready: async () => ({ ready: true }),
      contexts: [],
      relay: { store: new FileSettlementRelay(dir), safes: [SAFE], owners: async () => owners.map((o) => o.address) }
    });
    url = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips every message kind, bigints included, through the client', async () => {
    const r0 = new HttpSettlementRelay(url, owners[0]);
    const r1 = new HttpSettlementRelay(url, owners[1]);
    const reader = new HttpSettlementRelay(url);
    expect(await reader.getProposal(PID)).toBeNull();

    await r0.putProposal(proposal());
    await r0.putCommitment(commitment(owners[0].address));
    await r1.putCommitment(commitment(owners[1].address));
    await r1.putReveal({ proposalId: PID, owner: owners[1].address, root: id('r'), inputDigest: id('d'), salt: id('s'), seen: [], signature: '0x03' });
    const settlement = {
      proposalId: PID,
      root: id('r'),
      inputDigest: id('d'),
      treeURI: 'ipfs://t',
      bond: 10n ** 16n,
      tx: { to: SAFE, value: 0n, data: '0x', operation: 1 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: SAFE, refundReceiver: SAFE, nonce: 0n },
      safeTxHash: id('h')
    };
    await r1.putSettlement(settlement);
    await r0.putSignature(PID, { signer: owners[0].address, signature: '0x04' });

    expect(await reader.getProposal(PID)).toEqual(proposal());
    expect(await reader.listCommitments(PID)).toHaveLength(2);
    expect((await reader.listReveals(PID))[0]!.owner).toBe(owners[1].address);
    expect(await reader.getSettlement(PID)).toEqual(settlement);
    expect(await reader.listSignatures(PID)).toEqual([{ signer: owners[0].address, signature: '0x04' }]);
  });

  it('is first-writer-wins: identical rewrites succeed, different ones are rejected', async () => {
    const r0 = new HttpSettlementRelay(url, owners[0]);
    await r0.putProposal(proposal());
    await r0.putProposal(proposal());
    await expect(r0.putProposal(proposal({ commitDeadline: 101n }))).rejects.toThrow(DriftValidationError);
    await expect(r0.putProposal(proposal({ commitDeadline: 101n }))).rejects.toThrow(/409/);
    await r0.putCommitment(commitment(owners[0].address));
    await expect(r0.putCommitment(commitment(owners[0].address, id('other')))).rejects.toThrow(/409/);
  });

  it('authenticates writes: owners only, each writing its own slots, for served Safes, after a proposal', async () => {
    const r0 = new HttpSettlementRelay(url, owners[0]);
    await expect(r0.putCommitment(commitment(owners[0].address))).rejects.toThrow(/no proposal/);
    await expect(new HttpSettlementRelay(url, outsider).putProposal(proposal({ proposer: outsider.address }))).rejects.toThrow(/not an owner/);
    await expect(r0.putProposal(proposal({ safe: Wallet.createRandom().address }))).rejects.toThrow(/does not serve Safe/);
    await expect(r0.putProposal(proposal({ proposer: owners[1].address }))).rejects.toThrow(/names .* but was written by/);
    await r0.putProposal(proposal());
    await expect(r0.putCommitment(commitment(owners[1].address))).rejects.toThrow(/but was written by/);
    await expect(new HttpSettlementRelay(url).putCommitment(commitment(owners[0].address))).rejects.toThrow(/read-only/);
  });

  it('rejects a signature over a different body, a path mismatch, and oversized bodies', async () => {
    const path = `/relay/v1/proposals/${PID}`;
    const signed = encodeRelayJson(proposal());
    const sig = await owners[0].signMessage(getBytes(relayRequestDigest('PUT', path, signed)));
    const tampered = encodeRelayJson(proposal({ revealDeadline: 999n }));
    const headers = { 'content-type': 'application/json', [SIGNER_HEADER]: owners[0].address, [SIGNATURE_HEADER]: sig };
    expect((await app.inject({ method: 'PUT', url: path, headers, payload: tampered })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: path, headers, payload: signed })).statusCode).toBe(204);

    const other = id('other').toLowerCase();
    // A body for one proposal sent to another proposal's path.
    expect((await app.inject({ method: 'PUT', url: `/relay/v1/proposals/${other}`, headers, payload: signed })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/relay/v1/proposals/0x12' })).statusCode).toBe(400);
    const big = encodeRelayJson({ ...proposal(), padding: 'x'.repeat(70 * 1024) });
    expect((await app.inject({ method: 'PUT', url: path, headers, payload: big })).statusCode).toBe(413);
  });
});
