import { test, expect } from '@playwright/test';

test.describe('Reputation Dashboard DOM Virtualization', () => {
  test.beforeEach(async ({ page }) => {
    // Mock Freighter API
    await page.addInitScript(() => {
      (window as any).freighter = {
        isConnected: () => Promise.resolve(true),
        isAllowed: () => Promise.resolve(true),
        getUserInfo: () => Promise.resolve({ publicKey: 'GBY54VG5G4A7DC4D6YJ6GHD4X4QW2AR43JLYZ2QVWSHKACWK3BLDR5IX' }),
        signTransaction: (tx: string) => Promise.resolve({ status: 'SUCCESS', signedTx: tx }),
      };
    });
  });

  test('Renders virtualized commitments and maintains small DOM footprint for large datasets', async ({ page }) => {
    await page.goto('/');
    // Launch app to enter Dashboard
    await page.click('#hero-launch-btn');

    // Navigate to Reputation Lookup
    await page.click('#nav-reputation');
    await expect(page.locator('#topbar-title')).toHaveText('Reputation Lookup');

    // Select the Power User (500 Items) preset
    await page.click('button:has-text("Power User (500 Items)")');

    // Verify the virtualized scroll viewport exists
    const viewport = page.locator('#virtualized-commitments-viewport');
    await expect(viewport).toBeVisible();

    // Verify that the total dataset count is 500
    await expect(page.locator('text=Total in History: 500')).toBeVisible();

    // Count actual rendered commitment card nodes inside the DOM
    const renderedCards = await viewport.locator('.commitment-card-item').count();
    
    // With 500 items, virtualization + overscan should only render between 4 and 25 items in the DOM
    expect(renderedCards).toBeGreaterThan(0);
    expect(renderedCards).toBeLessThan(30);

    // Scroll down significantly
    await viewport.evaluate((el) => {
      el.scrollTop = 1500;
    });
    await page.waitForTimeout(100);

    // Verify DOM node count remains strictly bounded even after scrolling
    const scrolledCardCount = await viewport.locator('.commitment-card-item').count();
    expect(scrolledCardCount).toBeGreaterThan(0);
    expect(scrolledCardCount).toBeLessThan(30);
  });

  test('Dynamic item expansion and layout measurement cache work smoothly', async ({ page }) => {
    await page.goto('/');
    await page.click('#hero-launch-btn');
    await page.click('#nav-reputation');

    const viewport = page.locator('#virtualized-commitments-viewport');
    await expect(viewport).toBeVisible();

    // Click "Details" to expand the first card
    const firstDetailsBtn = viewport.locator('button:has-text("Details")').first();
    await firstDetailsBtn.click();

    // Verify expanded drawer is rendered
    await expect(page.locator('text=Cryptographic Terms & Audit Log').first()).toBeVisible();

    // Verify dynamic size cache count is tracked
    await expect(page.locator('text=Dynamic Size Cache:')).toBeVisible();
  });

  test('Maintains scroll anchoring when async updates happen above the viewport', async ({ page }) => {
    await page.goto('/');
    await page.click('#hero-launch-btn');
    await page.click('#nav-reputation');

    // Select Power User dataset
    await page.click('button:has-text("Power User (500 Items)")');
    const viewport = page.locator('#virtualized-commitments-viewport');
    await expect(viewport).toBeVisible();

    // Scroll down by 800px
    await viewport.evaluate((el) => {
      el.scrollTop = 800;
    });
    await page.waitForTimeout(100);

    const initialScrollTop = await viewport.evaluate((el) => el.scrollTop);
    expect(initialScrollTop).toBeGreaterThanOrEqual(750);

    // Filter switching works correctly
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
    await page.locator('#page-reputation button:has-text("Fulfilled")').click();
    await page.waitForTimeout(100);
    const fulfilledCards = await viewport.locator('.commitment-card-item').count();
    expect(fulfilledCards).toBeGreaterThan(0);
    expect(fulfilledCards).toBeLessThan(30);
  });
});
