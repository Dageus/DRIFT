// Opt-in (DRIFT_E2E_ANVIL=1): the CLI end to end against a fresh anvil. plan -> fund (dry run) ->
// fund --yes -> fund again sends nothing -> status -> sweep --yes returns the funds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcProvider, formatEther, parseEther } from 'ethers';
import { main } from '../../src/cli.js';
import { newMnemonic } from '../../src/keys.js';
import { readPlan } from '../../src/planFile.js';
import { baseConfig } from './fixtures.js';

const enabled = !!process.env.DRIFT_E2E_ANVIL && spawnSync('which', ['anvil']).status === 0;
const port = 19545 + Math.floor(Math.random() * 1000);
// anvil's account 0, publicly known; only ever used against a local chain.
const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_ADDR_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

describe.skipIf(!enabled)('funding CLI on anvil', () => {
  let anvil: ChildProcess;
  let dir: string;
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 });
  const env = { E2E_RPC_URL: `http://127.0.0.1:${port}`, E2E_MNEMONIC: newMnemonic(), FUNDER_PRIVATE_KEY: ANVIL_KEY_0 };
  const lines: string[] = [];
  const log = (l: string) => void lines.push(l);
  const run = async (...argv: string[]) => {
    lines.length = 0;
    return main([...argv, '--config', join(dir, 'experiment.json'), '--out', join(dir, 'run')], env, log);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'drift-e2e-fund-'));
    writeFileSync(join(dir, 'experiment.json'), JSON.stringify(baseConfig({ nodes: 20 })));
    anvil = spawn('anvil', ['--port', String(port), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try {
        await provider.getBlockNumber();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('anvil did not start');
  }, 20_000);

  afterAll(() => {
    anvil?.kill('SIGKILL');
    provider.destroy();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('plans, funds once, refuses to fund twice, reports status and sweeps everything back', async () => {
    const start = await provider.getBalance(ANVIL_ADDR_0);

    expect(await run('plan')).toBe(0);
    expect(lines.join('\n')).toContain('the funder can cover this plan');
    const plan = readPlan(join(dir, 'run', 'funding-plan.json'));
    const funded = plan.keys.filter((k) => k.targetWei > 0n);

    expect(await run('fund')).toBe(0);
    expect(lines.join('\n')).toContain('dry run');
    expect(await provider.getBalance(funded[0]!.address)).toBe(0n);

    expect(await run('fund', '--yes')).toBe(0);
    for (const k of funded) expect(await provider.getBalance(k.address)).toBe(k.targetWei);
    const journal = readFileSync(join(dir, 'run', 'funding-journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { status: string });
    expect(journal.filter((j) => j.status === 'mined')).toHaveLength(funded.length);

    const nonceBefore = await provider.getTransactionCount(ANVIL_ADDR_0);
    expect(await run('fund', '--yes')).toBe(0);
    expect(lines.join('\n')).toContain('nothing to send');
    expect(await provider.getTransactionCount(ANVIL_ADDR_0)).toBe(nonceBefore);

    expect(await run('status')).toBe(0);
    expect(lines.join('\n')).toContain('all keys at or above target');

    const sent = funded.reduce((s, k) => s + k.targetWei, 0n);
    expect(await run('sweep', '--yes')).toBe(0);
    for (const k of funded) {
      // What remains is at most 21000 x (cap - effective gas price).
      expect(await provider.getBalance(k.address)).toBeLessThanOrEqual(21_000n * plan.maxFeeWei);
    }
    const end = await provider.getBalance(ANVIL_ADDR_0);
    const spent = start - end;
    // The round trip costs only transfer fees: well under 1% of what was sent here.
    expect(spent).toBeLessThan(sent / 100n + parseEther('0.001'));
    console.log(`funded ${funded.length} keys with ${formatEther(sent)} ETH; round trip cost ${formatEther(spent)} ETH`);
  }, 120_000);

  it('refuses a plan for another chain and a plan derived from another mnemonic', async () => {
    writeFileSync(join(dir, 'experiment.json'), JSON.stringify(baseConfig({ nodes: 20, chainId: 11155111 })));
    expect(await run('plan', '--offline')).toBe(0);
    expect(await run('fund')).toBe(1);
    expect(lines.join('\n')).toMatch(/plan is for chain 11155111; refusing/);

    writeFileSync(join(dir, 'experiment.json'), JSON.stringify(baseConfig({ nodes: 20 })));
    expect(await run('plan', '--offline')).toBe(0);
    const otherEnv = { ...env, E2E_MNEMONIC: newMnemonic() };
    lines.length = 0;
    expect(await main(['fund', '--config', join(dir, 'experiment.json'), '--out', join(dir, 'run')], otherEnv, log)).toBe(1);
    expect(lines.join('\n')).toMatch(/derives .* refusing/);
  }, 60_000);
});
