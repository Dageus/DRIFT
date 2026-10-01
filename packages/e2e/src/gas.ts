import { readFileSync } from 'node:fs';

/**
 * Total gas per transaction kind: intrinsic 21,000 + calldata + execution. Estimates come from the
 * Foundry gas snapshots (execution only) plus the intrinsic cost and a calldata allowance at 16
 * gas per byte, or for deployments from bytecode size (32,000 create + 16/initcode byte + 200/
 * runtime byte + a constructor allowance). They are deliberately on the high side; `measure`
 * (Phase 2) replaces them with receipts from a Sepolia fork.
 */
export type Action =
  | 'deployCoreImpl'
  | 'deployCoreProxy'
  | 'deployToken'
  | 'setDriftToken'
  | 'deployFactory'
  | 'grantFactoryRole'
  | 'deployTemplate'
  | 'registerSchema'
  | 'createSafe'
  | 'fundSafe'
  | 'registerContext'
  | 'deployClientClone'
  | 'grantContextAdmin'
  | 'setDisputeWindow'
  | 'setResponseWindow'
  | 'setSettlementBond'
  | 'setChallengeBond'
  | 'setResponseGasEstimate'
  | 'setEpochLength'
  | 'assignRole'
  | 'registerNode'
  | 'easAttest'
  | 'easMultiAttest'
  | 'easMultiAttestBase'
  | 'easMultiAttestPerItem'
  | 'postEpochRoot'
  | 'safeExecSettlement'
  | 'respondToChallenge'
  | 'challengeOmission'
  | 'claimUnansweredChallenge'
  | 'withdrawSettlementBond'
  | 'claimReputation'
  | 'createProposal'
  | 'castVote'
  | 'transfer';

export interface GasEntry {
  gas: bigint;
  source: 'estimate' | 'measured';
  note: string;
}

export type GasTable = Record<Action, GasEntry>;

const TX = 21_000n;
const est = (gas: number, note: string): GasEntry => ({ gas: BigInt(gas), source: 'estimate', note });
const snap = (execution: number, calldataBytes: number, snapshot: string): GasEntry =>
  est(Number(TX) + execution + calldataBytes * 16, `${snapshot} ${execution} + 21000 + ${calldataBytes}B calldata`);
const create = (initBytes: number, runtimeBytes: number, ctor: number, what: string): GasEntry =>
  est(21_000 + 32_000 + initBytes * 16 + runtimeBytes * 200 + ctor, `${what}: create from bytecode (${initBytes}B init, ${runtimeBytes}B runtime) + ${ctor} constructor allowance`);

export const ESTIMATES: GasTable = {
  deployCoreImpl: create(11_436, 11_205, 50_000, 'DRIFTCore implementation'),
  deployCoreProxy: create(800, 130, 250_000, 'ERC1967Proxy + DRIFTCore.initialize'),
  deployToken: create(4_151, 3_758, 80_000, 'DRIFTToken'),
  setDriftToken: est(80_000, 'one storage write + role check, no snapshot'),
  deployFactory: create(1_275, 1_140, 50_000, 'DRIFTClientFactory'),
  grantFactoryRole: est(80_000, 'AccessControl.grantRole, no snapshot'),
  deployTemplate: create(23_370, 23_163, 80_000, 'WeightedGovernanceClient template'),
  registerSchema: est(250_000, 'EAS SchemaRegistry.register, no measurement yet'),
  createSafe: est(400_000, 'SafeProxyFactory.createProxyWithNonce + setup (3 owners), no measurement yet'),
  fundSafe: est(40_000, 'ETH transfer into a Safe proxy (receive emits an event), above a plain 21000'),
  registerContext: snap(130_130, 200, 'RegisterContext'),
  deployClientClone: snap(377_499, 900, 'DeployClientClone'),
  grantContextAdmin: est(80_000, 'AccessControl.grantRole, no snapshot'),
  setDisputeWindow: snap(47_275, 40, 'SetDisputeWindow'),
  setResponseWindow: snap(46_840, 40, 'SetResponseWindow'),
  setSettlementBond: snap(47_570, 40, 'SetSettlementBond'),
  setChallengeBond: snap(46_981, 40, 'SetChallengeBond'),
  setResponseGasEstimate: est(70_000, 'one storage write, no snapshot'),
  setEpochLength: est(90_000, 'sets length and anchor, no snapshot'),
  assignRole: snap(93_491, 100, 'AssignRole'),
  registerNode: snap(63_830, 200, 'RegisterNode'),
  easAttest: est(250_000, 'EAS.attest on Sepolia, no measurement yet'),
  easMultiAttest: est(0, 'computed per batch from easMultiAttestBase + k x easMultiAttestPerItem'),
  easMultiAttestBase: est(60_000, 'multiAttest fixed cost, no measurement yet'),
  easMultiAttestPerItem: est(200_000, 'multiAttest cost per attestation, no measurement yet'),
  postEpochRoot: snap(125_375, 400, 'PostRoot_O1_Cost'),
  safeExecSettlement: snap(208_857, 1_300, 'PostRoot_Safe2of3_OneRound'),
  respondToChallenge: snap(20_758, 900, 'RespondToChallenge_Depth20'),
  challengeOmission: snap(149_353, 100, 'ChallengeOmission'),
  claimUnansweredChallenge: snap(62_006, 100, 'ClaimUnansweredChallenge'),
  withdrawSettlementBond: snap(14_136, 40, 'WithdrawSettlementBond'),
  claimReputation: snap(93_986, 600, 'Claim_Depth_10_Users_1024'),
  createProposal: est(300_000, 'createProposalWithProofs, no snapshot'),
  castVote: snap(59_397, 700, 'Vote_Depth_10_Users_1024'),
  transfer: est(21_000, 'plain ETH transfer between EOAs (exact)')
};

/** A measured table, as `measure` writes it: { actions: { action: { gas: "123", note } } }. */
export function loadMeasured(path: string): Partial<GasTable> {
  const file = JSON.parse(readFileSync(path, 'utf8')) as { actions?: Record<string, { gas: string | number; note?: string }> };
  if (!file.actions) throw new Error(`${path}: not a measured gas table (no actions)`);
  const out: Partial<GasTable> = {};
  for (const [k, v] of Object.entries(file.actions)) {
    if (!(k in ESTIMATES)) throw new Error(`${path}: unknown action ${k}`);
    const gas = BigInt(v.gas);
    if (gas <= 0n) throw new Error(`${path}: ${k} has non-positive gas`);
    out[k as Action] = { gas, source: 'measured', note: v.note ?? 'measured' };
  }
  return out;
}

/** Estimates, with measured entries taking precedence. */
export function gasTable(measured: Partial<GasTable> = {}): GasTable {
  return { ...ESTIMATES, ...measured };
}
