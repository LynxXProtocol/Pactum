/**
 * Web3Auth social login → Stellar Ed25519 keypair (Issue #214).
 *
 * Flow:
 * 1. User picks "Login with Google" (or other social via Web3Auth modal).
 * 2. Web3Auth provisions an app-scoped secp256k1 private key (non-custodial MPC).
 * 3. We deterministically derive a Stellar Ed25519 seed from that key and keep
 *    the Keypair in memory for signing (never persist the secret).
 *
 * Requires `VITE_WEB3AUTH_CLIENT_ID`. Without it, connect throws a clear error
 * so CI/builds still succeed and the Freighter path remains available.
 */

import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  WEB3AUTH_NETWORK,
  CHAIN_NAMESPACES,
  type IProvider,
  type CustomChainConfig,
} from '@web3auth/base';
import { CommonPrivateKeyProvider } from '@web3auth/base-provider';
import { Web3Auth } from '@web3auth/modal';
import { isStellarAddress } from './stellar';
import { WalletConnectionError, type WalletConnectionResult } from './wallet';
import { stellarKeypairFromWeb3AuthPrivateKey } from './web3authDerive';

export { stellarKeypairFromWeb3AuthPrivateKey } from './web3authDerive';

const CLIENT_ID = (import.meta.env.VITE_WEB3AUTH_CLIENT_ID as string | undefined)?.trim() ?? '';

const WEB3AUTH_NETWORK_NAME =
  (import.meta.env.VITE_WEB3AUTH_NETWORK as string | undefined)?.trim() === 'sapphire_mainnet'
    ? WEB3AUTH_NETWORK.SAPPHIRE_MAINNET
    : WEB3AUTH_NETWORK.SAPPHIRE_DEVNET;

const stellarChainConfig: CustomChainConfig = {
  chainNamespace: CHAIN_NAMESPACES.OTHER,
  chainId: '0x1',
  rpcTarget:
    (import.meta.env.VITE_SOROBAN_RPC_URL as string | undefined) ||
    'https://soroban-testnet.stellar.org',
  displayName: 'Stellar',
  ticker: 'XLM',
  tickerName: 'Stellar Lumens',
};

let web3auth: Web3Auth | null = null;
let activeKeypair: Keypair | null = null;

export function isWeb3AuthConfigured(): boolean {
  return CLIENT_ID.length > 0;
}

async function ensureClient(): Promise<Web3Auth> {
  if (!isWeb3AuthConfigured()) {
    throw new WalletConnectionError(
      'NOT_INSTALLED',
      'Social login is not configured. Set VITE_WEB3AUTH_CLIENT_ID (Web3Auth Dashboard) and rebuild.',
    );
  }
  if (web3auth) return web3auth;

  const privateKeyProvider = new CommonPrivateKeyProvider({
    config: { chainConfig: stellarChainConfig },
  });

  const client = new Web3Auth({
    clientId: CLIENT_ID,
    web3AuthNetwork: WEB3AUTH_NETWORK_NAME,
    privateKeyProvider,
    uiConfig: {
      appName: 'Pactum',
      mode: 'light',
      loginGridCol: 3,
      primaryButton: 'socialLogin',
    },
  });

  await client.init();
  web3auth = client;
  return web3auth;
}

async function keypairFromProvider(provider: IProvider): Promise<Keypair> {
  const priv = (await provider.request({ method: 'private_key' })) as string;
  if (!priv || typeof priv !== 'string') {
    throw new WalletConnectionError(
      'UNKNOWN',
      'Web3Auth did not return a private key after social login.',
    );
  }
  try {
    return stellarKeypairFromWeb3AuthPrivateKey(priv);
  } catch {
    throw new WalletConnectionError(
      'INVALID_ADDRESS',
      'Web3Auth returned an unusable private key for Stellar derivation.',
    );
  }
}

export async function connectWithWeb3Auth(): Promise<WalletConnectionResult> {
  const client = await ensureClient();

  try {
    const provider = client.provider ?? (await client.connect());
    if (!provider) {
      throw new WalletConnectionError(
        'CONNECTION_REJECTED',
        'Social login was cancelled or did not return a provider.',
      );
    }
    activeKeypair = await keypairFromProvider(provider);
  } catch (err) {
    if (err instanceof WalletConnectionError) throw err;
    throw new WalletConnectionError(
      'CONNECTION_REJECTED',
      err instanceof Error ? err.message : 'Social login failed.',
    );
  }

  const address = activeKeypair.publicKey();
  if (!isStellarAddress(address)) {
    throw new WalletConnectionError(
      'INVALID_ADDRESS',
      `Derived an invalid Stellar address from Web3Auth: ${address}`,
    );
  }

  return { address, provider: 'web3auth' };
}

export async function restoreWeb3AuthSession(
  expectedAddress?: string,
): Promise<WalletConnectionResult | null> {
  if (!isWeb3AuthConfigured()) return null;
  try {
    const client = await ensureClient();
    if (!client.connected || !client.provider) return null;
    activeKeypair = await keypairFromProvider(client.provider);
    const address = activeKeypair.publicKey();
    if (expectedAddress && address !== expectedAddress) {
      await logoutWeb3Auth();
      return null;
    }
    return { address, provider: 'web3auth' };
  } catch (err) {
    console.warn('[web3auth] session restore failed:', err);
    return null;
  }
}

export function getActiveWeb3AuthKeypair(): Keypair | null {
  return activeKeypair;
}

export async function logoutWeb3Auth(): Promise<void> {
  activeKeypair = null;
  try {
    if (web3auth?.connected) {
      await web3auth.logout();
    }
  } catch (err) {
    console.warn('[web3auth] logout error:', err);
  }
}

export function signTransactionWithWeb3Auth(
  unsignedXdr: string,
  networkPassphrase: string,
): string {
  const keypair = activeKeypair;
  if (!keypair) {
    throw new Error('Social-login wallet is not ready to sign. Please Login with Google again.');
  }
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  if (!('sign' in tx) || typeof (tx as { sign?: unknown }).sign !== 'function') {
    throw new Error('Unsupported transaction type for Web3Auth signing.');
  }
  (tx as { sign: (kp: Keypair) => void }).sign(keypair);
  return tx.toXDR();
}

/** @internal test helper */
export function __resetWeb3AuthForTests(): void {
  activeKeypair = null;
  web3auth = null;
}
