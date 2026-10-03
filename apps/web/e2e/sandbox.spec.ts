import { expect, test } from '@playwright/test';
import { openDevice, terminal, typeLines } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.device-node')).toHaveCount(7);
});

test('loads the demo network', async ({ page }) => {
  await expect(page).toHaveTitle(/CCNA Simulator/);
  for (const name of ['R1', 'R2', 'SW1', 'PC1']) await expect(page.locator('.device-node .name', { hasText: name }).first()).toBeVisible();
  await expect(page.locator('.react-flow__edge')).not.toHaveCount(0);
});

test('PC1 pings across both routers', async ({ page }) => {
  await openDevice(page, 'PC1');
  await typeLines(page, 'ping 192.168.30.10');
  await expect(terminal(page)).toContainText('Ping statistics for 192.168.30.10');
  // The first ping loses packets while ARP resolves on each hop, just like real IOS; the second is clean.
  await expect(terminal(page)).toContainText('Reply from 192.168.30.10');
  await typeLines(page, 'ping 192.168.30.10');
  await expect(terminal(page)).toContainText('Received = 4, Lost = 0');
});

test('the router console speaks IOS', async ({ page }) => {
  await openDevice(page, 'R1');
  await typeLines(page, 'enable', 'show ip route');
  await expect(terminal(page)).toContainText('Gateway of last resort');
  await expect(terminal(page)).toContainText(/S\s+192\.168\.30\.0/);
  await typeLines(page, 'conf t', 'hostname EDGE1', 'end');
  await expect(page.locator('.console-bar')).toContainText('EDGE1');
  await expect(page.locator('.device-node .name', { hasText: 'EDGE1' })).toBeVisible();
});

test('adds and deletes a device', async ({ page }) => {
  await page.getByRole('button', { name: '+ Router' }).click();
  await expect(page.locator('.device-node')).toHaveCount(8);
  await page.locator('.device-node').last().click();
  await page.getByRole('button', { name: 'Delete device' }).click();
  await expect(page.locator('.device-node')).toHaveCount(7);
});
