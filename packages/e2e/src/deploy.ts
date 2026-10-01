import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Contract, ZeroHash, type Provider } from 'ethers';
import { deriveSlots } from './keys.js';
import type { FundingPlan } from './plan.js';

/**
 * Environment for a forge script run on behalf of the experiment. Deploy.s.sol and E2EContext.s.sol
 * read MNEMONIC and deploy from its index 0; in the user's shell MNEMONIC holds the funded account,
 * so it is never inherited: it is always replaced by the experiment mnemonic passed in.
 */
export function forgeEnv(experimentMnemonic: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MNEMONIC;
  delete env.PRIVATE_KEY;
  return { ...env, ...extra, MNEMONIC: experimentMnemonic };
}

/** The experiment deployer (index 0), checked against the plan's deployer when a plan is given. */
export function experimentDeployer(experimentMnemonic: string, plan?: FundingPlan): string {
  const [d] = deriveSlots(experimentMnemonic, [{ role: 'deployer', ordinal: 0, index: 0 }]);
  const address = d!.address;
  if (plan) {
    const planned = plan.keys.find((k) => k.role === 'deployer');
    if (!planned) throw new Error('the plan has no deployer key');
    if (planned.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`the experiment mnemonic derives deployer ${address}, but the plan funds ${planned.address}; refusing to deploy`);
    }
  }
  return address;
}

export interface Deployment {
  DRIFTCore: string;
  DRIFTToken: string;
  Factory: string;
  WeightedGovernanceTemplate: string;
}

/**
 * Runs Deploy.s.sol from the experiment mnemonic and checks the result: the core's admin must be
 * the experiment deployer, so a deployment from any other key is detected immediately.
 */
export async function runDeploy(opts: {
  contractsDir: string;
  rpcUrl: string;
  experimentMnemonic: string;
  deploymentFile: string;
  provider: Provider;
  plan?: FundingPlan;
}): Promise<Deployment> {
  const deployer = experimentDeployer(opts.experimentMnemonic, opts.plan);
  const r = spawnSync('forge', ['script', 'script/Deploy.s.sol:DeployScript', '--rpc-url', opts.rpcUrl, '--broadcast', '--slow'], {
    cwd: opts.contractsDir,
    env: forgeEnv(opts.experimentMnemonic, { DRIFT_DEPLOYMENT_FILE: opts.deploymentFile }),
    encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error(`forge script Deploy.s.sol failed:\n${r.stdout}\n${r.stderr}`);
  const d = JSON.parse(readFileSync(`${opts.contractsDir}/deployments/${opts.deploymentFile}`, 'utf8')) as Deployment;
  const core = new Contract(d.DRIFTCore, ['function hasRole(bytes32,address) view returns (bool)'], opts.provider);
  if (!(await core.hasRole!(ZeroHash, deployer))) {
    throw new Error(`the deployed core's admin is not the experiment deployer ${deployer}; the wrong key deployed`);
  }
  return d;
}
