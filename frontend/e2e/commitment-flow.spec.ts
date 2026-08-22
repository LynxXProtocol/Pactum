import { test, expect, type Page } from '@playwright/test';
import { installSuccessfulSorobanRpc } from './mock-soroban-success';

const MOCK_ADDRESS = 'GASV7ZZOPNYYFEPJ6N3GX4VINJELUQQDRX6UWWOO43F55CV6OBQUEGVK';
const COUNTERPARTY = 'GCM5SKB5PS3ZCUXZ4GPLIBY42E63ILOT2EAIIT4UWGDFYOULCTLTRMMB';
const SHORT_ADDRESS = 'GASV7Z...EGVK';

/**
 * Simulates the Freighter browser extension content script (postMessage protocol).
 * Must be self-contained: Playwright serializes init scripts via toString().
 */
async function installFreighterMock(page: Page) {
  await page.addInitScript(
    ({ mockAddress }: any) => {
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
            response = {
              network: 'TESTNET',
              networkPassphrase: 'Test SDF Network ; September 2015',
            };
            break;
          case 'REQUEST_NETWORK_DETAILS':
            response = {
              networkDetails: {
                network: 'TESTNET',
                networkUrl: 'https://horizon-testnet.stellar.org',
                networkPassphrase: 'Test SDF Network ; September 2015',
                sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
              },
            };
            break;
          case 'REQUEST_ALLOWED_STATUS':
            response = { isAllowed: true };
            break;
          // Sign by echoing the unsigned envelope back: sendTransaction /
          // getTransaction are fully mocked (mock-soroban-success.ts), so the
          // signature is never verified -- only its presence matters.
          // Legacy 'REQUEST_SIGN_*' type names kept as fallbacks.
          case 'SUBMIT_TRANSACTION':
          case 'REQUEST_SIGN_TRANSACTION': {
            const txXdr = data.transactionXdr ?? data.transaction ?? '';
            response = {
              signedTransaction: txXdr,
              signedTxXdr: txXdr,
              signerAddress: mockAddress,
            };
            break;
          }
          // Simulate signMessage: returns a deterministic 64-byte base64 signature.
          // CONFIRMED against @stellar/freighter-api v6 (index.min.js):
          // signMessage() posts type=SUBMIT_BLOB carrying {blob} and expects
          // {signedBlob, signerAddress} back.
          case 'SUBMIT_BLOB':
          case 'REQUEST_SIGN_MESSAGE': {
            const mockSig = btoa(String.fromCharCode(...new Array(64).fill(42)));
            response = {
              signedBlob: mockSig,
              signedMessage: mockSig,
              signerAddress: mockAddress,
            };
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
    { mockAddress: MOCK_ADDRESS },
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

async function mockSorobanRpc(page: Page) {
  let lastEnvelopeXdr = '';

  await page.route('**/soroban-testnet.stellar.org/**', async (route) => {
    const postData = route.request().postData() ?? '';
    let parsed: { id?: number | string; method?: string; params?: any } = {};
    try {
      parsed = JSON.parse(postData);
    } catch {}
    const id = parsed.id ?? 1;

    if (parsed.method === 'getAccount') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            id: MOCK_ADDRESS,
            sequence: '123456789',
          },
        }),
      });
      return;
    }

    if (parsed.method === 'getLatestLedger') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            id: '00'.repeat(32),
            protocolVersion: 20,
            sequence: LEDGER_ENTRIES_RESULT.latestLedger,
          },
        }),
      });
      return;
    }

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
            minResourceFee: '100',
            transactionData: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            latestLedger: LEDGER_ENTRIES_RESULT.latestLedger,
            events: [],
            results: [
              {
                auth: [],
                xdr: 'AAAAAQ==',
              },
            ],
          },
        }),
      });
      return;
    }

    if (parsed.method === 'sendTransaction') {
      if (parsed.params?.transaction) {
        lastEnvelopeXdr = parsed.params.transaction;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            status: 'PENDING',
            hash: 'mock_tx_hash_123',
            latestLedger: LEDGER_ENTRIES_RESULT.latestLedger,
          },
        }),
      });
      return;
    }

    if (parsed.method === 'getTransaction') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            status: 'SUCCESS',
            latestLedger: LEDGER_ENTRIES_RESULT.latestLedger,
            ledger: LEDGER_ENTRIES_RESULT.latestLedger,
            createdAt: Math.floor(Date.now() / 1000),
            applicationOrder: 1,
            feeBump: false,
            envelopeXdr: lastEnvelopeXdr,
            resultXdr: 'AAAAAAAAAGQAAAAAAAAAAAAAAAA=',
            resultMetaXdr: 'AAAAAAAAAAA=',
            events: { contractEventsXdr: [], transactionEventsXdr: [] },
          },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          status: 'SUCCESS',
          latestLedger: LEDGER_ENTRIES_RESULT.latestLedger,
        },
      }),
    });
  });
}

async function mockFriendbot(page: Page) {
  await page.route('**/friendbot.stellar.org/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test.beforeEach(async ({ page }) => {
  await installFreighterMock(page);
  await mockHorizonAccount(page);
  await mockSorobanRpc(page);
  await mockFriendbot(page);

  // Offline Soroban RPC mock: account lookup, simulation, submission and
  // confirmation all succeed; create_commitment returns commitment id 42.
  await installSuccessfulSorobanRpc(page, { commitmentId: 42 });

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

  // Merkle proof endpoint consumed by the reputation page's on-chain
  // verification panel (kept from upstream).
  await page.route('**/api/v1/proofs/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        proof: {
          version: '1.0.0',
          networkPassphrase: 'Test SDF Network ; September 2015',
          ledgerSeq: LEDGER_ENTRIES_RESULT.latestLedger,
          ledgerHeaderHash: '00'.repeat(32),
          stateRootHash: '00'.repeat(32),
          contractId: 'CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E',
          stellarAddress: MOCK_ADDRESS,
          scoreData: {
            score: 100,
            fulfilledCount: 1,
            lateCount: 0,
            breachedCount: 0,
            epoch: 1,
            sourceLedgerSeq: LEDGER_ENTRIES_RESULT.latestLedger,
          },
          leafHash: '00'.repeat(32),
          merkleProof: [],
          headerProof: {
            previousLedgerHash: '00'.repeat(32),
            txSetResultHash: '00'.repeat(32),
            bucketListHash: '00'.repeat(32),
            ledgerVersion: 20,
          },
        },
      }),
    });
  });

  // Consolidated commitments API mock. NOTE: a '**/commitments*' glob would
  // NOT match subpaths -- Playwright's '*' never crosses '/', so
  // /commitments/2/encrypted would silently fall through to the network.
  // A regex avoids that trap entirely.
  await page.route(/\/commitments/, async (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;

    if (method === 'POST' && path.endsWith('/commitments')) {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 2, status: 'Created' }),
      });
      return;
    }

    if (method === 'POST' && path.endsWith('/commitments/encrypted')) {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Encrypted terms stored successfully.' }),
      });
      return;
    }

    if (method === 'GET' && /\/commitments\/\d+\/encrypted$/.test(path)) {
      // Return a mock ciphertext blob (valid base64url-encoded bytes)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ciphertext: 'AAAAAAAAAAAAAAAA_mock_ciphertext_blob',
          issuer: MOCK_ADDRESS,
          counterparty: COUNTERPARTY,
          createdAt: new Date().toISOString(),
        }),
      });
      return;
    }

    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 1,
            issuer: MOCK_ADDRESS,
            counterparty: COUNTERPARTY,
            terms_hash: 'mock_hash',
            due_at: Date.now() / 1000 + 86400,
            status: 'Pending',
            outcome: null,
            encrypted: false,
          },
          {
            id: 2,
            issuer: MOCK_ADDRESS,
            counterparty: COUNTERPARTY,
            terms_hash: 'encrypted_mock_hash',
            due_at: Date.now() / 1000 + 86400,
            status: 'Pending',
            outcome: null,
            encrypted: true,
          },
        ]),
      });
      return;
    }

    await route.continue();
  });

  await page.goto('/');
  // If landing page is shown, launch the app first
  const launchBtn = page.getByRole('button', { name: /launch app/i }).first();
  if (await launchBtn.isVisible()) {
    await launchBtn.click();
  }
});

test('critical user journey: connect wallet -> create commitment -> view dashboard', async ({
  page,
}) => {
  // 1. Connect the wallet from the landing page
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
  await page.getByRole('button', { name: /Freighter/ }).click();
  await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();

  // The sr-only "Connected" span in WalletConnectButton confirms wallet connection
  await expect(page.getByText('Connected').first()).toBeVisible();

  // 2. Create Commitment — use the nav button by its id to avoid strict mode violation
  await page.locator('#nav-create').click();

  // Step 1: Counterparty
  await expect(page.locator('#wizard-counterparty')).toBeVisible();
  await page
    .locator('#wizard-counterparty')
    .fill('GCM5SKB5PS3ZCUXZ4GPLIBY42E63ILOT2EAIIT4UWGDFYOULCTLTRMMB');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 2: Terms
  await expect(page.locator('#wizard-terms')).toBeVisible();
  await page.locator('#wizard-terms').fill('Test commitment terms');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3: Due Date
  await expect(page.locator('#wizard-dueat')).toBeVisible();
  await page.locator('#wizard-dueat').fill('2026-12-31T12:00');
  await page.locator('#wizard-submit-btn').click();

  // Submitting runs the full mocked chain round-trip (simulate -> sign ->
  // send -> confirm); on confirmation App.onSuccess auto-navigates to
  // Reputation (/reputation/<address>).
  await page.waitForURL(/\/reputation\//, { timeout: 30_000 });

  // Re-open Create -- the wizard retains the confirmed result view.
  await page.locator('#nav-create').click();
  await expect(page.getByText('Commitment created successfully')).toBeVisible();
  await expect(page.getByText('confirmed on Stellar Testnet')).toBeVisible();
  // Commitment ID comes from the mocked create_commitment return value
  // (mock-soroban-success.ts), proving the RPC round-trip happened.
  await expect(page.getByText('#42', { exact: true })).toBeVisible();

  // 3. View Dashboard -- lists commitments from the (mocked) backend API.
  // Scope to #commitments-list-page: '.commitment-list' alone is ambiguous
  // (the overview sidebar uses it too).
  await page.locator('#nav-dashboard').click();

  const pageList = page.locator('#commitments-list-page');
  await expect(pageList).toBeVisible({ timeout: 10_000 });
  await expect(pageList.getByText('Commitment #1')).toBeVisible();
  await expect(pageList.getByText('Commitment #2')).toBeVisible();
});

test('form validation errors appear on bad input', async ({ page }) => {
  // Landing page is already dismissed in beforeEach; navigate directly to create
  await page.locator('#nav-create').click();

  // Try to continue without filling counterparty
  await page.getByRole('button', { name: 'Continue' }).click();

  // Verify validation error
  await expect(page.getByText(/required/i)).toBeVisible();
});

test('loading spinners display during network requests', async ({ page }) => {
  // useCommitments seeds queries with CRDT-cached records via placeholderData,
  // which masks isLoading for any query backed by an existing cache. To see
  // the real loading state we need a genuinely cold load: gate every
  // commitments GET before remounting, and wipe the persisted cache.
  let releaseCommitments!: () => void;
  const commitmentsGate = new Promise<void>((resolve) => {
    releaseCommitments = resolve;
  });

  await page.route('**/commitments*', async (route) => {
    if (route.request().method() === 'GET') {
      await commitmentsGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
      return;
    }
    await route.continue();
  });

  // Drop the CRDT cache seeded by the initial mount, then remount with the
  // gate up. Issued as an init script so the delete lands BEFORE the app
  // opens its own connection (a live connection would block deletion).
  await page.addInitScript(() => {
    indexedDB.deleteDatabase('pactum-cache-v1');
  });
  await page.reload();
  const launchBtn = page.locator('#hero-launch-btn');
  if (await launchBtn.isVisible()) {
    await launchBtn.click();
  }

  // Navigate to Dashboard using nav button id (not role=link)
  await page.locator('#nav-dashboard').click();

  await expect(page.getByText('Loading commitments...')).toBeVisible({ timeout: 10_000 });
  releaseCommitments();
  await expect(page.getByText('Loading commitments...')).not.toBeVisible({ timeout: 10_000 });
});

test('WASM validation failure blocks transaction simulation and wallet submission', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__signCalled = false;
    const originalSign = (window as any).freighter?.signTransaction;
    if ((window as any).freighter) {
      (window as any).freighter.signTransaction = (...args: any[]) => {
        (window as any).__signCalled = true;
        return originalSign ? originalSign(...args) : Promise.resolve({ status: 'SUCCESS' });
      };
    }
  });

  // Connect Freighter wallet first so submit button is enabled
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
  await page.getByRole('button', { name: /Freighter/ }).click();
  await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();

  // Navigate to Create Commitment wizard page
  await page.locator('#nav-create').click();

  // Step 0: Counterparty
  await page
    .locator('#wizard-counterparty')
    .fill('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7');
  await page.getByRole('button', { name: /continue/i }).click();

  // Step 1: Terms
  await page.locator('#wizard-terms').fill('Test commitment terms');
  await page.getByRole('button', { name: /continue/i }).click();

  // Step 2: Deadline - Fill past date to trigger WASM contract validation error
  await page.locator('#wizard-dueat').fill('2020-01-01T00:00');
  // Wait for the submit button to be visible and enabled before clicking
  await expect(page.locator('#wizard-submit-btn')).toBeVisible();
  await page.locator('#wizard-submit-btn').waitFor({ state: 'attached' });
  await page.locator('#wizard-submit-btn').click({ timeout: 5000 });

  // WASM validation error should appear and stop submit flow
  await expect(
    page.getByText(/Due date must be set in the future|Contract validation failed/i),
  ).toBeVisible();

  // Verify wallet signTransaction was NEVER called
  const signCalled = await page.evaluate(() => (window as any).__signCalled);
  expect(signCalled).toBeFalsy();
});

test('encrypted commitment: toggle encrypts terms — ciphertext sent to backend, not plaintext', async ({
  page,
}) => {
  // Track the body of the POST /commitments/encrypted request
  const encryptedRequests: { body: Record<string, unknown> }[] = [];
  await page.route('**/commitments/encrypted', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      encryptedRequests.push({ body });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Encrypted terms stored successfully.' }),
      });
    } else {
      await route.continue();
    }
  });

  // Connect Freighter wallet
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
  await page.getByRole('button', { name: /Freighter/ }).click();
  await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();

  // Navigate to Create Commitment — use nav id to avoid strict mode violation
  await page.locator('#nav-create').click();

  // Step 1: Counterparty
  await page.locator('#wizard-counterparty').fill(COUNTERPARTY);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 2: Terms + enable encryption toggle
  await expect(page.locator('#wizard-terms')).toBeVisible();
  await page.locator('#wizard-terms').fill('Secret commitment terms');

  // Enable the encryption toggle via the hidden checkbox
  await expect(page.locator('#encrypt-toggle-container')).toBeVisible();
  await page.locator('#encrypt-toggle').dispatchEvent('click');
  await expect(page.locator('#encrypt-toggle-container')).toContainText('E2E Encrypted');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3: Due date
  await page.locator('#wizard-dueat').fill('2026-12-31T12:00');
  // Wait for the submit button to be visible before clicking
  await expect(page.locator('#wizard-submit-btn')).toBeVisible();
  await page.locator('#wizard-submit-btn').click({ timeout: 5000 });

  // Encryption consent modal should appear
  await expect(page.locator('#encrypt-modal-confirm')).toBeVisible({ timeout: 5000 });
  await page.locator('#encrypt-modal-confirm').click();

  // Wait until the upload actually happened (sign -> submit -> confirm ->
  // store-encrypted), then assert on its body.
  await expect
    .poll(() => encryptedRequests.length, { timeout: 30_000 })
    .toBeGreaterThan(0);

  // Assert: the encrypted request has ciphertext not plaintext
  for (const req of encryptedRequests) {
    expect(req.body).toHaveProperty('ciphertext');
    expect(req.body).not.toHaveProperty('terms');
    expect(typeof req.body.ciphertext).toBe('string');
    expect((req.body.ciphertext as string).length).toBeGreaterThan(10);
  }
});

test('dashboard: encrypted commitment shows lock badge and decrypt button', async ({ page }) => {
  // Connect wallet
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
  await page.getByRole('button', { name: /Freighter/ }).click();
  await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();

  // Navigate to dashboard using nav button id
  await page.locator('#nav-dashboard').click();

  // The second commitment (id=2) is encrypted — its lock badge should be
  // visible. Assert on elements directly instead of waitForLoadState:
  // background polling keeps the network from ever going idle.
  await expect(page.getByText('E2E Encrypted').first()).toBeVisible({ timeout: 15000 });

  // The "Decrypt Terms" button should be present for the encrypted commitment (id=2)
  const decryptBtn = page.locator('[id^="decrypt-btn-"]').first();
  await expect(decryptBtn).toBeVisible({ timeout: 5000 });
  await expect(decryptBtn).toContainText('Decrypt Terms');

  // Clicking it should open the DecryptTermsModal
  await decryptBtn.click();
  await expect(page.locator('#decrypt-modal-confirm')).toBeVisible({ timeout: 5000 });

  // The modal should identify this wallet as a party (issuer)
  await expect(page.getByText('authorized')).toBeVisible();

  // Close the modal
  await page.locator('#decrypt-modal-cancel').click();
  await expect(page.locator('#decrypt-modal-confirm')).not.toBeVisible();
});
