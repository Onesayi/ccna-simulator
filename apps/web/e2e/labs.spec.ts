import { expect, test } from '@playwright/test';
import { openDevice, typeLines } from './helpers';

const objective = (page: import('@playwright/test').Page, text: string) =>
  page.locator('.objectives li', { hasText: text });

test('the catalog lists every lab by blueprint domain', async ({ page }) => {
  await page.goto('./#/labs');
  await expect(page.locator('.lab-catalog .card')).toHaveCount(24);
  await expect(page.locator('.domain-head').first()).toContainText('1.0');
});

test('a lab grades objectives live and completes', async ({ page }) => {
  await page.goto('./#/labs');
  await page.getByRole('button', { name: /Bring a router online/ }).click();
  await expect(page).toHaveURL(/#\/labs\/router-basics$/);
  await expect(page.locator('.lab-sheet h2')).toHaveText('Bring a router online');
  await expect(objective(page, 'The router is named R1')).not.toHaveClass(/pass/);

  await openDevice(page, 'Router');
  await typeLines(page, 'enable', 'configure terminal', 'hostname R1');
  await expect(objective(page, 'The router is named R1')).toHaveClass(/pass/);

  await typeLines(
    page,
    'interface g0/0',
    'ip address 192.168.1.1 255.255.255.0',
    'no shutdown',
    'interface g0/1',
    'ip address 192.168.2.1 255.255.255.0',
    'no shutdown',
    'end',
  );
  await expect(objective(page, 'Gi0/1 is up')).toHaveClass(/pass/);

  await page.locator('.objective.quiz label', { hasText: 'show ip interface brief' }).click();
  await page.getByRole('button', { name: 'Check my work' }).click();
  await expect(objective(page, 'PC1 can ping PC2')).toHaveClass(/pass/);
  await expect(page.getByRole('status')).toContainText('Lab complete');

  // Progress is saved in the browser and shows up in the catalog.
  await page.goto('./#/labs');
  await expect(page.locator('.card', { hasText: 'Bring a router online' })).toHaveClass(/done|complete/);
});

test('a failed check explains what it saw', async ({ page }) => {
  await page.goto('./#/labs/router-basics');
  await page.getByRole('button', { name: 'Check my work' }).click();
  await expect(objective(page, 'PC1 can ping PC2')).toHaveClass(/fail/);
  await expect(objective(page, 'PC1 can ping PC2').locator('.detail')).not.toBeEmpty();
});

test('hints and the model answer are on demand', async ({ page }) => {
  await page.goto('./#/labs/router-basics');
  await objective(page, 'The router is named R1').getByRole('button', { name: 'Show hint' }).click();
  await expect(objective(page, 'The router is named R1')).toContainText('hostname R1');
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Show solution' }).click();
  await expect(page.locator('.solution pre')).toContainText('ip address 192.168.1.1 255.255.255.0');
});

test('deep links open a lab, and unknown labs fall back to the catalog', async ({ page }) => {
  await page.goto('./#/labs/floating-static');
  await expect(page.locator('.lab-sheet h2')).toContainText('floating static');
  await page.goto('./#/labs/no-such-lab');
  await expect(page).toHaveURL(/#\/labs$/);
  await expect(page.locator('.lab-catalog')).toBeVisible();
});
