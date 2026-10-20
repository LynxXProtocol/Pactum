import { test, expect, type Page } from '@playwright/test';

const MOCK_ADDRESS = 'GASV7ZZOPNYYFEPJ6N3GX4VINJELUQQDRX6UWWOO43F55CV6OBQUEGVK';
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const SHORT_ADDRESS = 'GASV7Z...EGVK';

/**
 * Simulates the Freighter browser extension content script.
 *
 * Freighter v6 communicates via window.postMessage:
 *   request  -> { source: 'FREIGHTER_EXTERNAL_MSG_REQUEST', messageId, type }
 *   response -> { source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE', messagedId, ... }
 *
 * Note: the script must be fully self-contained (no outer-scope references),
 * because Playwright serializes init scripts via toString().
 */
export async function installFreighterMock(
  page: Page,
  overrides: { network?: string; passphrase?: string } = {},
) {
  const network = overrides.network ?? 'TESTNET';
  const networkPassphrase = overrides.passphrase ?? TESTNET_PASSPHRASE;

  await page.addInitScript(
    ({ mockAddress, mockNetwork, mockPassphrase }: any) => {
      (window as any).freighter = {};
      window.addEventListener('message', (event: MessageEvent) => {
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
            response = { publicKey: mockAddress };
            break;
          case 'REQUEST_NETWORK':
            response = { network: mockNetwork, networkPassphrase: mockPassphrase };
            break;
          case 'REQUEST_NETWORK_DETAILS':
            response = {
              networkDetails: {
                network: mockNetwork,
                networkUrl: 'https://horizon-testnet.stellar.org',
                networkPassphrase: mockPassphrase,
                sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
              },
            };
            break;
          case 'REQUEST_ALLOWED_STATUS':
            response = { isAllowed: true };
            break;
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
    { mockAddress: MOCK_ADDRESS, mockNetwork: network, mockPassphrase: networkPassphrase },
  );
}

/** Simulates the Albedo web wallet popup used by @albedo-link/intent. */
async function installAlbedoMock(page: Page) {
  await page.addInitScript(
    ({ mockAddress }: any) => {
      (window as any).open = () => {
        const fakeWindow = {
          close: () => {},
          postMessage: (msg: any) => {
            window.postMessage(
              {
                albedoIntentResult: {
                  __reqid: msg.__reqid,
                  pubkey: mockAddress,
                  signed_message: 'mock_signed_message',
                  signature: 'mock_signature',
                },
              },
              '*',
            );
          },
        };
        setTimeout(() => {
          window.postMessage({ albedo: { protocol: 3 } }, '*');
        }, 0);
        return fakeWindow;
      };
    },
    { mockAddress: MOCK_ADDRESS },
  );
}

test.beforeEach(async ({ page }) => {
  // Mock API responses
  await page.route('**/reputation/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        address: MOCK_ADDRESS,
        fulfilled: 1,
        late: 0,
        breached: 0,
        total: 1,
      }),
    });
  });

  await page.route('**/commitments*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 1,
          issuer: MOCK_ADDRESS,
          counterparty: 'GCM5SKB5PS3ZCUXZ4GPLIBY42E63ILOT2EAIIT4UWGDFYOULCTLTRMMB',
          terms_hash: 'mock_hash',
          due_at: Date.now() / 1000 + 86400,
          status: 'Pending',
          outcome: null,
        },
      ]),
    });
  });
});

test.describe('Wallet Connection Flow (#45)', () => {
  test('connects with Freighter, shows truncated address, and disconnects', async ({ page }) => {
    await installFreighterMock(page);
    await page.goto('/');

    const connectBtn = page.getByRole('button', { name: 'Connect Wallet' });
    await expect(connectBtn).toBeVisible();
    await connectBtn.click();

    // Provider options are shown in the dropdown
    await expect(page.getByText('Freighter Wallet')).toBeVisible();
    await expect(page.getByText('Albedo Wallet')).toBeVisible();

    await page.getByRole('button', { name: /Freighter/ }).click();

    // Connected state: truncated public key visible
    await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();

    // Wallet details dropdown with Disconnect option
    await page.getByRole('button', { name: SHORT_ADDRESS }).click();
    await expect(page.getByText('Disconnect Wallet')).toBeVisible();
    await page.getByRole('button', { name: 'Disconnect Wallet' }).click();

    // Back to disconnected state
    await expect(page.getByRole('button', { name: 'Connect Wallet' })).toBeVisible();
  });

  test('connects with Albedo as an alternative provider', async ({ page }) => {
    await installAlbedoMock(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Connect Wallet' }).click();
    await expect(page.getByText('Web-based Stellar wallet (no extension)')).toBeVisible();

    await page.getByRole('button', { name: /Albedo/ }).click();

    await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();
  });

  test('connection state persists across a page reload', async ({ page }) => {
    await installFreighterMock(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Connect Wallet' }).click();
    await page.getByRole('button', { name: /Freighter/ }).click();
    await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();

    // Reload: the session should be restored from localStorage
    await page.reload();
    await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();
  });

  test('prompts to install Freighter when the extension is missing', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Connect Wallet' }).click();
    await page.getByRole('button', { name: /Freighter/ }).click();

    // Install modal with a link to freighter.app
    await expect(page.getByText('Freighter Extension Needed')).toBeVisible();
    const installLink = page.getByRole('link', { name: 'Install Freighter Wallet' }).first();
    await expect(installLink).toBeVisible();
    await expect(installLink).toHaveAttribute('href', 'https://www.freighter.app/');
  });

  test('warns when the wallet is connected to the wrong network', async ({ page }) => {
    await installFreighterMock(page, {
      network: 'PUBLIC',
      passphrase: 'Public Global Stellar Network ; September 2015',
    });
    await page.goto('/');

    await page.getByRole('button', { name: 'Connect Wallet' }).click();
    await page.getByRole('button', { name: /Freighter/ }).click();

    // Network mismatch banner with instructions to switch to Testnet
    await expect(page.getByText('Wrong network detected')).toBeVisible();
    await expect(page.getByText(/Pactum requires Stellar Testnet/i)).toBeVisible();

    // No connection should be established
    await expect(page.getByRole('button', { name: 'Connect Wallet' })).toBeVisible();
  });
});
