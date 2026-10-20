import {
  StrKey,
  TransactionBuilder,
  type Transaction,
  type FeeBumpTransaction,
} from '@stellar/stellar-sdk';

interface WalletAdapter {
  name: string;
  id: string;
  icon: unknown;
  description: string;
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  isAvailable: () => Promise<boolean>;
}

// Standard Stellar BIP-32 derivation path (SEP-0005, account 0).
const LEDGER_STELLAR_PATH = "44'/148'/0'";

type LedgerTransport = import('@ledgerhq/hw-transport').default;
type StellarApp = import('@ledgerhq/hw-app-str').default;

let transport: LedgerTransport | null = null;
let stellarApp: StellarApp | null = null;

function hasWebUSB(): boolean {
  return typeof navigator !== 'undefined' && Boolean((navigator as any).usb);
}

function hasWebBluetooth(): boolean {
  return typeof navigator !== 'undefined' && Boolean((navigator as any).bluetooth);
}

/**
 * Opens a transport to the Ledger device, preferring WebUSB (matches the
 * acceptance criteria's "request the USB interface via browser prompts")
 * and falling back to WebBluetooth for devices/browsers without USB access.
 */
async function openTransport(): Promise<LedgerTransport> {
  if (transport) return transport;

  if (hasWebUSB()) {
    const TransportWebUSB = (await import('@ledgerhq/hw-transport-webusb')).default;
    // request() always triggers the browser's native device-picker prompt.
    transport = await TransportWebUSB.request();
  } else if (hasWebBluetooth()) {
    const BluetoothTransport = (await import('@ledgerhq/hw-transport-web-ble')).default;
    const descriptor = await new Promise<any>((resolve, reject) => {
      const sub = BluetoothTransport.listen({
        next: (e: any) => {
          sub.unsubscribe();
          resolve(e.descriptor);
        },
        error: (err: unknown) => reject(err),
        complete: () => {},
      });
    });
    transport = await BluetoothTransport.open(descriptor);
  } else {
    throw new Error(
      'This browser supports neither WebUSB nor WebBluetooth. Use a Chromium-based browser to connect a Ledger device.',
    );
  }

  transport!.on('disconnect', () => {
    transport = null;
    stellarApp = null;
  });

  return transport!;
}

async function getStellarApp(): Promise<StellarApp> {
  if (stellarApp) return stellarApp;
  const t = await openTransport();
  const Str = (await import('@ledgerhq/hw-app-str')).default;
  stellarApp = new Str(t);
  return stellarApp;
}

export const LedgerAdapter: WalletAdapter = {
  name: 'Ledger',
  id: 'ledger',
  icon: {},
  description: 'Ledger Nano hardware wallet (WebUSB/WebBluetooth, direct — no browser extension)',
  connect: async () => {
    const app = await getStellarApp();
    const { rawPublicKey } = await app.getPublicKey(LEDGER_STELLAR_PATH);
    return StrKey.encodeEd25519PublicKey(rawPublicKey);
  },
  disconnect: async () => {
    if (transport) {
      await transport.close();
    }
    transport = null;
    stellarApp = null;
  },
  isAvailable: async () => hasWebUSB() || hasWebBluetooth(),
};

/**
 * Signs a Stellar/Soroban transaction envelope on a connected Ledger device
 * and returns the signed XDR, mirroring the shape of `@stellar/freighter-api`'s
 * `signTransaction` so it can be dropped into the same call sites (see soroban.ts).
 *
 * The Ledger Stellar app signs the transaction's signature base (the exact
 * hashed-payload format it expects, per its APDU protocol) — the raw XDR bytes
 * are never sent as-is, so the low-level framing is handled by @ledgerhq/hw-app-str.
 */
export async function signTransactionWithLedger(
  unsignedXdr: string,
  networkPassphrase: string,
): Promise<string> {
  const app = await getStellarApp();
  const { rawPublicKey } = await app.getPublicKey(LEDGER_STELLAR_PATH);
  const publicKey = StrKey.encodeEd25519PublicKey(rawPublicKey);

  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase) as
    Transaction | FeeBumpTransaction;

  const { signature } = await app.signTransaction(LEDGER_STELLAR_PATH, tx.signatureBase());
  tx.addSignature(publicKey, signature.toString('base64'));

  return tx.toXDR();
}
