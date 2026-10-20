import { test, expect } from '@playwright/test';

test.describe('Predictive UI Prefetching', () => {
  test.beforeEach(async ({ page }) => {
    // Mock Freighter API
    await page.addInitScript(() => {
      (window as any).freighter = {
        isConnected: () => Promise.resolve(true),
        isAllowed: () => Promise.resolve(true),
        getUserInfo: () =>
          Promise.resolve({
            publicKey: 'GCV7G73HBBHMFHNK4I2U2XNIMV2A7H2LZ5SJZV2QBN56N74676YDFGXY',
          }),
        signTransaction: (tx: string) => Promise.resolve({ status: 'SUCCESS', signedTx: tx }),
      };
    });
  });

  test('Prefetches query when approaching and hovering preset address buttons', async ({
    page,
  }) => {
    let prefetchCalled = false;

    await page.route(/reputation\/GB4U/i, async (route) => {
      prefetchCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          address: 'GB4UFBX57KE2RPEXB4NCPQHXL5UZL7HSFBVQ2YEZQDZ2DXR2X3CHHZX',
          fulfilled: 10,
          late: 1,
          breached: 0,
          total: 11,
        }),
      });
    });

    await page.goto('/');
    const heroBtn = page.locator('#hero-launch-btn');
    await expect(heroBtn).toBeVisible();
    await heroBtn.click();

    await expect(page.locator('#topbar-title')).toHaveText('Dashboard');
    await page.click('#nav-reputation');

    const presetBtn = page.getByRole('button', { name: /Counterparty \(GB4U\.\.\.\)/i });
    await expect(presetBtn).toBeVisible();

    const box = await presetBtn.boundingBox();
    if (box) {
      await page.mouse.move(box.x - 50, box.y - 50);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    } else {
      await presetBtn.hover();
    }

    await page.waitForTimeout(300);
    expect(prefetchCalled).toBe(true);
  });

  test('Respects Save-Data header and disables prefetching on metered connections', async ({
    page,
  }) => {
    let prefetchRequested = false;

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', {
        value: { saveData: true, effectiveType: '4g' },
        configurable: true,
      });
    });

    await page.route(/reputation\/GB4U/i, async (route) => {
      prefetchRequested = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ address: 'test', fulfilled: 0, late: 0, breached: 0, total: 0 }),
      });
    });

    await page.goto('/');
    const heroBtn = page.locator('#hero-launch-btn');
    await expect(heroBtn).toBeVisible();
    await heroBtn.click();

    await expect(page.locator('#topbar-title')).toHaveText('Dashboard');
    await page.click('#nav-reputation');

    const presetBtn = page.getByRole('button', { name: /Counterparty \(GB4U\.\.\.\)/i });
    await expect(presetBtn).toBeVisible();

    const box = await presetBtn.boundingBox();
    if (box) {
      await page.mouse.move(box.x - 50, box.y - 50);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    } else {
      await presetBtn.hover();
    }

    await page.waitForTimeout(300);
    expect(prefetchRequested).toBe(false);
  });
});
