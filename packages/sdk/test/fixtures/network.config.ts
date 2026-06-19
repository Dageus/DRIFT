import { JsonRpcProvider, Wallet, Mnemonic, HDNodeWallet } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

export interface DeploymentAddresses {
  DRIFTCore: string;
  DRIFTToken: string;
  Factory: string;
  WeightedGovernanceTemplate: string;
  EASAdapter?: string;
}

export function loadDeployments(chainId: string): DeploymentAddresses {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, '..', '..', '..', '..', 'deployments', `${chainId}.json`),
    path.join(cwd, '..', '..', '..', 'packages', 'contracts', 'deployments', `${chainId}.json`),
    path.join(cwd, '..', 'contracts', 'deployments', `${chainId}.json`),
    path.join(cwd, 'deployments', `${chainId}.json`)
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  throw new Error(`No deployment found for chain ${chainId}`);
}

export function deriveWallets(mnemonicStr: string, provider: JsonRpcProvider) {
  const mnemonic = Mnemonic.fromPhrase(mnemonicStr);
  const derive = (index: number) => {
    const hd = HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`);
    return new Wallet(hd.privateKey, provider);
  };

  return {
    deployer: derive(0),
    tester: derive(2),
    alice: derive(3),
    bob: derive(4)
  };
}

export async function getPendingNonceHelper(provider: JsonRpcProvider, address: string): Promise<number> {
  const hex = await provider.send('eth_getTransactionCount', [address, 'pending']);
  return parseInt(hex, 16);
}

export async function sendWithSyncedNonceHelper(
  provider: JsonRpcProvider,
  wallet: Wallet,
  tx: Record<string, any>
): Promise<any> {
  const nonce = await getPendingNonceHelper(provider, await wallet.getAddress());
  return wallet.sendTransaction({ ...tx, nonce });
}
