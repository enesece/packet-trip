import { expect, test } from '@playwright/test';

// Fixed seed and time so every screenshot is deterministic.
const SCREENS = [
  ['journey', 120],
  ['dns', 60],
  ['handshake', 150],
  ['render', 262],
] as const;

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });
    for (const [screen, t] of SCREENS) {
      test(`${screen}`, async ({ page }) => {
        await page.addInitScript(() => {
          localStorage.setItem('pt-lang', 'en');
          localStorage.setItem('pt-mode', 'story');
        });
        await page.goto(`/${screen}?seed=42&t=${t}`);
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        await expect(page).toHaveScreenshot(`${screen}-${scheme}.png`, { fullPage: true });
      });
    }
  });
}
