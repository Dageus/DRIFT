import { describe, it, expect } from 'vitest';
import { JsonRpcProvider, Wallet } from 'ethers';
import { pino } from 'pino';
import { DriftConfigError } from '@drift-network/sdk';
import { parseConfig } from '../../src/daemon/config.js';
import { loadKey } from '../../src/daemon/keys.js';
import { OperatorDaemon } from '../../src/daemon/daemon.js';
import { parseArgs } from '../../src/cli.js';

const valid = {
  rpcUrl: 'http://127.0.0.1:8545',
  keys: { settler: { env: 'DRIFT_SETTLER_KEY' }, hotWallet: { env: 'DRIFT_HOT_KEY' } },
  attestations: { kind: 'eas', graphqlUrl: 'https://sepolia.easscan.org/graphql' },
  trees: { kind: 'ipfs', apiUrl: 'http://127.0.0.1:5001' },
  contexts: [{ name: 'uni', client: '0x' + 'c1'.repeat(20), roles: ['tier1'], schemaUID: '0x' + 'ab'.repeat(32) }]
};

describe('parseConfig', () => {
  it('applies defaults', () => {
    const c = parseConfig(valid);
    expect(c).toMatchObject({ blockTag: 'finalized', pollIntervalSeconds: 15, bondScanDepth: 64, engine: { kind: 'local' } });
  });

  it('reports every problem at once', () => {
    const bad = {
      ...valid,
      blockTag: 'pending',
      keys: { settler: { env: 'DRIFT_SETTLER_KEY', key: '0xdeadbeef' } },
      contexts: [
        { name: 'a', client: 'nope', roles: ['tier1', 'oracle'], schemaUID: '0x12' },
        { name: 'a', client: '0x' + 'c1'.repeat(20), roles: ['tier2-owner'], schemaUID: '0x' + 'ab'.repeat(32) }
      ]
    };
    let message = '';
    try {
      parseConfig(bad);
    } catch (e) {
      expect(e).toBeInstanceOf(DriftConfigError);
      message = (e as Error).message;
    }
    for (const fragment of [
      'blockTag',
      'remove the inline key',
      'contexts[0].client',
      'contexts[0].roles[1]',
      'contexts[0].schemaUID',
      'need keys.hotWallet',
      "duplicate context name 'a'",
      "'tier2-owner' needs keys.owner"
    ]) {
      expect(message).toContain(fragment);
    }
  });
});

describe('loadKey', () => {
  const provider = new JsonRpcProvider('http://127.0.0.1:1');
  it('loads from the named variable and never echoes a bad value', () => {
    const w = Wallet.createRandom();
    expect(loadKey({ env: 'K' }, provider, { K: w.privateKey }).address).toBe(w.address);
    expect(() => loadKey({ env: 'K' }, provider, {})).toThrow(/K is not set/);
    try {
      loadKey({ env: 'K' }, provider, { K: 'not-a-key-SECRET' });
    } catch (e) {
      expect((e as Error).message).toMatch(/K does not hold a valid private key/);
      expect((e as Error).message).not.toContain('SECRET');
    }
    provider.destroy();
  });
});

describe('OperatorDaemon', () => {
  it('records a failing job without stopping the others or the next tick', async () => {
    const ran: string[] = [];
    const daemon = new OperatorDaemon(
      [
        {
          config: { name: 'x', client: '0x' + 'c1'.repeat(20), roles: ['tier1'], schemaUID: '0x' + 'ab'.repeat(32) },
          jobs: [
            { role: 'tier1', run: async () => { ran.push('a'); throw new Error('rpc down'); } },
            { role: 'watcher', run: async () => { ran.push('b'); } }
          ]
        }
      ],
      pino({ level: 'silent' }),
      10
    );
    await daemon.tick();
    await daemon.tick();
    expect(ran).toEqual(['a', 'b', 'a', 'b']);
    expect(daemon.status()).toMatchObject({ ticks: 2, contexts: [{ lastError: 'tier1: rpc down' }] });
  });

  it('never overlaps ticks, and stop waits for the running one', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const daemon = new OperatorDaemon(
      [
        {
          config: { name: 'x', client: '0x' + 'c1'.repeat(20), roles: ['tier1'], schemaUID: '0x' + 'ab'.repeat(32) },
          jobs: [
            {
              role: 'tier1',
              run: async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise((r) => setTimeout(r, 20));
                active--;
                runs++;
              }
            }
          ]
        }
      ],
      pino({ level: 'silent' }),
      1
    );
    daemon.start();
    await new Promise((r) => setTimeout(r, 100));
    await daemon.stop();
    const after = runs;
    await new Promise((r) => setTimeout(r, 50));
    expect(maxActive).toBe(1);
    expect(runs).toBe(after);
    expect(runs).toBeGreaterThan(1);
  });
});

describe('cli', () => {
  it('parses run --config and rejects anything else', () => {
    expect(parseArgs(['run', '--config', 'op.json'])).toEqual({ command: 'run', config: 'op.json' });
    expect(() => parseArgs(['serve'])).toThrow(/usage/);
    expect(() => parseArgs(['run'])).toThrow(/usage/);
  });
});
