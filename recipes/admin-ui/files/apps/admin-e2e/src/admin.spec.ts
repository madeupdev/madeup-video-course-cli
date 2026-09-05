import { expect, test } from '@playwright/test';

test('inventory staff can inspect titles, stock, and active rentals', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Inventory desk' })).toBeVisible();
  await expect(page.getByText('Midnight Rewind')).toBeVisible();

  await page.getByRole('link', { name: 'Copies' }).click();
  await expect(page.getByRole('heading', { name: 'Physical copies' })).toBeVisible();
  const midnightRewindStock = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Midnight Rewind' }) });
  await expect(
    midnightRewindStock.getByText('3 available of 3 total'),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Rentals' }).click();
  await expect(page.getByRole('heading', { name: 'Active rentals' })).toBeVisible();
  await expect(page.getByText('No active rentals')).toBeVisible();
});
