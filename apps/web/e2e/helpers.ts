import { expect, type Page } from '@playwright/test';

/** Clicks a device on the canvas by hostname, which opens its console. */
export async function openDevice(page: Page, hostname: string) {
  await page.locator('.device-node', { has: page.locator('.name', { hasText: new RegExp(`^${hostname}$`) }) }).click();
  await expect(page.locator('.console-bar')).toContainText(hostname);
  await expect(terminal(page)).toContainText(`Connected to ${hostname}`);
}

export function terminal(page: Page) {
  return page.locator('.console .xterm-rows');
}

/** Types each line into the open console and presses Enter. */
export async function typeLines(page: Page, ...lines: string[]) {
  await page.locator('.console .xterm-screen').click();
  for (const line of lines) {
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
  }
}
