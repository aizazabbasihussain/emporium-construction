import { expect, test } from '@playwright/test';

test('shell shows the app title', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();
});
