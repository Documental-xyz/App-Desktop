/**
 * @vitest-environment node
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RENDERER_DIR = join(__dirname, '../renderer');

test.describe('Config Page - Header Logo', () => {
  test('displays Documental logo PNG in the config header', async ({ page }) => {
    const configHtmlPath = join(RENDERER_DIR, 'config.html');
    await page.goto(`file://${configHtmlPath}`);

    // Wait for the page to load
    await page.waitForLoadState('domcontentloaded');

    // Find the header logo image
    const headerLogo = page.locator('header img[src*="logo-documental"]');
    await expect(headerLogo).toBeVisible();

    // Verify it's an image with the correct source
    await expect(headerLogo).toHaveAttribute('src', './assets/img/logo-documental.png');
    await expect(headerLogo).toHaveAttribute('alt', 'Documental');

    // Verify the image has header-appropriate sizing (matching main.html h-6 w-6)
    await expect(headerLogo).toHaveClass(/h-6/);
    await expect(headerLogo).toHaveClass(/w-6/);

    // Verify the "Documental" heading text is still present next to the logo
    const heading = page.locator('header h1:has-text("Documental")');
    await expect(heading).toBeVisible();
    await expect(heading).toHaveClass(/text-4xl/);
    await expect(heading).toHaveClass(/font-black/);

    // Verify the separator "/" is present between heading and config title
    const separator = page.locator('header span:has-text("/")');
    await expect(separator).toBeVisible();

    // Verify the config title is present
    const configTitle = page.locator('header h2');
    await expect(configTitle).toBeVisible();

    // Verify the logo is inside the brand container (first div in header)
    const brandContainer = page.locator('header > div:first-child');
    await expect(brandContainer).toBeVisible();
  });

  test('logo loads successfully without 404', async ({ page }) => {
    const configHtmlPath = join(RENDERER_DIR, 'config.html');
    const responsePromise = page.waitForResponse(response =>
      response.url().includes('logo-documental.png')
    );

    await page.goto(`file://${configHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });

  test('all other header elements remain intact', async ({ page }) => {
    const configHtmlPath = join(RENDERER_DIR, 'config.html');
    await page.goto(`file://${configHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    // Verify save button is present
    const saveBtn = page.locator('header button:has-text("Save")');
    await expect(saveBtn).toBeVisible();

    // Verify back button is present
    const backBtn = page.locator('header a.btn-back');
    await expect(backBtn).toBeVisible();

    // Verify the separator "/" is still present
    const separator = page.locator('header span:has-text("/")');
    await expect(separator).toBeVisible();

    // Verify h1 says "Documental"
    const heading = page.locator('header h1');
    await expect(heading).toHaveText('Documental');

    // Verify h2 config title is still present
    const configTitle = page.locator('header h2');
    await expect(configTitle).toBeVisible();
  });
});
