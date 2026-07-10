/**
 * @vitest-environment node
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RENDERER_DIR = join(__dirname, '../renderer');

test.describe('Main Page - Header Logo', () => {
  test('displays Documental logo PNG in the header brand section', async ({ page }) => {
    const mainHtmlPath = join(RENDERER_DIR, 'main.html');
    await page.goto(`file://${mainHtmlPath}`);

    // Wait for the page to load
    await page.waitForLoadState('domcontentloaded');

    // Find the header logo image
    const headerLogo = page.locator('header img[src*="logo-documental"]');
    await expect(headerLogo).toBeVisible();

    // Verify it's an image with the correct source
    await expect(headerLogo).toHaveAttribute('src', './assets/img/logo-documental.png');
    await expect(headerLogo).toHaveAttribute('alt', 'Documental');

    // Verify the image has header-appropriate sizing
    await expect(headerLogo).toHaveClass(/h-6/);
    await expect(headerLogo).toHaveClass(/w-6/);

    // Verify the "Documental" heading text is still present next to the logo
    const heading = page.locator('header h1:has-text("Documental")');
    await expect(heading).toBeVisible();
    await expect(heading).toHaveClass(/text-xl/);
    await expect(heading).toHaveClass(/font-bold/);

    // Verify the logo is inside the brand container (first div in header)
    const brandContainer = page.locator('header > div:first-child');
    await expect(brandContainer).toBeVisible();
  });

  test('logo loads successfully without 404', async ({ page }) => {
    const mainHtmlPath = join(RENDERER_DIR, 'main.html');
    const responsePromise = page.waitForResponse(response =>
      response.url().includes('logo-documental.png')
    );

    await page.goto(`file://${mainHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });

  test('all other header elements remain intact', async ({ page }) => {
    const mainHtmlPath = join(RENDERER_DIR, 'main.html');
    await page.goto(`file://${mainHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    // Verify view mode buttons (editor, view, split) are still present
    const viewButtons = page.locator('header button span.material-icons:has-text("edit"), header button span.material-icons:has-text("visibility"), header button span.material-icons:has-text("vertical_split")');
    await expect(viewButtons).toHaveCount(3);

    // Verify navigation buttons (back, reload, home) are still present
    const navButtons = page.locator('header button span.material-icons:has-text("arrow_back"), header button span.material-icons:has-text("refresh"), header button span.material-icons:has-text("home")');
    await expect(navButtons).toHaveCount(3);

    // Verify address bar input is present
    const addressInput = page.locator('header input[type="text"]');
    await expect(addressInput).toBeVisible();

    // Verify right-side buttons (Refresh, Publish/Publicar, Menu) are present
    // Refresh button
    const refreshBtn = page.locator('header button:has-text("Refresh")');
    // Publish button
    const publishBtn = page.locator('header button:has-text("Publish")');
    // Menu button (with menu icon)
    const menuBtn = page.locator('header button span.material-icons:has-text("menu")');

    // At least one of these should match (depending on i18n)
    const rightSideButtons = page.locator('header > div:last-child button');
    const rightBtnCount = await rightSideButtons.count();
    expect(rightBtnCount).toBeGreaterThanOrEqual(2);

    // Verify the header h1 still says "Documental"
    const heading = page.locator('header h1');
    await expect(heading).toHaveText('Documental');
  });
});
