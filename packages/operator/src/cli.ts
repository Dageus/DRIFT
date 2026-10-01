// drift-operator CLI. The executable entry is bin.ts; this module stays importable for tests.
import { readFileSync } from 'fs';
import { pino } from 'pino';
import { parseConfig } from './daemon/config.js';
import { buildOperator, type Operator } from './daemon/wiring.js';

const USAGE = 'usage: drift-operator run --config <file.json>';

export function parseArgs(argv: string[]): { command: 'run'; config: string } {
  const [command, ...rest] = argv;
  if (command !== 'run') throw new Error(USAGE);
  const i = rest.indexOf('--config');
  const config = i >= 0 ? rest[i + 1] : undefined;
  if (!config) throw new Error(USAGE);
  return { command, config };
}

export async function main(): Promise<void> {
  const log = pino({ name: 'drift-operator', level: process.env.LOG_LEVEL ?? 'info' });
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  let op: Operator;
  try {
    const config = parseConfig(JSON.parse(readFileSync(args.config, 'utf8')));
    op = buildOperator(config, log);
    log.info({ contexts: config.contexts.map((c) => ({ name: c.name, roles: c.roles })) }, 'starting');
  } catch (err) {
    log.fatal({ err }, (err as Error).message);
    process.exit(1);
  }

  const shutdown = (signal: string) => {
    log.info({ signal }, 'stopping after the current tick');
    void Promise.all([op.daemon.stop(), op.api?.close()]).then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (op.api && op.listen) {
    try {
      await op.api.listen(op.listen);
    } catch (err) {
      log.fatal({ err }, 'API failed to listen');
      process.exit(1);
    }
  }
  op.daemon.start();
}
