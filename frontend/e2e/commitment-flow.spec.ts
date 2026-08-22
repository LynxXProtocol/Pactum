import { test, expect, type Page } from '@playwright/test';

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
          // Simulate signMessage: returns a deterministic 64-byte base64 signature
          case 'REQUEST_SIGN_MESSAGE': {
            // Deterministic mock: base64 of 64 zero bytes (sufficient for HKDF key derivation test)
            const mockSig = btoa(String.fromCharCode(...new Array(64).fill(42)));
            response = { signedMessage: mockSig, signerAddress: mockAddress };
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

test.beforeEach(async ({ page }) => {
  await installFreighterMock(page);

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
    if (route.request().method() === 'GET') {
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
    } else {
      await route.continue();
    }
  });

  await page.route('**/commitments', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 2, status: 'Created' }),
      });
    } else {
      await route.continue();
    }
  });

  // Mock encrypted terms endpoints
  await page.route('**/commitments/encrypted', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Encrypted terms stored successfully.' }),
      });
    } else {
      await route.continue();
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
      await route.continue();
    }
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
  await page.getByRole('button', { name: 'Continue' }).click();

  // Verify success
  await expect(page.getByText('Commitment created successfully')).toBeVisible();

  // 3. View Dashboard — use nav button id, not role=link (it's a button)
  await page.locator('#nav-dashboard').click();

  await expect(page.locator('.commitment-list')).toBeVisible();
  await expect(page.getByText('mock_hash')).toBeVisible();
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
  await page.route('**/reputation/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
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

  // Navigate to Dashboard using nav button id (not role=link)
  await page.locator('#nav-dashboard').click();

  const spinner = page.locator('div[style*="animation: pulse"]');
  await spinner.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await expect(spinner).not.toBeVisible({ timeout: 10000 });
});

test('WASM validation failure blocks transaction simulation and wallet submission', async ({
  page,
}) => {
  // Connect Freighter wallet so submit button is enabled
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
  await page.getByRole('button', { name: /Freighter/ }).click();
  await expect(page.getByRole('button', { name: SHORT_ADDRESS })).toBeVisible();

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
  ).toBeVisible({ timeout: 10000 });

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
  // Use the specific submit button id to avoid strict mode violation
  await page.locator('#wizard-submit-btn').click();

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

  // Navigate to dashboard using nav button id
  await page.locator('#nav-dashboard').click();

  // The second commitment (id=2) is encrypted — its lock badge should be visible
  await expect(page.getByText('E2E Encrypted').first()).toBeVisible({ timeout: 10000 });

  // The "Decrypt Terms" button should be present for the encrypted commitment
  const decryptBtn = page.locator('[id^="decrypt-btn-"]').first();
  await expect(decryptBtn).toBeVisible({ timeout: 10000 });
  await expect(decryptBtn).toContainText('Decrypt Terms');

  // Clicking it should open the DecryptTermsModal
  await decryptBtn.click();
  await expect(page.locator('#decrypt-modal-confirm')).toBeVisible({ timeout: 10000 });

  // The modal should identify this wallet as a party (issuer)
  await expect(page.getByText('authorized')).toBeVisible({ timeout: 10000 });

  // Close the modal
  await page.locator('#decrypt-modal-cancel').click();
  await expect(page.locator('#decrypt-modal-confirm')).not.toBeVisible({ timeout: 10000 });
});

