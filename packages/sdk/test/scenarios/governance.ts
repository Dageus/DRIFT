import { Drift } from '../../src/drift';
import { EASProvider } from '../../src/providers/EAS';
import { Wallet, AbiCoder, keccak256, JsonRpcProvider, Interface } from 'ethers';
import { ADDRESSES, SCHEMAS } from './_shared';

const mockUploader = async (tree) => `arweave://mock-hash-${Date.now()}`;

export interface GovernanceResult {
  contextUID: string;
  clientAddress: string;
  proposalId: bigint;
  votesFor: bigint;
}

// STATELESS WALLET WRAPPER ====================================================
function createStatelessWallet(baseWallet: Wallet): Wallet {
  const provider = baseWallet.provider as JsonRpcProvider;

  return new Proxy(baseWallet, {
    get(target, prop, receiver) {
      if (prop === 'sendTransaction') {
        return async (tx: any) => {
          const address = await target.getAddress();
          const hex = await provider.send('eth_getTransactionCount', [address, 'pending']);
          tx.nonce = parseInt(hex, 16);
          return target.sendTransaction(tx);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export async function runGovernanceScenario(
  testerRaw: Wallet,
  aliceRaw: Wallet,
  bobRaw: Wallet
): Promise<GovernanceResult> {
  const tester = createStatelessWallet(testerRaw);
  const alice = createStatelessWallet(aliceRaw);
  const bob = createStatelessWallet(bobRaw);

  const testerAddr = await tester.getAddress();
  const aliceAddr = await alice.getAddress();
  const bobAddr = await bob.getAddress();

  // 1. INITIALIZE SDK INSTANCES =================================================
  const drifttester = new Drift(tester, {
    coreAddress: ADDRESSES.DRIFTCore,
    factoryAddress: ADDRESSES.Factory,
    attestationProvider: new EASProvider('https://sepolia.easscan.org/graphql', SCHEMAS.depin)
  });

  const driftAlice = new Drift(alice, {
    coreAddress: ADDRESSES.DRIFTCore,
    factoryAddress: ADDRESSES.Factory,
    attestationProvider: new EASProvider('https://sepolia.easscan.org/graphql', SCHEMAS.depin)
  });

  const driftBob = new Drift(bob, {
    coreAddress: ADDRESSES.DRIFTCore,
    factoryAddress: ADDRESSES.Factory,
    attestationProvider: new EASProvider('https://sepolia.easscan.org/graphql', SCHEMAS.depin)
  });

  // 2. REGISTER CONTEXT =========================================================
  const contextName = `governance.e2e.${Date.now()}`;
  const contextUID = await drifttester.core.registerContext(contextName);

  // 3. REGISTER NODES ===========================================================
  await drifttester.core.registerNode(contextUID, '0x');
  await driftAlice.core.registerNode(contextUID, '0x');
  await driftBob.core.registerNode(contextUID, '0x');

  // 4. DEPLOY GOVERNANCE CLIENT =================================================
  const roles = [
    keccak256(new AbiCoder().encode(['string'], ['ADMIN'])),
    keccak256(new AbiCoder().encode(['string'], ['MEMBER']))
  ];
  const weights = [10n, 1n];

  const initIface = new Interface([
    'function initialize(address,address,bytes32,address,uint256,uint256,string,bytes32[],uint256[])'
  ]);

  const initData = initIface.encodeFunctionData('initialize', [
    ADDRESSES.DRIFTCore,
    ADDRESSES.DRIFTToken,
    contextUID,
    testerAddr,
    50n,
    0n,
    'EigenTrust',
    roles,
    weights
  ]);

  const uniqueSalt = keccak256(
    new AbiCoder().encode(['string', 'uint256', 'bytes32'], ['salt', Date.now(), contextUID])
  );

  const clientAddress = await drifttester.factory.deployClient(
    contextUID,
    ADDRESSES.WeightedGovernanceTemplate,
    initData,
    uniqueSalt
  );

  // 5. SETTLE EPOCH ROOT ========================================================
  const epoch = 1n;
  const scores = [
    { node: testerAddr, role: roles[0], score: 100n },
    { node: aliceAddr, role: roles[1], score: 80n },
    { node: bobAddr, role: roles[1], score: 60n }
  ];

  const { root, signature, tree } = await drifttester.settler!.buildAndSignEpochRoot(
    clientAddress,
    contextUID,
    epoch,
    scores,
    mockUploader
  );

  await drifttester.reputation.postEpochRoot(clientAddress, epoch, root, '', signature);

  // 6. CLAIM REPUTATION =========================================================
  const testerPayload = drifttester.settler!.generateProofOfStatePayload(tree, contextUID, testerAddr, epoch);

  await drifttester.reputation.claimReputation(
    clientAddress,
    testerAddr,
    roles[0],
    100n,
    epoch,
    testerPayload.proofs[0]
  );

  // 7. CREATE PROPOSAL ==========================================================
  const proposalPayload = new AbiCoder().encode(
    ['bytes32', 'bytes32', 'address'],
    [contextUID, keccak256(new AbiCoder().encode(['string'], ['test-schema'])), testerAddr]
  );

  const proposalId = await drifttester.governance.createProposalWithProofs(
    clientAddress,
    'Test Proposal',
    ADDRESSES.DRIFTCore,
    proposalPayload,
    1,
    testerPayload
  );

  // 8. CAST VOTE ================================================================
  const alicePayload = driftAlice.settler!.generateProofOfStatePayload(tree, contextUID, aliceAddr, epoch);
  await driftAlice.governance.castVoteWithProofs(clientAddress, proposalId, true, alicePayload);

  // 9. VERIFY ===================================================================
  const proposal = await drifttester.governance.getProposal(clientAddress, proposalId);
  if (!proposal) throw new Error('Proposal not found');

  return {
    contextUID,
    clientAddress,
    proposalId,
    votesFor: proposal.votesFor
  };
}
