import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { JsonRpcProvider, formatEther, formatUnits, parseEther } from 'ethers';
import { parseExperimentConfig, type ExperimentConfig } from './config.js';
import { deriveSlots, deriveWallet, loadFunder, loadMnemonic, newMnemonic, slotIndices } from './keys.js';
import { gasTable, loadMeasured } from './gas.js';
import { buildPlan, topUps, type FundingPlan } from './plan.js';
import { assertPlanMatches, readPlan, writeManifest, writePlan } from './planFile.js';
import { balancesOf, fund, status, sweep, TRANSFER_GAS, type Log } from './ops.js';
import { measure, writeMeasured } from './measure.js';
import { feeHistory, feeReport, printFeeReport } from './fees.js';

const CONTRACTS_DIR = fileURLToPath(new URL('../../contracts', import.meta.url));

const USAGE = `usage: drift-e2e <command> [options]

  keys new                              print a fresh 24-word mnemonic (store it; it is not saved)
  keys manifest --config <file>         write <out>/keys-manifest.json (addresses only)
  plan    --config <file> [--measured <gas.json>] [--offline]
  fund    --config <file> [--yes]       top up every key to its planned target (dry run without --yes)
  status  --config <file>               balance vs target per key
  sweep   --config <file> [--yes] [--dust-eth <x>]   return leftovers to the funder
  measure --config <file>               run every action once on a local anvil fork of the config's
                                        chain (never broadcasts there); writes <out>/gas-measured.json
  fees    --config <file> [--blocks <n>] [--caps 1,2,5]   base-fee percentiles from eth_feeHistory (read-only)

  fund and sweep wait while the base fee is above the cap (--wait-minutes, default 60); they never pay more.

  common: --out <dir> (default ./e2e-run)
  environment: the variables the config names (RPC URL, experiment mnemonic, funder key)`;

interface Args {
  cmd: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const cmd: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && !['--yes', '--offline'].includes(a)) {
        flags.set(a.slice(2), next);
        i++;
      } else flags.set(a.slice(2), true);
    } else cmd.push(a);
  }
  return { cmd, flags };
}

const str = (args: Args, name: string): string | undefined => {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
};

function loadConfig(args: Args): ExperimentConfig {
  const path = str(args, 'config');
  if (!path) throw new Error('--config <file> is required');
  return parseExperimentConfig(JSON.parse(readFileSync(path, 'utf8')));
}

function outDir(args: Args): string {
  const dir = str(args, 'out') ?? 'e2e-run';
  mkdirSync(dir, { recursive: true });
  return dir;
}

function provider(cfg: ExperimentConfig, env: NodeJS.ProcessEnv): JsonRpcProvider {
  const url = env[cfg.rpcUrlEnv];
  if (!url) throw new Error(`environment variable ${cfg.rpcUrlEnv} is not set`);
  // No read cache: balances must be current.
  return new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
}

const waitMs = (args: Args): number => Number(str(args, 'wait-minutes') ?? '60') * 60_000;

const eth = (wei: bigint) => `${Number(formatEther(wei)).toFixed(6)} ETH`;

function printPlan(plan: FundingPlan, log: Log): void {
  log(`plan for chain ${plan.chainId}, gas cap ${formatUnits(plan.maxFeeWei, 'gwei')} gwei, margin x${Number(plan.marginBps) / 10_000}`);
  log('');
  log('per role:');
  const roles = new Map<string, { keys: number; funded: number; target: bigint; capital: bigint }>();
  for (const k of plan.keys) {
    const r = roles.get(k.role) ?? { keys: 0, funded: 0, target: 0n, capital: 0n };
    r.keys++;
    if (k.targetWei > 0n) r.funded++;
    r.target += k.targetWei;
    r.capital += k.capitalWei;
    roles.set(k.role, r);
  }
  for (const [role, r] of roles) log(`  ${role.padEnd(14)} ${String(r.keys).padStart(5)} key(s)  ${eth(r.target).padStart(16)}  (bonds/capital ${eth(r.capital)})`);
  log('');
  log('per action (gas at the cap, before margin):');
  const actions = new Map<string, { count: number; gas: bigint; source: string }>();
  for (const k of plan.keys) {
    for (const a of k.actions) {
      const e = actions.get(a.action) ?? { count: 0, gas: a.gasEach, source: a.source };
      e.count += a.count;
      actions.set(a.action, e);
    }
  }
  for (const [action, e] of actions) {
    const mark = e.source === 'estimate' ? ' *' : '';
    log(`  ${(action + mark).padEnd(26)} ${String(e.count).padStart(6)} x ${String(e.gas).padStart(9)} gas = ${eth(BigInt(e.count) * e.gas * plan.maxFeeWei).padStart(16)}`);
  }
  log('');
  log(`keys total        ${eth(plan.totalTargetWei)}`);
  log(`funder fees       ${eth(plan.funderFeeWei)}`);
  log(`reserve           ${eth(plan.reserveWei)}`);
  log(`required (from empty keys) ${eth(plan.requiredWei)}`);
  if (plan.estimatedActions.length) {
    log('');
    log(`* ${plan.estimatedActions.length} action(s) still use ESTIMATED gas; run measure on a Sepolia fork before funding for real.`);
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, log: Log = console.log): Promise<number> {
  const args = parseArgs(argv);
  const [cmd, sub] = args.cmd;
  try {
    if (cmd === 'keys' && sub === 'new') {
      log(newMnemonic());
      log('Store this mnemonic now (password manager); it is not written anywhere. Every experiment key derives from it.');
      return 0;
    }
    if (!cmd || cmd === 'help' || args.flags.has('help')) {
      log(USAGE);
      return cmd ? 0 : 2;
    }
    const cfg = loadConfig(args);
    const dir = outDir(args);
    const mnemonic = loadMnemonic(cfg.mnemonicEnv, env);
    const slots = deriveSlots(mnemonic, slotIndices(cfg));
    const planPath = join(dir, 'funding-plan.json');

    if (cmd === 'keys' && sub === 'manifest') {
      writeManifest(join(dir, 'keys-manifest.json'), slots);
      log(`wrote ${slots.length} key(s) to ${join(dir, 'keys-manifest.json')}`);
      return 0;
    }

    if (cmd === 'plan') {
      const measured = str(args, 'measured');
      const plan = buildPlan(cfg, slots, gasTable(measured ? loadMeasured(measured) : {}));
      writePlan(planPath, plan);
      writeManifest(join(dir, 'keys-manifest.json'), slots);
      printPlan(plan, log);
      log(`wrote ${planPath}`);
      if (args.flags.has('offline')) return 0;
      const p = provider(cfg, env);
      const funder = loadFunder(cfg.funder, env).connect(p);
      const [funderBal, balances] = await Promise.all([p.getBalance(funder.address), balancesOf(p, plan.keys.map((k) => k.address))]);
      const todo = topUps(plan, balances);
      const needNow = todo.reduce((s, t) => s + t.amount, 0n) + BigInt(todo.length) * TRANSFER_GAS * plan.maxFeeWei + plan.reserveWei;
      log(`funder ${funder.address}: ${eth(funderBal)}; needed now (current key balances, fees, reserve): ${eth(needNow)}`);
      if (needNow > funderBal) {
        log(`NOT ENOUGH: short by ${eth(needNow - funderBal)}. Reduce the experiment or the gas cap; nothing was sent.`);
        return 1;
      }
      log('the funder can cover this plan.');
      return 0;
    }

    if (cmd === 'measure') {
      const forkUrl = env[cfg.rpcUrlEnv];
      if (!forkUrl) throw new Error(`environment variable ${cfg.rpcUrlEnv} is not set`);
      // When a plan exists, the deployer must be the one it funds.
      const existing = existsSync(planPath) ? readPlan(planPath) : undefined;
      if (existing) assertPlanMatches(existing, slots);
      const result = await measure({ forkUrl, experimentMnemonic: mnemonic, contractsDir: str(args, 'contracts') ?? CONTRACTS_DIR, plan: existing, log });
      const out = join(dir, 'gas-measured.json');
      writeMeasured(out, result);
      log(`wrote ${out} (${result.samples.length} transactions, fork block ${result.forkBlock})`);
      return 0;
    }
    if (cmd === 'fees') {
      const blocks = Number(str(args, 'blocks') ?? '5000');
      const caps = (str(args, 'caps') ?? '1,2,3,5,10,20').split(',');
      const report = feeReport(await feeHistory(provider(cfg, env), blocks), cfg.gas.priorityFeeWei, caps);
      printFeeReport(report, log, cfg.gas.priorityFeeWei);
      return 0;
    }

    const plan = readPlan(planPath);
    assertPlanMatches(plan, slots);
    const p = provider(cfg, env);

    if (cmd === 'fund') {
      const funder = loadFunder(cfg.funder, env).connect(p);
      await fund(plan, funder, { yes: args.flags.has('yes'), priorityWei: cfg.gas.priorityFeeWei, journalPath: join(dir, 'funding-journal.jsonl'), log, waitMs: waitMs(args) });
      return 0;
    }
    if (cmd === 'status') {
      const rows = await status(plan, p);
      for (const r of rows) log(`  ${r.ok ? 'ok ' : 'LOW'} ${r.role.padEnd(14)} ${String(r.ordinal).padStart(4)} ${r.address} ${eth(r.balanceWei).padStart(16)} / ${eth(r.targetWei)}`);
      const low = rows.filter((r) => !r.ok).length;
      log(low ? `${low} key(s) below target` : 'all keys at or above target');
      return low ? 1 : 0;
    }
    if (cmd === 'sweep') {
      const funder = loadFunder(cfg.funder, env);
      const dust = str(args, 'dust-eth');
      const keys = plan.keys.map((k) => ({ role: k.role, ordinal: k.ordinal, signer: deriveWallet(mnemonic, k.index).connect(p) }));
      await sweep(keys, funder.address, plan.chainId, {
        yes: args.flags.has('yes'), maxFeeWei: plan.maxFeeWei, priorityWei: cfg.gas.priorityFeeWei,
        dustWei: dust ? parseEther(dust) : 0n, journalPath: join(dir, 'funding-journal.jsonl'), log, waitMs: waitMs(args)
      });
      return 0;
    }
    log(USAGE);
    return 2;
  } catch (err) {
    log(`error: ${(err as Error).message}`);
    return 1;
  }
}
