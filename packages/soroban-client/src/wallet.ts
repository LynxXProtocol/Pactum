import { Networks } from '@stellar/stellar-sdk';
import {
  isConnected as freighterIsConnected,
  requestAccess as freighterRequestAccess,
  getAddress as freighterGetAddress,
  getNetwork as freighterGetNetwork,
} from '@stellar/freighter-api';
import albedo from '@albedo-link/intent';
import { isStellarAddress } from './stellar';
import { LedgerAdapter } from './wallet-adapters/ledger-adapter';

export type WalletProvider = 'freighter' | 'albedo' | 'ledger' | 'web3auth';

export const PACTUM_NETWORK_PASSPHRASE =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_STELLAR_NETWORK_PASSPHRASE) ||
  Networks.TESTNET;
export const PACTUM_NETWORK_NAME = 'TESTNET';
export const FREIGHTER_HOMEPAGE = 'https://www.freighter.app/';

export type WalletErrorCode =
  'NOT_INSTALLED' | 'CONNECTION_REJECTED' | 'NETWORK_MISMATCH' | 'INVALID_ADDRESS' | 'UNKNOWN';

export class WalletConnectionError extends Error {
  readonly code: WalletErrorCode;

  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.name = 'WalletConnectionError';
    this.code = code;
  }
}

export interface WalletConnectionResult {
  address: string;
  provider: WalletProvider;
}

export { freighterGetAddress as getFreighterAddress, freighterGetNetwork as getFreighterNetwork };

export async function isFreighterInstalled(): Promise<boolean> {
  try {
    const res = await freighterIsConnected();
    return Boolean(res && res.isConnected);
  } catch (err) {
    console.warn('[wallet] freighter isInstalled check failed:', err);
    return false;
  }
}

export async function isFreighterConnected(): Promise<boolean> {
  try {
    const res = await freighterIsConnected();
    return Boolean(res && res.isConnected);
  } catch (err) {
    console.warn('[wallet] freighter isConnected check failed:', err);
    return await isFreighterInstalled();
  }
}

function assertTestnetNetwork(network: string | undefined, passphrase: string | undefined): void {
  if (!network) return;
  const normalized = network.toUpperCase();
  const allowedPassphrase = PACTUM_NETWORK_PASSPHRASE;
  const onAllowedNetwork =
    normalized === 'TESTNET' ||
    normalized === 'TEST' ||
    normalized === 'STANDALONE' ||
    normalized === 'LOCAL' ||
    (passphrase != null &&
      (passphrase === allowedPassphrase ||
        passphrase === Networks.TESTNET ||
        passphrase === Networks.STANDALONE ||
        passphrase === 'Standalone Network ; February 2017'));

  if (!onAllowedNetwork) {
    throw new WalletConnectionError(
      'NETWORK_MISMATCH',
      `Freighter is connected to ${network}. Pactum requires Stellar Testnet or Standalone sandbox. ` +
        'Please switch your wallet network to Testnet (Settings → Network) and try again.',
    );
  }
}

/**
 * Connects via the Freighter browser extension:
 * 1. Verifies the extension is installed & unlocked
 * 2. Requests access (prompts the extension pop-up)
 * 3. Retrieves the public key
 * 4. Verifies the wallet is on Stellar Testnet
 */
export async function connectWithFreighter(): Promise<WalletConnectionResult> {
  const installed = await isFreighterInstalled();
  if (!installed) {
    throw new WalletConnectionError(
      'NOT_INSTALLED',
      'Freighter browser extension was not detected. Please install Freighter from freighter.app.',
    );
  }

  let address = '';

  try {
    const accessRes = await freighterRequestAccess();
    if (accessRes && accessRes.address) {
      address = accessRes.address;
    } else if (accessRes && accessRes.error) {
      throw new WalletConnectionError(
        'CONNECTION_REJECTED',
        String(accessRes.error) || 'Connection request denied in Freighter.',
      );
    }
  } catch (err) {
    if (err instanceof WalletConnectionError) throw err;
    // Fallback: connection may already be allowed
    try {
      const addrRes = await freighterGetAddress();
      if (addrRes && addrRes.address && !addrRes.error) {
        address = addrRes.address;
      }
    } catch (e) {
      console.warn('[wallet] freighter getAddress fallback failed:', e);
    }
    if (!address) {
      throw new WalletConnectionError(
        'CONNECTION_REJECTED',
        'Connection request was rejected or cancelled in Freighter.',
      );
    }
  }

  if (!address) {
    throw new WalletConnectionError(
      'CONNECTION_REJECTED',
      'Unable to retrieve account address from Freighter.',
    );
  }

  if (!isStellarAddress(address)) {
    throw new WalletConnectionError(
      'INVALID_ADDRESS',
      `Freighter returned an invalid Stellar address: ${address}`,
    );
  }

  // Enforce Testnet (best-effort: if the API is unavailable, log and continue)
  try {
    const netRes = await freighterGetNetwork();
    if (netRes && !netRes.error) {
      assertTestnetNetwork(netRes.network, netRes.networkPassphrase);
    }
  } catch (err) {
    if (err instanceof WalletConnectionError) throw err;
    console.warn('[wallet] Unable to verify Freighter network; continuing:', err);
  }

  return { address, provider: 'freighter' };
}

/**
 * Connects via Albedo (web wallet) using the official intent SDK.
 * Opens an Albedo pop-up where the user selects an account.
 * Signing intents later enforce `network: 'testnet'`.
 */
export async function connectWithAlbedo(): Promise<WalletConnectionResult> {
  try {
    const res = await albedo.publicKey({});
    if (!res || !res.pubkey) {
      throw new WalletConnectionError(
        'CONNECTION_REJECTED',
        'Albedo connection was rejected or cancelled.',
      );
    }
    if (!isStellarAddress(res.pubkey)) {
      throw new WalletConnectionError(
        'INVALID_ADDRESS',
        `Albedo returned an invalid Stellar address: ${res.pubkey}`,
      );
    }
    return { address: res.pubkey, provider: 'albedo' };
  } catch (err) {
    if (err instanceof WalletConnectionError) throw err;
    throw new WalletConnectionError(
      'CONNECTION_REJECTED',
      err instanceof Error ? err.message : 'Failed to connect with Albedo wallet.',
    );
  }
}

/**
 * Connects directly to a Ledger Nano hardware wallet over WebUSB/WebBluetooth
 * (no browser extension involved). Prompts the browser's native device picker,
 * then reads the Stellar public key from the Ledger Stellar app.
 */
export async function connectWithLedger(): Promise<WalletConnectionResult> {
  try {
    const address = await LedgerAdapter.connect();
    if (!address || !isStellarAddress(address)) {
      throw new WalletConnectionError(
        'INVALID_ADDRESS',
        'Ledger returned an invalid Stellar address. Ensure the Stellar app is open on the device.',
      );
    }
    return { address, provider: 'ledger' };
  } catch (err) {
    if (err instanceof WalletConnectionError) throw err;
    throw new WalletConnectionError(
      'CONNECTION_REJECTED',
      err instanceof Error ? err.message : 'Failed to connect to Ledger device.',
    );
  }
}

export async function connectWallet(provider: WalletProvider): Promise<WalletConnectionResult> {
  if (provider === 'albedo') return connectWithAlbedo();
  if (provider === 'ledger') return connectWithLedger();
  if (provider === 'web3auth') {
    const { connectWithWeb3Auth } = await import('./web3auth');
    return connectWithWeb3Auth();
  }
  return connectWithFreighter();
}

export function truncateAddress(address: string, start = 6, end = 4): string {
  if (!address || address.length <= start + end) return address;
  return `${address.substring(0, start)}...${address.substring(address.length - end)}`;
}
