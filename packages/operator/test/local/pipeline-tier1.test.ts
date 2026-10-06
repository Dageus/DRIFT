import { describe, it, expect } from 'vitest';
import {
  AbiCoder,
  Interface,
  Wallet,
  id,
  verifyTypedData,
  type Provider,
  type TransactionRequest,
  type TransactionResponse
} from 'ethers';
import { DriftSettler } from '@drift-network/sdk';
import { settleEpochTier1 } from '../../src/pipeline/tier1.js';
import { LocalEpochEngine } from '@drift-network/sdk/engines';
import { DEFAULT_EIGENTRUST_PARAMS, type EpochInput } from '@drift-network/sdk/engines';
import type { IEpochEngine } from '@drift-network/sdk/engines';
import type { ITreeTransport } from '@drift-network/sdk/merkle';
import type { IMerkleStore } from '@drift-network/sdk/merkle';
import { checkEpochTree } from '@drift-network/sdk/merkle';
import type { EpochSnapshot } from '../../src/pipeline/snapshot.js';
import { DriftConfigError, DriftEngineError } from '@drift-network/sdk';

const iface = new Interface([
  'function trustedSettler() view returns (address)',
  'function settlementBond() view returns (uint256)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function postEpochRoot(uint256 epoch, bytes32 merkleRoot, string treeURI, bytes sig) payable'
]);
const CLIENT = '0x' + 'c1'.repeat(20);
const CTX = id('tier1.test');
const ROLE = id('MEMBER').toLowerCase();
const nodes = [1, 2, 3].map(() => Wallet.createRandom().address.toLowerCase());

function snapshot(): EpochSnapshot {
  const enc = (v: number) => AbiCoder.defaultAbiCoder().encode(['uint256'], [v]);
  const input: EpochInput = {
    contextUID: CTX,
    epoch: 1n,
    tE: 1000n,
    schemaUID: id('schema'),
    schemaDefinition: 'uint256 score',
    params: DEFAULT_EIGENTRUST_PARAMS,
    defaultWeight: 1n,
    records: [
      { uid: id('r1'), schemaUID: id('schema'), attester: nodes[0]!, subject: nodes[1]!, timestamp: 900, revoked: false, data: enc(5) },
      { uid: id('r2'), schemaUID: id('schema'), attester: nodes[1]!, subject: nodes[2]!, timestamp: 900, revoked: false, data: enc(3) }
    ],
    members: nodes.map((node) => ({ node, role: ROLE })),
    pretrust: []
  };
  return { input, boundaryTimestamp: 1000n, core: '0x' + 'c0'.repeat(20) };
}

const DOMAIN = { name: 'DRIFT_WeightedGovernance', version: '1', chainId: 31337n, verifyingContract: CLIENT };

/** A settler wallet whose transactions are recorded instead of broadcast. */
class RecordingWallet extends Wallet {
  sent: TransactionRequest[] = [];
  constructor(key: string, provider: Provider, private readonly log: string[]) {
    super(key, provider);
  }
  override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    this.log.push('post');
    this.sent.push(tx);
    return { hash: '0x' + 'ab'.repeat(32), ...tx } as unknown as TransactionResponse;
  }
}

function harness(opts: { trusted?: string; bond?: bigint } = {}) {
  const log: string[] = [];
  const key = Wallet.createRandom().privateKey;
  const provider = {
    call: async (tx: { data: string }) => {
      const fn = iface.parseTransaction({ data: tx.data })!.name;
      if (fn === 'trustedSettler') return iface.encodeFunctionResult(fn, [opts.trusted ?? new Wallet(key).address]);
      if (fn === 'settlementBond') return iface.encodeFunctionResult(fn, [opts.bond ?? 10n ** 16n]);
      if (fn === 'eip712Domain') {
        return iface.encodeFunctionResult(fn, ['0x0f', DOMAIN.name, DOMAIN.version, DOMAIN.chainId, CLIENT, '0x' + '00'.repeat(32), []]);
      }
      throw new Error(`unexpected call ${fn}`);
    },
    getNetwork: async () => ({ chainId: 31337n }),
    // Enough for ContractTransactionResponse.wait() on a recorded transaction.
    getBlockNumber: async () => 1,
    getTransactionReceipt: async (hash: string) => ({
      hash,
      status: 1,
      blockNumber: 1,
      logs: [],
      confirmations: async () => 1
    })
  } as unknown as Provider;
  const wallet = new RecordingWallet(key, provider, log);
  const uploaded: Record<string, unknown> = {};
  const transport: ITreeTransport = {
    uploadTree: async (tree) => {
      log.push('upload');
      uploaded['ipfs://tree'] = tree;
      return 'ipfs://tree';
    },
    fetchTree: async (_uri, expected) => checkEpochTree(uploaded['ipfs://tree'] as never, expected),
    pin: async () => {
      log.push('pin');
    }
  };
  const store = {
    saveTree: async () => {
      log.push('save');
    }
  } as unknown as IMerkleStore;
  return { wallet, settler: new DriftSettler(wallet), transport, store, log };
}

describe('settleEpochTier1', () => {
  it('computes, uploads, pins and stores before posting the signed root with the bond', async () => {
    const h = harness();
    const r = await settleEpochTier1({
      settler: h.settler,
      client: CLIENT,
      snapshot: snapshot(),
      engine: new LocalEpochEngine(),
      transport: h.transport,
      store: h.store
    });

    expect(h.log).toEqual(['upload', 'pin', 'save', 'post']);
    expect(r.root).toBe(r.result.merkleRoot);
    expect(r.txHash).toBe('0x' + 'ab'.repeat(32));

    const tx = h.wallet.sent[0]!;
    expect(tx.value).toBe(10n ** 16n);
    const args = iface.decodeFunctionData('postEpochRoot', tx.data as string);
    expect(args[0]).toBe(1n);
    expect(args[1]).toBe(r.root);
    expect(args[2]).toBe('ipfs://tree');
    const signer = verifyTypedData(
      DOMAIN,
      { SettleRoot: [{ name: 'contextUID', type: 'bytes32' }, { name: 'epoch', type: 'uint256' }, { name: 'merkleRoot', type: 'bytes32' }, { name: 'treeURI', type: 'string' }] },
      { contextUID: CTX, epoch: 1n, merkleRoot: r.root, treeURI: 'ipfs://tree' },
      args[3]
    );
    expect(signer).toBe(h.wallet.address);
  });

  it('uses an explicit bond, and can skip pinning', async () => {
    const h = harness();
    await settleEpochTier1({ settler: h.settler, client: CLIENT, snapshot: snapshot(), engine: new LocalEpochEngine(), transport: h.transport, bond: 7n, pin: false });
    expect(h.log).toEqual(['upload', 'post']);
    expect(h.wallet.sent[0]!.value).toBe(7n);
  });

  it('refuses before uploading when the signer is not the trusted settler', async () => {
    const h = harness({ trusted: Wallet.createRandom().address });
    await expect(
      settleEpochTier1({ settler: h.settler, client: CLIENT, snapshot: snapshot(), engine: new LocalEpochEngine(), transport: h.transport })
    ).rejects.toBeInstanceOf(DriftConfigError);
    expect(h.log).toEqual([]);
  });

  it('refuses to post when the engine root disagrees with the tree its entries build', async () => {
    const h = harness();
    const local = new LocalEpochEngine();
    const lying: IEpochEngine = {
      computeEpoch: async (input) => ({ ...(await local.computeEpoch(input)), merkleRoot: '0x' + '11'.repeat(32) })
    };
    await expect(
      settleEpochTier1({ settler: h.settler, client: CLIENT, snapshot: snapshot(), engine: lying, transport: h.transport })
    ).rejects.toBeInstanceOf(DriftEngineError);
    expect(h.log).not.toContain('post');
  });
});
