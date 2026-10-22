import { expect, test } from '@playwright/test';

test.describe('the trip', () => {
  test('press Enter starts the run and the DNS stop completes', async ({ page }) => {
    await page.goto('/journey?seed=42');
    await page.getByRole('button', { name: /Press Enter/ }).click();
    // At 0.05× the 86 ms DNS lookup takes about 1.7 s of real time.
    await expect(page.getByRole('button', { name: /DNS lookup — done/ })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('open packet 5, toggle Decrypt, read the plaintext', async ({ page }) => {
    // With a warm browser DNS cache the TCP handshake starts at packet 1, so packet 5 is the
    // server's first encrypted flight.
    await page.goto('/handshake?seed=42&dns=browser&packet=5');
    await expect(page.getByRole('heading', { level: 2, name: /ServerHello/ })).toBeVisible();
    await page.getByRole('button', { name: 'Decrypt' }).click();
    const dec = page.getByTestId('decrypted').first();
    await expect(dec).toContainText('EncryptedExtensions');
    await expect(dec).toContainText(/simulated|AES-128-GCM/);

    // The first request: the plaintext really is an HTTP/1.1 GET.
    await page.goto('/handshake?seed=42&dns=browser&packet=9');
    await expect(page.getByRole('heading', { level: 2, name: 'GET /' })).toBeVisible();
    await page.getByRole('button', { name: 'Decrypt' }).click();
    const plain = page.getByTestId('plaintext').first();
    await expect(plain).toContainText('GET / HTTP/1.1');
    await expect(plain).toContainText('Host: example.com');
    await expect(plain).toContainText('User-Agent: PacketTrip/1.0');
  });

  test('a longer round trip makes the total grow', async ({ page }) => {
    await page.goto('/handshake?seed=42&packet=9');
    await page.getByRole('button', { name: /What if/ }).click();
    const dialog = page.getByRole('dialog');
    const total = dialog.getByRole('status');
    const before = Number((await total.locator('p').nth(1).innerText()).replace(/[^\d]/g, ''));
    const thumb = dialog.getByRole('slider').first();
    await thumb.focus();
    await thumb.press('End');
    await expect(total).toContainText('+', { timeout: 10_000 });
    const after = Number((await total.locator('p').nth(1).innerText()).replace(/[^\d]/g, ''));
    expect(after).toBeGreaterThan(before * 2);
  });

  test('arrow keys step through packets on the handshake screen', async ({ page }) => {
    await page.goto('/handshake?seed=42&packet=9');
    await expect(page.getByRole('heading', { level: 2, name: 'SYN' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('heading', { level: 2, name: 'SYN, ACK' })).toBeVisible();
    await expect(page).toHaveURL(/packet=10/);
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('heading', { level: 2, name: 'SYN' })).toBeVisible();
  });

  test('unknown sites get a friendly picker', async ({ page }) => {
    await page.goto('/journey');
    await page.getByLabel('Address', { exact: true }).fill('https://news.example.org');
    await page.getByRole('button', { name: /Press Enter/ }).click();
    await expect(page.getByRole('alert')).toContainText('only knows a few made-up sites');
    await page.getByRole('button', { name: /heavy\.example/ }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('expert self-test passes every check', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pt-mode', 'expert'));
    await page.goto('/journey?seed=42');
    await page.getByRole('button', { name: /Event log, checks and keys/ }).click();
    await page.getByRole('tab', { name: 'Checks' }).click();
    await page.getByRole('button', { name: 'Run checks' }).click();
    await expect(page.getByRole('status')).toHaveText('5 of 5 checks passed');
  });

  test('no horizontal page scroll', async ({ page }) => {
    for (const path of ['journey', 'dns', 'handshake', 'render']) {
      await page.goto(`/${path}?seed=42&t=150`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});
