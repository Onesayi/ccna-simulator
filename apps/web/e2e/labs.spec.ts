import { expect, test } from '@playwright/test';
import { openDevice, terminal, typeLines } from './helpers';

const objective = (page: import('@playwright/test').Page, text: string) =>
  page.locator('.objectives li', { hasText: text });

test('the catalog lists every lab by blueprint domain', async ({ page }) => {
  await page.goto('./#/labs');
  await expect(page.locator('.lab-catalog .card')).toHaveCount(33);
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

test('spanning tree blocks a parallel link until EtherChannel bundles both', async ({ page }) => {
  await page.goto('./#/labs/etherchannel-lacp');
  await expect(page.locator('.react-flow__edge.link-blocked')).toHaveCount(1);
  await openDevice(page, 'SW1');
  await typeLines(page, 'enable', 'conf t', 'interface range g0/1 - 2', 'channel-group 1 mode active', 'end');
  await openDevice(page, 'SW2');
  await typeLines(page, 'enable', 'conf t', 'interface range g0/1 - 2', 'channel-group 1 mode passive', 'end');
  await expect(objective(page, 'SW2 bundles both links into Po1 with LACP')).toHaveClass(/pass/);
  await expect(page.locator('.react-flow__edge.link-blocked')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge.link-bundled')).toHaveCount(2);
  await typeLines(page, 'show etherchannel summary');
  await expect(terminal(page)).toContainText('Po1(SU)');
});

test('a PC gets an IPv6 address with SLAAC', async ({ page }) => {
  await page.goto('./#/labs/ipv6-addressing');
  await openDevice(page, 'R1');
  await typeLines(page, 'enable', 'conf t', 'ipv6 unicast-routing', 'int g0/1', 'ipv6 address 2001:db8:acad:2::/64 eui-64', 'no shutdown', 'end');
  await openDevice(page, 'PC2');
  await typeLines(page, 'ipv6config autoconfig');
  await expect(terminal(page)).toContainText('IPv6 Address....................: 2001:DB8:ACAD:2:');
  await expect(objective(page, 'PC2 built its own address with SLAAC')).toHaveClass(/pass/);
});
