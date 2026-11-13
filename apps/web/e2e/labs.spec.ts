import { expect, test } from '@playwright/test';
import { openDevice, terminal, typeLines } from './helpers';

const objective = (page: import('@playwright/test').Page, text: string) =>
  page.locator('.objectives li', { hasText: text });

test('the catalog lists every lab by blueprint domain', async ({ page }) => {
  await page.goto('./#/labs');
  await expect(page.locator('.lab-catalog .card')).toHaveCount(71);
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

test('a WLAN built in the controller GUI carries a wireless laptop', async ({ page }) => {
  await page.goto('./#/labs/wlan-wpa2-psk');
  await expect(objective(page, 'AP1 has joined WLC1')).toHaveClass(/pass/);

  await openDevice(page, 'WLC1');
  await typeLines(page, 'config interface create staff 20', 'config interface address dynamic-interface staff 192.168.20.5 255.255.255.0 192.168.20.1');
  await page.getByRole('button', { name: 'Web GUI' }).click();
  await page.getByLabel('WLAN ID').fill('1');
  await page.getByLabel('SSID').fill('Staff');
  await page.getByLabel('Security').selectOption('wpa2-psk');
  await page.getByLabel('Passphrase').fill('CorpWiFi2024');
  await page.getByLabel('Interface').selectOption('staff');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByLabel('Equivalent CLI')).toContainText('config wlan security wpa akm psk set-key ascii **** 1');
  await expect(page.locator('.wlc-panel tbody tr', { hasText: 'Staff' })).toContainText('Enabled');
  await expect(objective(page, 'WLAN Staff uses WPA2-PSK')).toHaveClass(/pass/);

  await openDevice(page, 'LAPTOP1');
  await typeLines(page, 'netsh wlan connect ssid=Staff key=CorpWiFi2024');
  await expect(objective(page, 'LAPTOP1 is on Staff')).toHaveClass(/pass/);
});

test('NETCONF from the server console configures a router', async ({ page }) => {
  await page.goto('./#/labs/netconf-yang');
  await openDevice(page, 'R1');
  await typeLines(
    page,
    'enable',
    'conf t',
    'username admin privilege 15 secret Cisco123',
    'aaa new-model',
    'aaa authentication login default local',
    'aaa authorization exec default local',
    'netconf-yang',
    'end',
  );
  await expect(objective(page, 'NETCONF-YANG is enabled')).toHaveClass(/pass/);
  await openDevice(page, 'SRV');
  await typeLines(page, 'netconf-console --host 192.168.1.1 -u admin -p Cisco123 --edit-config loopback.xml');
  await expect(terminal(page)).toContainText('<ok/>');
  await expect(objective(page, 'Loopback0 is 10.0.0.1/32')).toHaveClass(/pass/);
  // A raw session: the password is masked, then the router's hello ends with ]]>]]>.
  await typeLines(page, 'ssh admin@192.168.1.1 -p 830 -s netconf', 'Cisco123');
  await expect(terminal(page)).toContainText('</hello>');
  await expect(terminal(page)).toContainText(']]>]]>');
  await page.screenshot({ path: 'test-results/netconf-ssh.png' });
});

test('DNS records on the server resolve names on a PC and a router', async ({ page }) => {
  await page.goto('./#/labs/dns-records');
  await openDevice(page, 'SRV');
  await typeLines(page, 'cat >> ccna.lab.zone <<EOF', 'www IN A 192.168.1.100', 'shop IN CNAME www', 'EOF', 'named-checkzone ccna.lab ccna.lab.zone');
  await expect(terminal(page)).toContainText('loaded serial 2026111301');
  await expect(objective(page, 'shop.ccna.lab is an alias of www')).toHaveClass(/pass/);
  await openDevice(page, 'R1');
  // A typo is looked up as a host name: the console holds the "Translating" line before the error.
  await typeLines(page, 'shwo');
  await expect(terminal(page)).toContainText('Translating "shwo"...domain server (255.255.255.255)');
  await expect(terminal(page)).toContainText('% Unknown command or computer name');
  await typeLines(page, 'enable', 'conf t', 'ip dhcp pool LAN', 'dns-server 192.168.1.100', 'domain-name ccna.lab', 'end');
  await openDevice(page, 'PC1');
  await typeLines(page, 'ipconfig /renew', 'nslookup shop');
  await expect(terminal(page)).toContainText('Aliases:  shop.ccna.lab');
  await expect(objective(page, 'PC1 learned its DNS server from DHCP')).toHaveClass(/pass/);
  await page.screenshot({ path: 'test-results/dns-nslookup.png' });
});

test('the traffic generator shows congestion in a QoS lab', async ({ page }) => {
  await page.goto('./#/labs/qos-congestion');
  await openDevice(page, 'PHONE');
  await typeLines(page, 'traffic run');
  await expect(terminal(page)).toContainText('Voice quality for VOICE: poor');
  await page.getByRole('button', { name: 'Check my work' }).click();
  await expect(objective(page, 'Calls are clear while the backup runs')).toHaveClass(/fail/);
  await expect(objective(page, 'Calls are clear while the backup runs').locator('.detail')).toContainText('not good enough for voice');
});
