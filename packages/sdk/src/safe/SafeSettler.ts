import {
  AbiCoder,
  Contract,
  Interface,
  TypedDataEncoder,
  ZeroAddress,
  concat,
  getAddress,
  getBytes,
  recoverAddress,
  solidityPacked,
  type ContractRunner,
  type Signer,
  type TransactionResponse,
  type TypedDataDomain
} from 'ethers';
import { DriftConfigError, DriftValidationError } from '../errors.js';
import type { IEpochEngine } from '../engines/epoch/IEpochEngine.js';
import type { EpochInput, EpochResult } from '../engines/epoch/protocol.js';

/**
 * Canonical Safe v1.4.1 deployments. The same addresses hold the same bytecode on Ethereum,
 * Sepolia, Arbitrum One and Arbitrum Sepolia (checked against Arbitrum Sepolia and Sepolia for
 * packages/contracts/test/fixtures/safe-v1.4.1). Verify on any other chain before use.
 */
export const SAFE_V141 = {
  singleton: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
  singletonL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  multiSend: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
  compatibilityFallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
  signMessageLib: '0xd53cd0aB83D845Ac265BE939c57F53AD838012c9'
} as const;

export const SafeOperation = { Call: 0, DelegateCall: 1 } as const;
export type SafeOperation = (typeof SafeOperation)[keyof typeof SafeOperation];

/** A Safe transaction without gas refund (all refund fields zero), the only kind built here. */
export interface SafeTx {
  to: string;
  value: bigint;
  data: string;
  operation: SafeOperation;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: string;
  refundReceiver: string;
  nonce: bigint;
}

export interface SettlementRequest {
  /** EIP-712 domain of the governance client (its eip712Domain()). */
  clientDomain: TypedDataDomain;
  contextUID: string;
  epoch: bigint;
  merkleRoot: string;
  treeURI: string;
  /** Settlement bond, paid from the Safe's balance. */
  bond: bigint;
}

export interface OwnerSignature {
  signer: string;
  signature: string;
}

const SETTLE_ROOT_TYPES = {
  SettleRoot: [
    { name: 'contextUID', type: 'bytes32' },
    { name: 'epoch', type: 'uint256' },
    { name: 'merkleRoot', type: 'bytes32' },
    { name: 'treeURI', type: 'string' }
  ]
};

const SAFE_TX_TYPES = {
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

const SAFE_MESSAGE_TYPES = { SafeMessage: [{ name: 'message', type: 'bytes' }] };

const CLIENT_IFACE = new Interface([
  'function postEpochRoot(uint256 epoch, bytes32 merkleRoot, string treeURI, bytes sig) payable'
]);
const MULTISEND_IFACE = new Interface(['function multiSend(bytes transactions) payable']);
const SIGN_MESSAGE_IFACE = new Interface(['function signMessage(bytes _data)']);
const SAFE_IFACE = new Interface([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])'
]);
const EIP712_ABI = [
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)'
];

const safeDomain = (safe: string, chainId: bigint) => ({ chainId, verifyingContract: getAddress(safe) });

/** The digest `postEpochRoot` checks with SignatureChecker against the trusted settler. */
export function settleRootDigest(r: Omit<SettlementRequest, 'bond'>): string {
  return TypedDataEncoder.hash(r.clientDomain, SETTLE_ROOT_TYPES, {
    contextUID: r.contextUID,
    epoch: r.epoch,
    merkleRoot: r.merkleRoot,
    treeURI: r.treeURI
  });
}

/**
 * The hash a Safe's CompatibilityFallbackHandler checks in isValidSignature(digest, sig):
 * EIP-712 SafeMessage over abi.encode(digest), in the Safe's own domain. SignMessageLib marks the
 * same hash as signed.
 */
export function safeMessageHash(safe: string, chainId: bigint, digest: string): string {
  const message = AbiCoder.defaultAbiCoder().encode(['bytes32'], [digest]);
  return TypedDataEncoder.hash(safeDomain(safe, chainId), SAFE_MESSAGE_TYPES, { message });
}

export function safeTxHash(safe: string, chainId: bigint, tx: SafeTx): string {
  return TypedDataEncoder.hash(safeDomain(safe, chainId), SAFE_TX_TYPES, tx);
}

/** MultiSend's packed encoding: operation ‖ to ‖ value ‖ dataLength ‖ data, per transaction. */
export function encodeMultiSend(txs: { operation: SafeOperation; to: string; value: bigint; data: string }[]): string {
  const packed = concat(
    txs.map((t) =>
      solidityPacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [t.operation, t.to, t.value, getBytes(t.data).length, t.data])
    )
  );
  return MULTISEND_IFACE.encodeFunctionData('multiSend', [packed]);
}

function safeTx(to: string, value: bigint, data: string, operation: SafeOperation, nonce: bigint): SafeTx {
  return { to, value, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZeroAddress, refundReceiver: ZeroAddress, nonce };
}

/**
 * One-round settlement: a single Safe transaction that delegatecalls MultiSend to
 *   1. mark the SettleRoot digest as signed by the Safe (SignMessageLib, delegatecall), and
 *   2. call postEpochRoot with an empty signature, which the client's ERC-1271 check accepts
 *      because the Safe has signed the digest in step 1.
 * Owners sign one SafeTx hash, which commits to the root, the tree URI, the epoch and the bond.
 */
export function buildOneRoundSettlement(
  client: string,
  r: SettlementRequest,
  nonce: bigint,
  libs: { multiSend: string; signMessageLib: string } = SAFE_V141
): SafeTx {
  const digest = settleRootDigest(r);
  const message = AbiCoder.defaultAbiCoder().encode(['bytes32'], [digest]);
  const data = encodeMultiSend([
    { operation: SafeOperation.DelegateCall, to: libs.signMessageLib, value: 0n, data: SIGN_MESSAGE_IFACE.encodeFunctionData('signMessage', [message]) },
    { operation: SafeOperation.Call, to: client, value: r.bond, data: CLIENT_IFACE.encodeFunctionData('postEpochRoot', [r.epoch, r.merkleRoot, r.treeURI, '0x']) }
  ]);
  return safeTx(libs.multiSend, 0n, data, SafeOperation.DelegateCall, nonce);
}

/**
 * Two-round settlement: owners first sign the SafeMessage hash (`safeMessageHash`); the packed
 * signatures become postEpochRoot's `sig`; owners then sign this plain call.
 */
export function buildTwoRoundSettlement(client: string, r: SettlementRequest, erc1271Signature: string, nonce: bigint): SafeTx {
  const data = CLIENT_IFACE.encodeFunctionData('postEpochRoot', [r.epoch, r.merkleRoot, r.treeURI, erc1271Signature]);
  return safeTx(client, r.bond, data, SafeOperation.Call, nonce);
}

/** Safe's checkSignatures wants 65-byte signatures ordered by strictly ascending owner address. */
export function packSignatures(sigs: OwnerSignature[]): string {
  const sorted = [...sigs].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) {
    if (BigInt(sorted[i]!.signer) === BigInt(sorted[i - 1]!.signer)) {
      throw new DriftValidationError(`DRIFT SDK: duplicate Safe owner signature from ${sorted[i]!.signer}.`);
    }
  }
  return concat(sorted.map((s) => s.signature));
}

export function encodeExecTransaction(tx: SafeTx, signatures: string): string {
  return SAFE_IFACE.encodeFunctionData('execTransaction', [
    tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signatures
  ]);
}

/**
 * Tier 2 settlement through a Safe whose owners are independent engine operators.
 *
 * Each owner computes the epoch with its own engine (`proposeFromEngine`), builds the settlement
 * transaction from its own result and signs it. Owners who computed the same root build the same
 * transaction and therefore sign the same hash; an owner who computed a different root signs a
 * different hash, and its signature cannot count towards the threshold for anyone else's root.
 * Anyone holding `threshold` matching signatures can then submit (`execute`); the submitter needs
 * gas but no authority. The tree URI must be identical across owners, which a content-addressed
 * transport (IPFS) gives for free when the trees are identical.
 */
export class SafeSettler {
  private readonly safeContract: Contract;

  constructor(
    public readonly runner: ContractRunner,
    public readonly safe: string,
    public readonly client: string,
    private readonly libs: { multiSend: string; signMessageLib: string } = SAFE_V141
  ) {
    this.safeContract = new Contract(safe, SAFE_IFACE, runner);
  }

  async chainId(): Promise<bigint> {
    const provider = this.runner.provider;
    if (!provider) throw new DriftConfigError('DRIFT SDK: SafeSettler needs a runner with a provider.');
    return (await provider.getNetwork()).chainId;
  }

  /** The Safe's owners, checksummed. */
  async owners(): Promise<string[]> {
    return ((await this.safeContract.getOwners!()) as string[]).map((o) => getAddress(o));
  }

  async threshold(): Promise<bigint> {
    return BigInt(await this.safeContract.getThreshold!());
  }

  async nonce(): Promise<bigint> {
    return BigInt(await this.safeContract.nonce!());
  }

  async clientDomain(): Promise<TypedDataDomain> {
    const d = await new Contract(this.client, EIP712_ABI, this.runner).eip712Domain!();
    return { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract };
  }

  /** Builds the one-round settlement for `merkleRoot` at the Safe's current nonce. */
  async prepare(r: Omit<SettlementRequest, 'clientDomain'>): Promise<{ tx: SafeTx; hash: string }> {
    const [domain, nonce, chainId] = await Promise.all([this.clientDomain(), this.safeContract.nonce!(), this.chainId()]);
    const tx = buildOneRoundSettlement(this.client, { ...r, clientDomain: domain }, BigInt(nonce), this.libs);
    return { tx, hash: safeTxHash(this.safe, chainId, tx) };
  }

  /** Computes the epoch with `engine` and prepares the settlement of the root it produced. */
  async proposeFromEngine(
    engine: IEpochEngine,
    input: EpochInput,
    treeURI: string,
    bond: bigint
  ): Promise<{ result: EpochResult; tx: SafeTx; hash: string }> {
    const result = await engine.computeEpoch(input);
    const prepared = await this.prepare({ contextUID: input.contextUID, epoch: input.epoch, merkleRoot: result.merkleRoot, treeURI, bond });
    return { result, ...prepared };
  }

  async sign(owner: Signer, tx: SafeTx): Promise<OwnerSignature> {
    const signature = await owner.signTypedData(safeDomain(this.safe, await this.chainId()), SAFE_TX_TYPES, tx);
    return { signer: await owner.getAddress(), signature };
  }

  /**
   * Submits `tx` once `signatures` reach the Safe's threshold. Each signature is checked against
   * the transaction hash and the owner set first, so a mismatched root fails here with a clear
   * message instead of as an opaque GS026 revert.
   */
  async execute(sender: Signer, tx: SafeTx, signatures: OwnerSignature[]): Promise<TransactionResponse> {
    const [chainId, owners, threshold] = await Promise.all([this.chainId(), this.safeContract.getOwners!(), this.safeContract.getThreshold!()]);
    const hash = safeTxHash(this.safe, chainId, tx);
    const ownerSet = new Set((owners as string[]).map((o) => o.toLowerCase()));
    const valid = signatures.filter((s) => {
      const recovered = recoverAddress(hash, s.signature).toLowerCase();
      return recovered === s.signer.toLowerCase() && ownerSet.has(recovered);
    });
    if (BigInt(valid.length) < BigInt(threshold)) {
      throw new DriftValidationError(
        `DRIFT SDK: ${valid.length} of ${signatures.length} signatures are valid owner signatures over this settlement; the Safe needs ${threshold}.`
      );
    }
    return sender.sendTransaction({ to: this.safe, data: encodeExecTransaction(tx, packSignatures(valid)) });
  }
}
