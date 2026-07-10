/**
 * @vitest-environment node
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RENDERER_DIR = join(__dirname, '../renderer');

test.describe('Index Page - Fixed Top-Left Branding', () => {
  test('displays fixed top-left branding with logo and text', async ({ page }) => {
    const indexHtmlPath = join(RENDERER_DIR, 'index.html');
    await page.goto(`file://${indexHtmlPath}`);

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
    const indexHtmlPath = join(RENDERER_DIR, 'index.html');
    const responsePromise = page.waitForResponse(response =>
      response.url().includes('logo-documental.png')
    );

    await page.goto(`file://${indexHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });

  test('centered brand section is not removed or modified', async ({ page }) => {
    const indexHtmlPath = join(RENDERER_DIR, 'index.html');
    await page.goto(`file://${indexHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    // Verify centered brand-logo div still exists
    const brandLogo = page.locator('#brand-logo');
    await expect(brandLogo).toBeVisible();

    // Verify centered "Documental" heading still exists
    const centerHeading = page.locator('#brand-logo h1');
    await expect(centerHeading).toBeVisible();
    await expect(centerHeading).toHaveText('Documental');

    // Verify subtitle still present (using data-i18n attr since i18n replaces text content)
    const subtitle = page.locator('p[data-i18n="index.subtitle"]');
    await expect(subtitle).toBeVisible();
  });

  test('theme picker remains unchanged', async ({ page }) => {
    const indexHtmlPath = join(RENDERER_DIR, 'index.html');
    await page.goto(`file://${indexHtmlPath}`);
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

  test('action cards remain intact', async ({ page }) => {
    const indexHtmlPath = join(RENDERER_DIR, 'index.html');
    await page.goto(`file://${indexHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    // All three action cards present (use data-i18n attr since i18n replaces display text)
    const createCard = page.locator('h2[data-i18n="index.create_new"]');
    const openCard = page.locator('h2[data-i18n="index.open_folder"]');
    const recentCard = page.locator('h2[data-i18n="index.open_recent"]');
    await expect(createCard).toBeVisible();
    await expect(openCard).toBeVisible();
    await expect(recentCard).toBeVisible();
  });
});
