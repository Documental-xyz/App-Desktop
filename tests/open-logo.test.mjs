/**
 * @vitest-environment node
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RENDERER_DIR = join(__dirname, '../renderer');

test.describe('Open Page - Fixed Top-Left Branding', () => {
  test('displays fixed top-left branding with logo and text', async ({ page }) => {
    const openHtmlPath = join(RENDERER_DIR, 'open.html');
    await page.goto(`file://${openHtmlPath}`);

    await page.waitForLoadState('domcontentloaded');

    // Find the fixed branding div
    const branding = page.locator('.branding-fixed');
    await expect(branding).toBeVisible();

    // Verify the logo image
    const logo = branding.locator('img');
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('src', './assets/img/logo-documental.png');
    await expect(logo).toHaveAttribute('alt', 'Documental');

    // Verify the "Documental" text span
    const text = branding.locator('span');
    await expect(text).toBeVisible();
    await expect(text).toHaveText('Documental');

    // Verify fixed positioning (top-left)
    await expect(branding).toHaveCSS('position', 'fixed');
    await expect(branding).toHaveCSS('top', '16px'); // 1rem
    await expect(branding).toHaveCSS('left', '16px'); // 1rem
    await expect(branding).toHaveCSS('z-index', '50');
  });

  test('logo loads successfully without 404', async ({ page }) => {
    const openHtmlPath = join(RENDERER_DIR, 'open.html');
    const responsePromise = page.waitForResponse(response =>
      response.url().includes('logo-documental.png')
    );

    await page.goto(`file://${openHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });

  test('centered page-logo SVG is not removed or modified', async ({ page }) => {
    const openHtmlPath = join(RENDERER_DIR, 'open.html');
    await page.goto(`file://${openHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    // Verify centered page-logo span still exists
    const pageLogo = page.locator('#page-logo');
    await expect(pageLogo).toBeVisible();

    // Verify the "Open Workspace" heading still exists
    const heading = page.locator('h1[x-text="__t(\'open.title\')"]');
    await expect(heading).toBeVisible();
  });

  test('theme picker remains unchanged', async ({ page }) => {
    const openHtmlPath = join(RENDERER_DIR, 'open.html');
    await page.goto(`file://${openHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    // Theme picker still exists with all three buttons
    const themePicker = page.locator('.theme-picker');
    await expect(themePicker).toBeVisible();
    await expect(themePicker).toHaveCSS('position', 'fixed');
    await expect(themePicker).toHaveCSS('top', '16px');
    await expect(themePicker).toHaveCSS('right', '16px');

    // All three theme buttons present
    const autoBtn = page.locator('button[data-theme="auto"]');
    const darkBtn = page.locator('button[data-theme="dark"]');
    const lightBtn = page.locator('button[data-theme="light"]');
    await expect(autoBtn).toBeVisible();
    await expect(darkBtn).toBeVisible();
    await expect(lightBtn).toBeVisible();
  });

  test('step list and footer remain intact', async ({ page }) => {
    const openHtmlPath = join(RENDERER_DIR, 'open.html');
    await page.goto(`file://${openHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    // Step list container exists
    const stepContainer = page.locator('.bg-surface-dark.rounded-lg.p-4');
    await expect(stepContainer).toBeVisible();

    // Footer exists with cancel button (first bg-danger button in footer)
    const cancelBtn = page.locator('footer button.bg-danger');
    await expect(cancelBtn).toBeVisible();
  });
});
