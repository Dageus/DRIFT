// Messages of the Tier 2 commit-reveal round. Every message is EIP-712 typed data in the Safe's
// domain { chainId, verifyingContract: safe }. Their type names differ from SafeTx and SafeMessage,
// so no signature made here is valid as a Safe transaction or as an ERC-1271 message signature.
import { AbiCoder, getAddress, keccak256, verifyTypedData, type Signer } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();

export const PROPOSAL_TYPES = {
  EpochProposal: [
    { name: 'proposalId', type: 'bytes32' },
    { name: 'client', type: 'address' },
    { name: 'contextUID', type: 'bytes32' },
    { name: 'epoch', type: 'uint256' },
    { name: 'safeNonce', type: 'uint256' },
    { name: 'commitDeadline', type: 'uint64' },
    { name: 'revealDeadline', type: 'uint64' }
  ]
};

export const COMMITMENT_TYPES = {
  RootCommitment: [
    { name: 'proposalId', type: 'bytes32' },
    { name: 'owner', type: 'address' },
    { name: 'commitment', type: 'bytes32' }
  ]
};

export const REVEAL_TYPES = {
  RootReveal: [
    { name: 'proposalId', type: 'bytes32' },
    { name: 'owner', type: 'address' },
    { name: 'root', type: 'bytes32' },
    { name: 'inputDigest', type: 'bytes32' },
    { name: 'salt', type: 'bytes32' },
    { name: 'seenCommitments', type: 'bytes32' }
  ]
};

const SALT_TYPES = { RootSalt: [{ name: 'proposalId', type: 'bytes32' }] };

export interface Tier2Proposal {
  proposalId: string;
  chainId: bigint;
  safe: string;
  client: string;
  contextUID: string;
  epoch: bigint;
  safeNonce: bigint;
  /** Unix seconds. Commitments are accepted up to and including this time. */
  commitDeadline: bigint;
  /** Unix seconds. Reveals are accepted after commitDeadline, up to and including this time. */
  revealDeadline: bigint;
  proposer: string;
  signature: string;
}

export interface SignedCommitment {
  proposalId: string;
  owner: string;
  commitment: string;
  signature: string;
}

export interface SignedReveal {
  proposalId: string;
  owner: string;
  root: string;
  inputDigest: string;
  salt: string;
  /** The commitments present when the owner revealed, sorted by owner; hashed into the signature. */
  seen: { owner: string; commitment: string }[];
  signature: string;
}

const domain = (chainId: bigint, safe: string) => ({ chainId, verifyingContract: getAddress(safe) });

/** keccak256(abi.encode(client, contextUID, epoch, safeNonce)). */
export function tier2ProposalId(client: string, contextUID: string, epoch: bigint, safeNonce: bigint): string {
  return keccak256(coder.encode(['address', 'bytes32', 'uint256', 'uint256'], [client, contextUID, epoch, safeNonce]));
}

/** keccak256(abi.encode(root, inputDigest, salt)). */
export function commitmentHash(root: string, inputDigest: string, salt: string): string {
  return keccak256(coder.encode(['bytes32', 'bytes32', 'bytes32'], [root, inputDigest, salt]));
}

/** Canonical form of a commitment snapshot: sorted by owner, lowercased. */
export function canonicalSeen(seen: { owner: string; commitment: string }[]): { owner: string; commitment: string }[] {
  return seen
    .map((s) => ({ owner: s.owner.toLowerCase(), commitment: s.commitment.toLowerCase() }))
    .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
}

export function seenCommitmentsHash(seen: { owner: string; commitment: string }[]): string {
  const c = canonicalSeen(seen);
  return keccak256(coder.encode(['address[]', 'bytes32[]'], [c.map((s) => s.owner), c.map((s) => s.commitment)]));
}

/**
 * The owner's salt for a proposal: keccak256 of its signature over RootSalt(proposalId). Deriving
 * it lets commit and reveal run as separate, stateless steps. It needs a deterministic signer
 * (RFC 6979, as ethers' Wallet is); revealEpochTier2 detects a signer that is not and asks for an
 * explicit salt instead.
 */
export async function deriveSalt(owner: Signer, chainId: bigint, safe: string, proposalId: string): Promise<string> {
  return keccak256(await owner.signTypedData(domain(chainId, safe), SALT_TYPES, { proposalId }));
}

export async function signProposal(
  proposer: Signer,
  p: Omit<Tier2Proposal, 'proposer' | 'signature'>
): Promise<Tier2Proposal> {
  const signature = await proposer.signTypedData(domain(p.chainId, p.safe), PROPOSAL_TYPES, p);
  return { ...p, proposer: getAddress(await proposer.getAddress()), signature };
}

export async function signCommitment(
  owner: Signer,
  chainId: bigint,
  safe: string,
  c: Omit<SignedCommitment, 'signature'>
): Promise<SignedCommitment> {
  return { ...c, signature: await owner.signTypedData(domain(chainId, safe), COMMITMENT_TYPES, c) };
}

export async function signReveal(
  owner: Signer,
  chainId: bigint,
  safe: string,
  r: Omit<SignedReveal, 'signature'>
): Promise<SignedReveal> {
  const seen = canonicalSeen(r.seen);
  const message = { ...r, seenCommitments: seenCommitmentsHash(seen) };
  return { ...r, seen, signature: await owner.signTypedData(domain(chainId, safe), REVEAL_TYPES, message) };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function proposalSigner(p: Tier2Proposal): string | null {
  try {
    // The typed-data encoder reads only the fields PROPOSAL_TYPES names.
    return verifyTypedData(domain(p.chainId, p.safe), PROPOSAL_TYPES, p, p.signature);
  } catch {
    return null;
  }
}

/** True when the commitment is signed by the owner it names. */
export function commitmentIsSigned(chainId: bigint, safe: string, c: SignedCommitment): boolean {
  try {
    const { signature, ...message } = c;
    return same(verifyTypedData(domain(chainId, safe), COMMITMENT_TYPES, message, signature), c.owner);
  } catch {
    return false;
  }
}

/** True when the reveal is signed by the owner it names, over its own snapshot. */
export function revealIsSigned(chainId: bigint, safe: string, r: SignedReveal): boolean {
  try {
    const { signature, seen, ...rest } = r;
    const message = { ...rest, seenCommitments: seenCommitmentsHash(seen) };
    return same(verifyTypedData(domain(chainId, safe), REVEAL_TYPES, message, signature), r.owner);
  } catch {
    return false;
  }
}

