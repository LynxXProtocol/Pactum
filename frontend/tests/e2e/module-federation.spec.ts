import { test, expect } from '@playwright/test';

// Verifies the Module Federation host/remote wiring in vite.config.ts actually works at runtime:
// the dashboard and wizard remotes load and render, and — the acceptance criterion that's easy to
// silently get wrong — WalletContext and the React Query QueryClient are true shared singletons
// across the host/remote boundary, not independent per-bundle copies that happen to look similar.
// See docs/module-federation.md for why each check below is the specific thing that would break
// if that sharing were misconfigured.

declare global {
  interface Window {
    __PACTUM_WALLET_PROVIDER_MODULE_ID__?: string;
    __PACTUM_DASHBOARD_SEEN_WALLET_MODULE_ID__?: string;
    __PACTUM_WIZARD_SEEN_WALLET_MODULE_ID__?: string;
    __PACTUM_QUERY_CLIENT__?: unknown;
    __PACTUM_DASHBOARD_SEEN_QUERY_CLIENT__?: unknown;
  }
}

test.describe('Module Federation: host + remotes', () => {
  test('dashboard remote loads and renders via Module Federation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Launch App' }).first().click();
    await page.click('#nav-reputation');

    // #dashboard-remote-wallet-status only exists in frontend-dashboard-remote/src/ReputationDashboard.tsx —
    // its presence proves the remote module actually loaded and rendered inside the host, not just
    // that the host shell rendered around a failed/empty Suspense boundary.
    await expect(page.locator('#dashboard-remote-wallet-status')).toBeVisible();
  });

  test('wizard remote loads and renders via Module Federation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Launch App' }).first().click();
    await page.click('#nav-create');

    // #wizard-remote-wallet-status only exists in frontend-wizard-remote/src/CreateCommitmentWizard.tsx.
    await expect(page.locator('#wizard-remote-wallet-status')).toBeVisible();
    await expect(page.locator('.wizard-steps')).toBeVisible();
  });

  test('WalletContext is a true shared singleton across host and both remotes', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Launch App' }).first().click();

    // Visit the dashboard, forcing frontend-dashboard-remote's useWallet() to run and record what
    // module instance it read from.
    await page.click('#nav-reputation');
    await expect(page.locator('#dashboard-remote-wallet-status')).toBeVisible();

    // Visit the wizard, same idea for frontend-wizard-remote.
    await page.click('#nav-create');
    await expect(page.locator('#wizard-remote-wallet-status')).toBeVisible();

    const ids = await page.evaluate(() => ({
      provider: window.__PACTUM_WALLET_PROVIDER_MODULE_ID__,
      dashboard: window.__PACTUM_DASHBOARD_SEEN_WALLET_MODULE_ID__,
      wizard: window.__PACTUM_WIZARD_SEEN_WALLET_MODULE_ID__,
    }));

    expect(ids.provider, 'host WalletProvider should have set its module id').toBeTruthy();
    // If either remote had bundled its own copy of WalletContext.tsx instead of consuming the
    // host's exposed module, useWallet() there would either throw (no Provider in that copy's
    // context tree) or, if it somehow rendered, report a *different* module id than the host's.
    // Equality here is a referential-identity proof, not a behavioral inference.
    expect(ids.dashboard).toBe(ids.provider);
    expect(ids.wizard).toBe(ids.provider);
  });

  test('the QueryClient is a true shared singleton, reachable via React Query Context from a remote', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Launch App' }).first().click();
    await page.click('#nav-reputation');
    await expect(page.locator('#dashboard-remote-wallet-status')).toBeVisible();

    const same = await page.evaluate(() => window.__PACTUM_QUERY_CLIENT__ === window.__PACTUM_DASHBOARD_SEEN_QUERY_CLIENT__);

    // __PACTUM_QUERY_CLIENT__ is set once, in the host's lib/queryClient.ts, at module
    // evaluation. __PACTUM_DASHBOARD_SEEN_QUERY_CLIENT__ is set inside the dashboard remote via
    // useQueryClient() — React Query's own Context hook, not the direct `host/queryClient`
    // import used elsewhere in this codebase. Their being `===` proves both that the client
    // instance is shared *and* that @tanstack/react-query's `shared: { singleton: true }`
    // config in vite.config.ts is actually deduplicating the package, since useQueryClient()
    // would otherwise be reading a different copy's Context.
    expect(same).toBe(true);
  });

  test('remote failure degrades gracefully instead of white-screening the host', async ({ page }) => {
    // Block the wizard remote's entry so the host has to handle a real load failure.
    await page.route('http://localhost:5175/remoteEntry.js', (route) => route.abort());

    await page.goto('/');
    await page.getByRole('button', { name: 'Launch App' }).first().click();
    await page.click('#nav-create');

    await expect(page.locator('.inline-alert.warning', { hasText: 'wizard' })).toBeVisible();
    // The rest of the shell must still be usable.
    await expect(page.locator('#nav-dashboard')).toBeVisible();
  });
});
