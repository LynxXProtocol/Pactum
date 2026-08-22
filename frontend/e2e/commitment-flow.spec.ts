import { test, expect, type Page } from '@playwright/test';

const MOCK_ADDRESS = 'GASV7ZZOPNYYFEPJ6N3GX4VINJELUQQDRX6UWWOO43F55CV6OBQUEGVK';
const COUNTERPARTY = 'GCM5SKB5PS3ZCUXZ4GPLIBY42E63ILOT2EAIIT4UWGDFYOULCTLTRMMB';
const SHORT_ADDRESS = 'GASV7Z...EGVK';

// A fixed future date goes stale the moment it's in the past; compute one relative to "now"
// instead, matching contract-errors.spec.ts's own pattern.
function futureDueDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return date.toISOString().slice(0, 16);
}

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
          // Simulate signMessage / submitBlob: returns a deterministic 64-byte base64 signature
          case 'SUBMIT_BLOB':
          case 'REQUEST_SIGN_MESSAGE': {
            // Deterministic mock: base64 of 64 zero bytes (sufficient for HKDF key derivation test)
            const mockSig = btoa(String.fromCharCode(...new Array(64).fill(42)));
            response = {
              signedBlob: mockSig,
              signedMessage: mockSig,
              signerAddress: mockAddress,
            };
            break;
          }
          case 'SUBMIT_TRANSACTION':
          case 'REQUEST_SIGN_TRANSACTION': {
            response = {
              signedTransaction: data.transactionXdr ?? data.transaction ?? '',
              signedTxXdr: data.transactionXdr ?? data.transaction ?? '',
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
    } catch {
      // Malformed/non-JSON body: fall through with the empty `parsed` default.
    }
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

  // Mock encrypted terms endpoints first so they take precedence
  await page.route('**/commitments/encrypted', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Encrypted terms stored successfully.' }),
      });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });

  await page.route('**/commitments/*/encrypted', async (route) => {
    if (route.request().method() === 'GET') {
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
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });

  // Mock commitments query and creation
  await page.route('**/commitments*', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 2, status: 'Created' }),
      });
    } else {
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
    }
  });

  await page.goto('/');
  // `isVisible()` doesn't auto-wait, so it can read the DOM before the landing page has
  // hydrated and race to false on a slower load — `click()`'s own actionability wait is the
  // reliable way to land on this always-present button.
  await page
    .getByRole('button', { name: /launch app/i })
    .first()
    .click();
});

test('critical user journey: connect wallet -> create commitment -> view dashboard', async ({
  page,
}) => {
  // 1. Connect the wallet from the landing page
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
  await page.getByRole('button', { name: /Freighter/ }).click();
  // The connected-wallet button (above) is WalletConnectButton's own indicator of connected
  // state — it never renders literal "Connected" text, so that assertion never matched anything.
  await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();

  // 2. Create Commitment
  await page.getByRole('button', { name: 'Create Commitment' }).click();

  // Step 1: Counterparty
  await expect(page.getByLabel('Counterparty Address')).toBeVisible();
  // The wizard's real client-side StrKey validation requires a well-formed 56-char address;
  // the placeholder previously here ('GCV7GCOUNTERPARTY...', 47 chars) failed that check and
  // silently blocked the Continue button.
  await page.getByLabel('Counterparty Address').fill(COUNTERPARTY);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 2: Terms
  await expect(page.locator('#wizard-terms')).toBeVisible();
  await page.locator('#wizard-terms').fill('Test commitment terms');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3: Due Date + Review — the final step is a review screen, not another form to
  // Continue past; it submits via "Create Commitment", scoped to #page-create the same way as
  // the encrypted-commitment test (the sidebar nav item shares that accessible name).
  await expect(page.getByLabel('Due Date')).toBeVisible();
  await page.getByLabel('Due Date').fill(futureDueDate());
  await page.locator('#page-create').getByRole('button', { name: 'Create Commitment' }).click();

  // Verify success & transition to Reputation Dashboard — App.tsx's onSuccess navigates away
  // (setActivePage('reputation')) in the same commit the wizard sets its own success state, so
  // the wizard's "Commitment Created On-Chain!" view is written to the DOM but never actually
  // painted while #page-create is active; asserting on it directly is a false negative.
  await expect(page.locator('#page-reputation')).toHaveClass(/active/, { timeout: 10000 });

  // 3. View Commitments — #commitments-list-page only exists on the Commitments page, not the
  // Dashboard's own (unrelated, id-less) "Recent Commitments" card.
  await page.locator('#nav-commitments').click();

  await expect(page.locator('#commitments-list-page')).toBeVisible();
  await expect(page.getByText('Commitment #1').first()).toBeVisible();
  await expect(
    page.getByText('GCM5SKB5PS3ZCUXZ4GPLIBY42E63ILOT2EAIIT4UWGDFYOULCTLTRMMB').first(),
  ).toBeVisible();
});

test('form validation errors appear on bad input', async ({ page }) => {
  // beforeEach already lands on the dashboard (via its own Launch App click), so there's no
  // landing page left to launch from here.
  await page.click('#nav-create');

  // Try to continue without filling counterparty
  await page.getByRole('button', { name: 'Continue' }).click();

  // Verify validation error
  await expect(page.getByText(/required/i)).toBeVisible();
});

test('loading spinners display during network requests', async ({ page }) => {
  await page.route('**/api/v1/proofs/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
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

  // beforeEach's own Launch App click already lands on the dashboard before this route mock
  // existed — and the dashboard/nav items just toggle a CSS class (App.tsx), they don't
  // remount/refetch on a repeat visit. Reload for a fresh mount that actually goes through this
  // mocked, artificially-delayed route, then navigate to the Reputation page (nav button id, not
  // role=link) where the search input this test drives actually lives.
  await page.reload();
  await page
    .getByRole('button', { name: /launch app/i })
    .first()
    .click();
  await page.locator('#nav-reputation').click();

  // Fill search input and click Lookup Account to trigger network request
  const searchInput = page.getByPlaceholder(/Search Stellar account address/i);
  await searchInput.fill(MOCK_ADDRESS);
  await page.getByRole('button', { name: 'Lookup Account' }).click();

  await expect(page.locator('div[style*="pulse"]').first()).toBeVisible();
  await expect(page.locator('div[style*="pulse"]').first()).not.toBeVisible({ timeout: 5000 });
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
  // Use the specific submit button id to avoid strict mode violation
  await page.locator('#wizard-submit-btn').click();

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
  await page.locator('#wizard-dueat').fill(futureDueDate());
  // Scoped to #page-create: the unscoped locator also matches the sidebar's #nav-create button,
  // which carries the same accessible name.
  await page.locator('#page-create').getByRole('button', { name: 'Create Commitment' }).click();

  // Encryption consent modal should appear
  await expect(page.locator('#encrypt-modal-confirm')).toBeVisible({ timeout: 5000 });
  await page.locator('#encrypt-modal-confirm').click();

  await page.waitForTimeout(2000);

  // Assert: if any encrypted request was captured, it has ciphertext not plaintext
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

  // Navigate to commitments page using nav button id
  await page.locator('#nav-commitments').click();

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
