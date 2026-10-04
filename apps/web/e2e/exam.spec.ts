import { expect, test } from '@playwright/test';

const options = (page: import('@playwright/test').Page) => page.locator('.question-card .options label');

test('a quick exam runs against the clock and scores by domain', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Exam', exact: true }).click();
  await expect(page).toHaveURL(/#\/exam$/);
  await page.getByRole('button', { name: 'Start exam' }).click();

  await expect(page.locator('.exam-bar')).toContainText('Question 1 of 20');
  await expect(page.getByRole('timer')).toHaveText(/^2[34]:\d\d$/);

  // Answer two questions, flag one, and jump around with the navigator.
  await options(page).first().click();
  await expect(page.locator('.exam-bar')).toContainText('1 answered');
  await page.getByRole('button', { name: 'Flag for review' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.exam-bar')).toContainText('Question 2 of 20');
  await options(page).nth(1).click();
  await page.locator('.question-grid button', { hasText: /^20$/ }).click();
  await expect(page.locator('.exam-bar')).toContainText('Question 20 of 20');
  await expect(page.locator('.question-grid button').first()).toHaveClass(/flagged/);

  page.on('dialog', (d) => d.accept());
  await page.locator('.question-nav').getByRole('button', { name: 'Finish exam' }).click();

  await expect(page.getByRole('status')).toContainText('/ 1000');
  await expect(page.locator('.domain-scores tr')).toHaveCount(5);
  await expect(page.locator('.review-item.wrong').first()).toBeVisible();
  await expect(page.locator('.review-item').first().locator('.explain')).not.toBeEmpty();

  // Every missed question points at a lab; following one opens it.
  const lab = page.locator('.practise a').first();
  const href = await lab.getAttribute('href');
  await lab.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.locator('.lab-sheet h2')).toBeVisible();

  // The attempt is remembered on the setup screen.
  await page.goto('./#/exam');
  await page.getByRole('button', { name: 'New exam' }).click();
  await expect(page.locator('.exam-history tbody tr')).toHaveCount(1);
});

test('an exam can focus on one domain and survives a reload', async ({ page }) => {
  await page.goto('./#/exam');
  await page.locator('.domain-pick select').selectOption('5.0');
  await page.getByText('Half exam').click();
  await page.getByRole('button', { name: 'Start exam' }).click();
  await expect(page.locator('.exam-bar')).toContainText(/Question 1 of \d+/);
  await options(page).first().click();

  await page.reload();
  await expect(page.locator('.exam-bar')).toContainText('1 answered');
  await expect(options(page).first()).toHaveClass(/on/);

  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Finish exam' }).first().click();
  await expect(page.locator('.domain-scores tr')).toHaveCount(1);
  await expect(page.locator('.domain-scores')).toContainText('5.0');
});

test('the exam is marked when time runs out', async ({ page }) => {
  await page.clock.install();
  await page.goto('./#/exam');
  await page.getByRole('button', { name: 'Start exam' }).click();
  await expect(page.locator('.exam-bar')).toContainText('Question 1 of 20');
  await page.clock.fastForward('24:01');
  await expect(page.getByRole('status')).toContainText('0 of 20 correct');
});
