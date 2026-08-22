import { test, expect } from '@playwright/test';
import { installSigningFreighterMock } from './freighter-signing-mock';
import { getCommitmentOnChain } from './chain-helpers';

/**
 * Real end-to-end test against a local Soroban sandbox with the actual
 * RegistryContract deployed -- no mocked RPC responses, no mocked
 * `**\/commitments*` route. This is what issue #8 asks for: replacing
 * manual testnet clicks with a fast, repeatable local-sandbox run.
 *
 * SCOPE NOTE: as of writing, the frontend only implements create_commitment
 * end-to-end (see ISSUE_COMMENT_DRAFT.md) -- there's no attest/dispute/
 * resolve UI yet. This spec covers create_commitment through to the
 * dashboard showing it as "Pending", matching the real on-chain record.
 * attest -> dispute -> resolve_dispute coverage is a follow-up once that UI
 * exists (see the draft comment for the two scoping options put to the
 * issue author).
 *
 * Requires the sandbox + full stack running first:
 *   docker compose -f docker-compose.yml -f docker-compose.e2e.yml up -d
 *   ./scripts/e2e/wait-for-rpc.sh
 *   ./scripts/e2e/deploy-test-contract.sh
 */

const {
  E2E_ISSUER_ADDRESS,
  E2E_ISSUER_SECRET,
  E2E_COUNTERPARTY_ADDRESS,
  SOROBAN_NETWORK_PASSPHRASE,
} = process.env as Record<string, string>;

test.describe('create_commitment against local Soroban sandbox (#8)', () => {
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    if (!E2E_ISSUER_ADDRESS || !E2E_ISSUER_SECRET) {
      throw new Error(
        'E2E_ISSUER_ADDRESS / E2E_ISSUER_SECRET not set -- run scripts/e2e/deploy-test-contract.sh first.',
      );
    }

    await installSigningFreighterMock(page, {
      address: E2E_ISSUER_ADDRESS,
      secret: E2E_ISSUER_SECRET,
      networkPassphrase: SOROBAN_NETWORK_PASSPHRASE,
    });

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test('creating a commitment lands on-chain and appears Pending on the dashboard', async ({
    page,
  }) => {
    // Connect the (mocked, but really-signing) Freighter wallet
    const connectBtn = page.getByRole('button', { name: 'Connect Wallet' }).first();
    await expect(connectBtn).toBeVisible({ timeout: 15_000 });
    await connectBtn.click();
    await page.getByRole('button', { name: /Freighter/ }).click();
    const shortAddress = `${E2E_ISSUER_ADDRESS.slice(0, 6)}...${E2E_ISSUER_ADDRESS.slice(-4)}`;
    await expect(page.getByRole('button', { name: shortAddress })).toBeVisible({ timeout: 20_000 });

    // Enter the app shell (landing page gates the nav behind "Launch App"),
    // then open the create wizard via its stable nav id.
    const launchBtn = page.locator('#hero-launch-btn');
    if (await launchBtn.isVisible()) {
      await launchBtn.click();
    }
    await page.locator('#nav-create').click();
    await expect(page.locator('#wizard-counterparty')).toBeVisible({ timeout: 10_000 });

    await page.locator('#wizard-counterparty').fill(E2E_COUNTERPARTY_ADDRESS);
    await page.getByRole('button', { name: 'Continue' }).click();

    const terms = `E2E sandbox run ${Date.now()}`;
    await expect(page.locator('#wizard-terms')).toBeVisible({ timeout: 10_000 });
    await page.locator('#wizard-terms').fill(terms);
    await page.getByRole('button', { name: 'Continue' }).click();

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);
    await expect(page.locator('#wizard-dueat')).toBeVisible({ timeout: 10_000 });
    await page.locator('#wizard-dueat').fill(dueDate.toISOString().slice(0, 16));

    // Submit wizard using unique button id
    const submitBtn = page.locator('#wizard-submit-btn');
    await expect(submitBtn).toBeVisible({ timeout: 10_000 });
    await expect(submitBtn).toBeEnabled({ timeout: 10_000 });
    await submitBtn.click();

    // Check if an immediate contract or signing error toast appears
    const errorToast = page.locator('#toast-container .toast.error');
    if (await errorToast.isVisible({ timeout: 2000 }).catch(() => false)) {
      const msg = await errorToast.innerText();
      throw new Error(`Commitment creation failed with toast error: ${msg}`);
    }

    // The real signing + RPC round-trip takes longer than the mocked-route
    // tests; on success App.tsx's onSuccess handler transitions to the Reputation page.
    await expect(page.locator('#page-reputation')).toHaveClass(/active/, {
      timeout: 45_000,
    });
    });

    const commitmentId = 1;

    // Cross-check: what the UI just claimed happened is what actually
    // landed on-chain -- not just a plausible-looking success toast.
    const onChain = await getCommitmentOnChain(commitmentId, E2E_ISSUER_ADDRESS);
    expect(onChain.status).toBe('Pending');

    // Confirm the commitments list (fed by backend/indexer) picks up the same
    // commitment. This is the part that catches indexer/backend desync bugs --
    // the wizard succeeding doesn't guarantee the list's separate read path agrees.
    await page.locator('#nav-commitments').click();
    await expect(page.locator('#commitments-list-page')).toBeVisible({ timeout: 15_000 });

    const commitmentCard = page.locator('.commitment-item', { hasText: `Commitment #${commitmentId}` });
    await expect(commitmentCard).toBeVisible({ timeout: 25_000 }); // indexer poll latency
    await expect(commitmentCard.locator('.badge')).toHaveText(/Pending/i);
  });
});
