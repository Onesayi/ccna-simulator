import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openDevice, terminal, typeLines } from './helpers';

// Regenerates the README images in docs/img. Run with `npm run screenshots -w @ccna-sim/web`.
const out = (name: string) => new URL(`../../../docs/img/${name}`, import.meta.url).pathname;

/** A few labs done or in progress, so the catalog shows realistic progress bars. */
async function seedProgress(page: Page) {
  const now = Date.now();
  const done = (checks: number) => ({ startedAt: now, completedAt: now, checks, bestScore: 7, hintsUsed: 1, solutionViewed: false });
  await page.addInitScript((store) => localStorage.setItem('ccna-sim:progress:v1', JSON.stringify(store)), {
    'router-basics': done(2),
    'subnetting-hosts': done(3),
    'vlans-basic': done(1),
    'trunk-two-switches': { startedAt: now, checks: 1, bestScore: 3, hintsUsed: 0, solutionViewed: false },
  });
}

test('sandbox: ping and traceroute across the demo network', async ({ page }) => {
  await page.goto('./');
  await openDevice(page, 'PC1');
  await typeLines(page, 'ping 192.168.30.10');
  await expect(terminal(page)).toContainText('Ping statistics');
  await typeLines(page, 'tracert 192.168.30.10');
  await expect(terminal(page)).toContainText('Trace complete.');
  await page.screenshot({ path: out('ping.png') });
});

test('sandbox: VLANs and trunks on SW1', async ({ page }) => {
  await page.goto('./');
  await openDevice(page, 'SW1');
  await typeLines(page, 'enable', 'show vlan brief', 'show interfaces trunk');
  await expect(terminal(page)).toContainText('Port        Mode');
  await page.screenshot({ path: out('vlan-cli.png') });
});

test('labs: catalog with progress by blueprint domain', async ({ page }) => {
  await seedProgress(page);
  await page.goto('./#/labs');
  await expect(page.locator('.lab-catalog .card')).toHaveCount(41);
  await page.screenshot({ path: out('catalog.png') });
});

test('labs: router-on-a-stick graded live', async ({ page }) => {
  await page.goto('./#/labs/router-on-a-stick');
  await openDevice(page, 'R1');
  await typeLines(
    page,
    'enable',
    'conf t',
    'int g0/0',
    'no shut',
    'int g0/0.10',
    'encapsulation dot1q 10',
    'ip address 192.168.10.1 255.255.255.0',
    'end',
  );
  await page.getByRole('button', { name: 'Check my work' }).click();
  await expect(page.locator('.objectives li.pass')).not.toHaveCount(0);
  await page.screenshot({ path: out('lab.png') });
});

test('exam: results by domain with labs to practise', async ({ page }) => {
  // A fixed seed, so the same questions come up every time.
  await page.addInitScript(
    (session) => localStorage.getItem('ccna-sim:exam-session:v1') ?? localStorage.setItem('ccna-sim:exam-session:v1', JSON.stringify({ ...session, startedAt: Date.now() })),
    { seed: 2026, questions: 20, seconds: 1440, answers: {}, flagged: [] },
  );
  await page.goto('./#/exam');
  const options = page.locator('.question-card .options label');
  for (let i = 0; i < 20; i++) {
    await page.locator('.question-grid button', { hasText: new RegExp(`^${i + 1}$`) }).click();
    await options.nth(i % 3 === 0 ? 1 : 0).click();
  }
  await page.locator('.question-grid button', { hasText: /^4$/ }).click();
  await page.getByRole('button', { name: 'Flag for review' }).click();
  await page.screenshot({ path: out('exam-question.png') });
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Finish exam' }).first().click();
  await expect(page.getByRole('status')).toContainText('/ 1000');
  await page.screenshot({ path: out('exam-results.png') });
});

// A short walkthrough for the top of the README: open a lab, configure the router, watch objectives pass.
// Needs ffmpeg on PATH to turn the recording into a GIF; skipped otherwise.
test('walkthrough.gif', async ({ browser }) => {
  test.skip(!hasFfmpeg(), 'ffmpeg not installed');
  test.setTimeout(120_000);
  const size = { width: 1280, height: 760 };
  const dir = mkdtempSync(join(tmpdir(), 'ccna-walkthrough-'));
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, recordVideo: { dir, size } });
  const page = await context.newPage();
  const type = async (...lines: string[]) => {
    await page.locator('.console .xterm-screen').click();
    for (const line of lines) {
      await page.keyboard.type(line, { delay: 45 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(250);
    }
  };

  await page.goto('./#/labs');
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /Bring a router online/ }).click();
  await page.waitForTimeout(1200);
  await openDevice(page, 'Router');
  await type('enable', 'conf t', 'hostname R1', 'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut');
  await type('int g0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shut', 'end');
  await page.locator('.objective.quiz label', { hasText: 'show ip interface brief' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Check my work' }).click();
  await expect(page.getByRole('status')).toContainText('Lab complete');
  await page.waitForTimeout(2000);

  const video = await page.video()!.path();
  await context.close();
  // Two-pass palette keeps the GIF small and the text crisp.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf',
    'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    out('walkthrough.gif')]);
  rmSync(dir, { recursive: true, force: true });
});

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
