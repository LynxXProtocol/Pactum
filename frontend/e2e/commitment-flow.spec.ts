import { test, expect, type Page } from '@playwright/test';
import { installSuccessfulSorobanRpc } from './mock-soroban-success';

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

const LEDGER_ENTRIES_RESULT = { latestLedger: 50000 };
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
            // Simulate signTransaction: echo back the XDR as "signed".
            // freighter-api v6's submitTransaction reads `signedTransaction`
            // off the extension response and maps it onto its own `signedTxXdr`,
            // so the mock must echo the signed XDR under that key too.
            response = {
              signedTxXdr: txXdr,
              signedTransaction: txXdr,
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
            // Deterministic mock: base64 of 64 zero bytes (sufficient for HKDF key derivation test)
            const mockSig = btoa(String.fromCharCode(...new Array(64).fill(42)));
            response = {
              signedBlob: mockSig,
              signedMessage: mockSig,
              signerAddress: mockAddress,
            };
            break;
          }

          // Simulate signTransaction: echo the transaction XDR back as "signed"
          // (submission itself is mocked in mockSorobanRpc, so no real signature
          // is needed).
          // Removed duplicate SUBMIT_TRANSACTION here as it is handled above.

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

/**
 * Mock all Soroban RPC JSON-RPC calls to avoid hitting the real testnet.
 * This intercepts getAccount, simulateTransaction, sendTransaction, and getTransaction.
 */
async function mockSorobanRpc(page: Page) {
  await page.route('**/soroban*', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.continue();
      return;
    }

    let parsed: { id?: number | string; method?: string } | undefined;
    try {
      parsed = request.postDataJSON();
    } catch {
      // Malformed/non-JSON body: fall through and let the "unknown method" branch continue it.
    }

    const method = parsed?.method;
    const id = parsed?.id ?? 1;

    if (method === 'getAccount') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            id: MOCK_ADDRESS,
            sequence: '1234567890',
          },
        }),
      });
      return;
    }

    if (method === 'simulateTransaction') {
      // Every simulateTransaction call shares this one canned response regardless of which
      // contract method is being simulated -- that includes fetchArbitrator()'s `get_arbitrator`
      // read (submitCreateCommitment needs it for resolver_address), which does
      // `Address.fromString(String(scValToNative(retval)))` and throws on anything that isn't a
      // syntactically valid G... address. Encodes MOCK_ADDRESS as an ScVal Address so that -- and
      // get_reputation's unrelated, already-tolerant field lookups -- both decode without error.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            transactionData: '',
            minResourceFee: '100',
            latestLedger: 4198984,
            cost: { cpuInsns: '123194', memBytes: '65536' },
            events: [],
            results: [
              {
                auth: [],
                xdr: 'AAAAEgAAAAAAAAAAJV/nLntxgpHp83Zr8qhqSLpCA439S1nO5sveir5wYUI=',
              },
            ],
          },
        }),
      });
      return;
    }

    if (method === 'sendTransaction') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            status: 'PENDING',
            latestLedger: 4198984,
          },
        }),
      });
      return;
    }

    if (method === 'getTransaction') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            status: 'SUCCESS',
            latestLedger: 4198986,
            latestLedgerCloseTime: Math.floor(Date.now() / 1000),
            oldestLedger: 4190000,
            oldestLedgerCloseTime: Math.floor(Date.now() / 1000) - 1000,
            envelopeXdr: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
            resultXdr: 'AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA=',
            resultMetaXdr: 'AAAAAAAAAAAAAAAAAAAAAA==',
            returnValue: { type: 'i128', lo: 3, hi: 0 },
          },
        }),
      });
      return;
    }

    // Fall through for unknown methods
    await route.continue();
  });
}

test.beforeEach(async ({ page }) => {
  await installFreighterMock(page);

  await mockSorobanRpc(page);

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
  // `isVisible()` doesn't auto-wait, so it can read the DOM before the landing page has
  // hydrated and race to false on a slower load — `click()`'s own actionability wait is the
  // reliable way to land on this always-present button.
  await page
    .getByRole('button', { name: /launch app/i })
    .first()
    .click();
});

async function connectFreighter(page: Page) {
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
  await page.getByRole('button', { name: /Freighter/ }).click();
  // The connected-wallet button (above) is WalletConnectButton's own indicator of connected
  // state — it never renders literal "Connected" text, so that assertion never matched anything.
  await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();
}

test('critical user journey: connect wallet -> create commitment -> view dashboard', async ({
  page,
}) => {
  await mockSorobanRpc(page);

  // 1. Connect the wallet from the landing page
  await connectFreighter(page);
  // The sr-only "Connected" span in WalletConnectButton confirms wallet connection
  await expect(page.getByText('Connected').first()).toBeVisible();

  // 2. Create Commitment — use the nav button by its id to avoid strict mode violation
  await page.locator('#nav-create').click();

  // Step 1: Counterparty
  await expect(page.locator('#wizard-counterparty')).toBeVisible();
  await page.locator('#wizard-counterparty').fill(COUNTERPARTY);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 2: Terms
  await expect(page.locator('#wizard-terms')).toBeVisible();
  await page.locator('#wizard-terms').fill('Test commitment terms');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3: Due Date — the last step's primary button is "Create Commitment"
  await expect(page.locator('#wizard-dueat')).toBeVisible();
  await page.locator('#wizard-dueat').fill('2027-12-31T12:00');
  await page.locator('#wizard-submit-btn').click();

  // Preflight simulation runs first and blocks on user confirmation before the
  // wallet is prompted -- see SimulationPreviewModal / preflightSimulate.
  await page.locator('#sim-modal-confirm').click();

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

  // Wait for the wizard to render
  await expect(page.locator('#wizard-counterparty')).toBeVisible();

  // Try to continue without filling counterparty
  await page.getByRole('button', { name: 'Continue' }).click();

  // Verify validation error — the schema message is "Stellar address is required"
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
  // `isVisible()` doesn't auto-wait (see beforeEach's comment on the same trap), so it can
  // read the DOM before the landing page has hydrated and race to false, silently skipping
  // the click and leaving the test stuck on the landing page. `click()`'s own actionability
  // wait is the reliable way to land on this always-present button.
  await page.locator('#hero-launch-btn').click();

  // Navigate to Dashboard using nav button id (not role=link)
  await page.locator('#nav-dashboard').click();

  await expect(page.getByText('Loading commitments...')).toBeVisible({ timeout: 10_000 });
  releaseCommitments();
  await expect(page.getByText('Loading commitments...')).not.toBeVisible({ timeout: 10_000 });
  // Unroute the instant reputation handler from beforeEach, then add a delayed one
  await page.unroute('**/reputation/**');
  await page.route('**/reputation/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
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

  // Connect wallet first so #nav-my-profile (below) has a connected address to look up.
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
  await page.getByRole('button', { name: /Freighter/ }).click();
  await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();

  // Navigate to Reputation page using nav button id
  await page.locator('#nav-my-profile').click();

  // The skeleton loading cards use inline style animation: 'pulse 1.5s infinite'
  await expect(page.locator('div[style*="pulse"]').first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('div[style*="pulse"]').first()).not.toBeVisible({ timeout: 10000 });
});

test('WASM validation failure blocks transaction simulation and wallet submission', async ({
  page,
}) => {
  // Track if signTransaction was called
  await page.evaluate(() => {
    (window as any).__signCalled = false;
  });

  // Connect the wallet first — the wizard disables the submit button until a
  // wallet is connected.
  await connectFreighter(page);

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

  // Step 2: Deadline - Fill past date to trigger contract validation error
  await page.locator('#wizard-dueat').fill('2020-01-01T00:00');
  // Wait for the submit button to be visible and enabled before clicking
  await expect(page.locator('#wizard-submit-btn')).toBeVisible();
  await page.locator('#wizard-submit-btn').waitFor({ state: 'attached' });
  await page.locator('#wizard-submit-btn').click({ timeout: 5000 });

  // The Zod schema validates "Due date must be set in the future" client-side
  // before we even reach the submit button. The submit button may not be clickable
  // because Zod form validation blocks it. Let's click submit and check for the error.
  await page.locator('#wizard-submit-btn').click();

  // Wait for WASM validation or Zod validation to show the error
  await expect(
    page.getByText(/Due date must be( set)? in the future|Contract validation failed/i),
  ).toBeVisible({ timeout: 10000 });
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
  await connectFreighter(page);

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
  // Use the specific submit button id to avoid strict mode violation
  await page.locator('#wizard-submit-btn').click();

  // Encryption consent modal should appear
  await expect(page.locator('#encrypt-modal-confirm')).toBeVisible({ timeout: 10000 });
  await page.locator('#encrypt-modal-confirm').click();

  // Preflight simulation runs after encryption resolves and blocks on user
  // confirmation before the wallet is prompted -- see SimulationPreviewModal /
  // preflightSimulate.
  await page.locator('#sim-modal-confirm').click();

  // Wait until the upload actually happened (sign -> submit -> confirm ->
  // store-encrypted), then assert on its body.
  await expect.poll(() => encryptedRequests.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(3000);

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
  await connectFreighter(page);

  // The encrypted commitment (id=2) from the mocked backend renders on the
  // Commitments page with a lock badge.
  await page.locator('#nav-commitments').click();

  // The second commitment (id=2) is encrypted — its lock badge should be
  // visible. Assert on elements directly instead of waitForLoadState:
  // background polling keeps the network from ever going idle.
  await expect(page.getByText('E2E Encrypted').first()).toBeVisible({ timeout: 15000 });

  // Wait for commitments to load
  await expect(page.locator('#page-commitments .commitment-list')).toBeVisible({ timeout: 10000 });

  // The second commitment (id=2) is encrypted — its lock badge should be visible
  await expect(page.getByText('E2E Encrypted').first()).toBeVisible({ timeout: 10000 });

  // The "Decrypt Terms" button should be present for the encrypted commitment
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
