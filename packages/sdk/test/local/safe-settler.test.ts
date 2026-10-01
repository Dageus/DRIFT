// The SDK half of the Tier 2 Safe settlement check. This test builds and signs a one-round
// settlement for the deployment in packages/contracts/test/integration/DRIFTSafeSettler.t.sol and
// writes it to a vector; that Foundry test executes it against the real Safe v1.4.1 bytecode and
// the real governance client. If the Foundry deployment changes, update INPUTS from
// `forge test --match-test test_PrintVectorInputs -vv` and rerun with UPDATE_SAFE_VECTOR=1.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Wallet, keccak256, toUtf8Bytes, recoverAddress } from 'ethers';
import {
  buildOneRoundSettlement,
  packSignatures,
  safeTxHash,
  settleRootDigest,
  SAFE_V141,
  type SafeTx
} from '../../src/safe/index.js';

const VECTOR = fileURLToPath(new URL('../../../contracts/test/fixtures/safe-settler-vector.json', import.meta.url));

const INPUTS = {
  chainId: 31337n,
  safe: '0x219DD27bce249413b71D9F95308fDebFb9247848',
  client: '0x5a312d5B60C4f4229Fa6687baabfBe18d9759904',
  contextUID: '0xea4ccd83af1995f71a74a9ed6894086fe792236f2ccb7c76651a1d70484746d4',
  clientDomain: { name: 'DRIFT_WeightedGovernance', version: '1' },
  epoch: 1n,
  merkleRoot: keccak256(toUtf8Bytes('sdk-root')),
  treeURI: 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
  bond: 10n ** 16n,
  nonce: 0n,
  // Owners 0x5afe01 and 0x5afe03 sign; 0x5afe02 abstains.
  ownerKeys: ['0x' + '5afe01'.padStart(64, '0'), '0x' + '5afe03'.padStart(64, '0')]
};

function build(): { tx: SafeTx; digest: string; hash: string } {
  const r = {
    clientDomain: { ...INPUTS.clientDomain, chainId: INPUTS.chainId, verifyingContract: INPUTS.client },
    contextUID: INPUTS.contextUID,
    epoch: INPUTS.epoch,
    merkleRoot: INPUTS.merkleRoot,
    treeURI: INPUTS.treeURI,
    bond: INPUTS.bond
  };
  const tx = buildOneRoundSettlement(INPUTS.client, r, INPUTS.nonce);
  return { tx, digest: settleRootDigest(r), hash: safeTxHash(INPUTS.safe, INPUTS.chainId, tx) };
}

async function sign(tx: SafeTx) {
  const domain = { chainId: INPUTS.chainId, verifyingContract: INPUTS.safe };
  const types = {
    SafeTx: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'nonce', type: 'uint256' }
    ]
  };
  return Promise.all(
    INPUTS.ownerKeys.map(async (k) => {
      const w = new Wallet(k);
      return { signer: w.address, signature: await w.signTypedData(domain, types, tx) };
    })
  );
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n';

describe('SafeSettler', () => {
  it('builds the settlement the Foundry test executes', async () => {
    const { tx, digest, hash } = build();
    expect(tx.to).toBe(SAFE_V141.multiSend);
    expect(tx.operation).toBe(1);

    const sigs = await sign(tx);
    for (const s of sigs) expect(recoverAddress(hash, s.signature)).toBe(s.signer);

    const vector = {
      inputs: { ...INPUTS, ownerKeys: undefined },
      expected: { settleDigest: digest, safeTxHash: hash, data: tx.data, signatures: packSignatures(sigs) }
    };
    if (process.env.UPDATE_SAFE_VECTOR) writeFileSync(VECTOR, json(vector));
    expect(json(vector)).toBe(readFileSync(VECTOR, 'utf8'));
  });

  it('packs signatures in ascending owner order and rejects duplicates', () => {
    const a = { signer: '0x00000000000000000000000000000000000000bb', signature: '0x' + 'bb'.repeat(65) };
    const b = { signer: '0x00000000000000000000000000000000000000aa', signature: '0x' + 'aa'.repeat(65) };
    expect(packSignatures([a, b])).toBe('0x' + 'aa'.repeat(65) + 'bb'.repeat(65));
    expect(() => packSignatures([a, a])).toThrow(/duplicate/);
  });

  it('owners with different roots sign different hashes', () => {
    const { hash } = build();
    const r2 = {
      clientDomain: { ...INPUTS.clientDomain, chainId: INPUTS.chainId, verifyingContract: INPUTS.client },
      contextUID: INPUTS.contextUID,
      epoch: INPUTS.epoch,
      merkleRoot: keccak256(toUtf8Bytes('other-root')),
      treeURI: INPUTS.treeURI,
      bond: INPUTS.bond
    };
    expect(safeTxHash(INPUTS.safe, INPUTS.chainId, buildOneRoundSettlement(INPUTS.client, r2, INPUTS.nonce))).not.toBe(hash);
  });
});
