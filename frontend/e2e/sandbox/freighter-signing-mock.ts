import type { Page } from '@playwright/test';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

/**
 * Extends the existing Freighter postMessage mock (see
 * frontend/e2e/wallet-connect.spec.ts) with real signing against a local
 * Soroban sandbox, instead of only mocking connection/network queries.
 *
 * The existing mocks across commitment-flow.spec.ts / contract-errors.spec.ts
 * / wallet-connect.spec.ts never actually reach signTransaction() from
 * @stellar/freighter-api, because they either mock the eventual API response
 * directly or short-circuit on a simulateTransaction error first. For a real
 * sandbox test we need signing to actually happen, since the contract call
 * has to be a validly-signed transaction the sandbox will execute.
 *
 * CONFIRMED against node_modules/@stellar/freighter-api/build/index.min.js
 * (v6.0.1, traced directly): signTransaction() posts
 *   { type: 'SUBMIT_TRANSACTION', transactionXdr, networkPassphrase, accountToSign }
 * and expects a response shaped
 *   { signedTransaction, signerAddress }
 * (NOT 'SIGN_TRANSACTION' / 'signedTxXdr' -- SIGN_TRANSACTION is an internal
 * extension-UI action type, unrelated to the external postMessage protocol).
 *
 * We can't easily sign inside the browser context using an in-page Keypair
 * without either bundling stellar-sdk's signing utilities into the init
 * script (verbose, brittle to serialize) or exposing a Node-side signer.
 * We use the latter: page.exposeFunction backed by real @stellar/stellar-sdk
 * signing, since the secrets involved are local-sandbox-only test keys with
 * no real value.
 */
export async function installSigningFreighterMock(
  page: Page,
  opts: {
    address: string;
    secret: string;
    networkPassphrase: string;
  },
) {
  // Expose a Node-side signer the in-page mock can call back into.
  await page.exposeFunction('__e2eSignWithTestKeypair', (unsignedXdr: string) => {
    const keypair = Keypair.fromSecret(opts.secret);
    const tx = TransactionBuilder.fromXDR(unsignedXdr, opts.networkPassphrase);
    tx.sign(keypair);
    return tx.toXDR();
  });

  await page.addInitScript(
    ({ mockAddress, mockPassphrase }: { mockAddress: string; mockPassphrase: string }) => {
      (window as any).freighter = {};
      window.addEventListener('message', async (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== 'FREIGHTER_EXTERNAL_MSG_REQUEST') return;

        let response: Record<string, unknown> | null = null;

        switch (data.type) {
          case 'REQUEST_CONNECTION_STATUS':
            response = { isConnected: true };
            break;
          case 'REQUEST_PUBLIC_KEY':
          case 'REQUEST_ACCESS':
            response = { publicKey: mockAddress, address: mockAddress };
            break;
          case 'REQUEST_NETWORK':
            response = { network: 'STANDALONE', networkPassphrase: mockPassphrase };
            break;
          case 'REQUEST_NETWORK_DETAILS':
            response = {
              networkDetails: {
                network: 'STANDALONE',
                networkUrl: 'http://localhost:8000',
                networkPassphrase: mockPassphrase,
                sorobanRpcUrl: 'http://localhost:8000/soroban/rpc',
              },
            };
            break;
          case 'REQUEST_ALLOWED_STATUS':
            response = { isAllowed: true };
            break;
          case 'SUBMIT_TRANSACTION': {
            const signedTransaction = await (window as any).__e2eSignWithTestKeypair(
              data.transactionXdr,
            );
            response = { signedTransaction, signerAddress: mockAddress };
            break;
          }
          default:
            return;
        }

        window.postMessage(
          {
            source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE',
            messagedId: data.messageId,
            ...response,
          },
          window.location.origin,
        );
      });
    },
    { mockAddress: opts.address, mockPassphrase: opts.networkPassphrase },
  );
}
