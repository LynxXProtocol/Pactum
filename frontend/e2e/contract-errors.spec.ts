import { test, expect, type Page } from '@playwright/test';

const MOCK_ADDRESS = 'GASV7ZZOPNYYFEPJ6N3GX4VINJELUQQDRX6UWWOO43F55CV6OBQUEGVK';
const COUNTERPARTY = 'GCM5SKB5PS3ZCUXZ4GPLIBY42E63ILOT2EAIIT4UWGDFYOULCTLTRMMB';
const SENSITIVE_MARKER = 'SENSITIVE_FIXTURE_TOKEN_abc123';
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

async function installFreighterMock(page: Page) {
  await page.addInitScript(
    ({ mockAddress, mockPassphrase }: { mockAddress: string; mockPassphrase: string }) => {
      (window as { freighter?: Record<string, never> }).freighter = {};
      window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data as { source?: string; type?: string; messageId?: string } | null;
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
            response = { network: 'TESTNET', networkPassphrase: mockPassphrase };
            break;
          case 'REQUEST_NETWORK_DETAILS':
            response = {
              networkDetails: {
                network: 'TESTNET',
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
    { mockAddress: MOCK_ADDRESS, mockPassphrase: TESTNET_PASSPHRASE },
  );
}

const HORIZON_ACCOUNT = {
  id: MOCK_ADDRESS,
  account_id: MOCK_ADDRESS,
  sequence: '123456789',
  subentry_count: 0,
  balances: [{ balance: '10000000000', asset_type: 'native' }],
  flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
  thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
  signers: [{ weight: 1, key: MOCK_ADDRESS, type: 'ed25519_public_key' }],
  data: {},
  _links: {},
};

const LEDGER_ENTRIES_RESULT = {
  entries: [
    {
      key: 'AAAAAAAAAAAlX+cue3GCkenzdmvyqGpIukIDjf1LWc7my96KvnBhQg==',
      xdr: 'AAAAAAAAAAAlX+cue3GCkenzdmvyqGpIukIDjf1LWc7my96KvnBhQgAAABdIdugAAEASMgAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAA',
      lastModifiedLedgerSeq: 4198962,
      extXdr: 'AAAAAA==',
    },
  ],
  latestLedger: 4198984,
};

async function mockHorizonAccount(page: Page) {
  await page.route('**/horizon-testnet.stellar.org/accounts/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(HORIZON_ACCOUNT),
    });
  });
}

async function mockSorobanRpc(page: Page, simulationError: string) {
  await page.route('**/soroban-testnet.stellar.org/**', async (route) => {
    const postData = route.request().postData() ?? '';
    const parsed = JSON.parse(postData) as { id?: number | string; method?: string };
    const id = parsed.id ?? 1;

    if (parsed.method === 'getLedgerEntries') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id, result: LEDGER_ENTRIES_RESULT }),
      });
      return;
    }

    if (parsed.method === 'simulateTransaction') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            error: simulationError,
            latestLedger: LEDGER_ENTRIES_RESULT.latestLedger,
            events: [],
          },
        }),
      });
      return;
    }

    await route.continue();
  });
}

async function mockFriendbot(page: Page) {
  await page.route('**/friendbot.stellar.org/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function mockApiRoutes(page: Page) {
  await page.route('**/reputation/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        address: MOCK_ADDRESS,
        fulfilled: 0,
        late: 0,
        breached: 0,
        total: 0,
      }),
    });
  });

  await page.route('**/commitments*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
}

async function openCreateWizard(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
  await page.getByRole('button', { name: /Freighter/ }).click();
  await expect(page.getByRole('button', { name: /GASV7Z\.\.\./ })).toBeVisible();
  await page.getByRole('button', { name: 'Launch App' }).first().click();
  await page.locator('#nav-create').click();
  await expect(page.locator('.section-title').filter({ hasText: 'Create Commitment' })).toBeVisible();
}

async function fillWizardAndSubmit(page: Page) {
  await page.locator('#wizard-counterparty').fill(COUNTERPARTY);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#wizard-terms').fill('Deliver widgets by end of Q3');
  await page.getByRole('button', { name: 'Continue' }).click();

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);
  await page.locator('#wizard-dueat').fill(futureDate.toISOString().slice(0, 16));

  await page.locator('#page-create').getByRole('button', { name: 'Create Commitment' }).click();
}

function errorToast(page: Page) {
  return page.locator('#toast-container .toast.error[role="alert"]');
}

test.describe('Registry contract errors in Create Commitment wizard (#35)', () => {
  test.beforeEach(async ({ page }) => {
    await installFreighterMock(page);
    await mockApiRoutes(page);
    await mockHorizonAccount(page);
    await mockFriendbot(page);
  });

  test('shows decoded toast for Error(Contract, #1)', async ({ page }) => {
    await mockSorobanRpc(page, 'Error(Contract, #1)');
    await openCreateWizard(page);
    await fillWizardAndSubmit(page);

    const toast = errorToast(page);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText('Due date must be in the future');
    await expect(page.locator('.wizard .form-error')).toHaveCount(0);
  });

  test('shows generic fallback for unknown contract code', async ({ page }) => {
    await mockSorobanRpc(page, 'Error(Contract, #999)');
    await openCreateWizard(page);
    await fillWizardAndSubmit(page);

    const toast = errorToast(page);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText('Transaction Failed');
  });

  test('does not expose sensitive markers from RPC errors', async ({ page }) => {
    await mockSorobanRpc(page, `Error(Contract, #999) ${SENSITIVE_MARKER}`);
    await openCreateWizard(page);
    await fillWizardAndSubmit(page);

    const toast = errorToast(page);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText('Transaction Failed');
    await expect(page.locator('body')).not.toContainText(SENSITIVE_MARKER);
  });

  test('toast does not persist after page refresh', async ({ page }) => {
    await mockSorobanRpc(page, 'Error(Contract, #1)');
    await openCreateWizard(page);
    await fillWizardAndSubmit(page);

    await expect(errorToast(page)).toBeVisible();
    await page.reload();
    await expect(errorToast(page)).toHaveCount(0);
  });
});
