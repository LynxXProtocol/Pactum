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
  });

  test('creating a commitment lands on-chain and appears Pending on the dashboard', async ({
    page,
  }) => {
    // Connect the (mocked, but really-signing) Freighter wallet. Assertion
    // pattern matches the confirmed-working frontend/e2e/wallet-connect.spec.ts,
    // not the unverified 'Connected' text used in commitment-flow.spec.ts.
    await page.getByRole('button', { name: 'Connect Wallet' }).click();
    await page.getByRole('button', { name: /Freighter/ }).click();
    const shortAddress = `${E2E_ISSUER_ADDRESS.slice(0, 6)}...${E2E_ISSUER_ADDRESS.slice(-4)}`;
    await expect(page.getByRole('button', { name: shortAddress })).toBeVisible();

    // Launch the create wizard. Selectors below match the real
    // CreateCommitmentWizard.tsx markup (#wizard-counterparty etc, same ids
    // used by frontend/e2e/contract-errors.spec.ts's fillWizardAndSubmit).
    await page.getByRole('button', { name: 'Create Commitment' }).click();

    await page.locator('#wizard-counterparty').fill(E2E_COUNTERPARTY_ADDRESS);
    await page.getByRole('button', { name: 'Continue' }).click();

    const terms = `E2E sandbox run ${Date.now()}`;
    await page.locator('#wizard-terms').fill(terms);
    await page.getByRole('button', { name: 'Continue' }).click();

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);
    await page.locator('#wizard-dueat').fill(dueDate.toISOString().slice(0, 16));

    // This actually calls submitCreateCommitment() against the real sandbox
    // RPC and waits for our mocked Freighter to sign it -- no mocked
    // network responses standing in for the real flow.
    await page.getByRole('button', { name: 'Create Commitment' }).click();

    // The real signing + RPC round-trip takes longer than the mocked-route
    // tests; give it real headroom rather than the default 5s.
    await expect(page.getByText('Commitment Created On-Chain!')).toBeVisible({
      timeout: 30_000,
    });

    // The success view has no data-testid -- it renders
    // "Commitment ID:" next to "#<id>" as sibling spans inside a detail
    // row div, confirmed against the real component. Locate the row by its
    // label text, then read the adjacent id span. (Consider adding
    // data-testid="created-commitment-id" to that span in this same PR --
    // it's a one-line, low-risk change that makes this far less brittle
    // than matching on the exact "Commitment ID:" label text.)
    const idRow = page.locator('div', { hasText: 'Commitment ID:' }).last();
    const idText = await idRow.locator('span').last().innerText();
    const commitmentId = Number(idText.replace(/\D/g, ''));

    // Cross-check: what the UI just claimed happened is what actually
    // landed on-chain -- not just a plausible-looking success toast.
    const onChain = await getCommitmentOnChain(commitmentId, E2E_ISSUER_ADDRESS);
    expect(onChain.status).toBe('Pending');

    // Now confirm the dashboard (fed by backend/indexer, not the wizard's
    // own state) picks up the same commitment as Pending. This is the part
    // that actually catches indexer/backend desync bugs -- the wizard
    // succeeding doesn't guarantee the dashboard's separate read path agrees.
    await page.getByRole('link', { name: 'Dashboard' }).click();

    const row = page.locator('table tbody tr', { hasText: `#${commitmentId}` });
    await expect(row).toBeVisible({ timeout: 20_000 }); // indexer poll latency
    await expect(row.getByText('Pending')).toBeVisible();
  });
});
