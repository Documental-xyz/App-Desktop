/**
 * @vitest-environment node
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RENDERER_DIR = join(__dirname, '../renderer');

test.describe('All Projects Page - Fixed Top-Left Branding', () => {
  test('displays fixed top-left branding with logo and text', async ({ page }) => {
    const htmlPath = join(RENDERER_DIR, 'all-projects.html');
    await page.goto(`file://${htmlPath}`);

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
    const htmlPath = join(RENDERER_DIR, 'all-projects.html');
    const responsePromise = page.waitForResponse(response =>
      response.url().includes('logo-documental.png')
    );

    await page.goto(`file://${htmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });

  test('centered logo-host SVG and heading not removed or modified', async ({ page }) => {
    const htmlPath = join(RENDERER_DIR, 'all-projects.html');
    await page.goto(`file://${htmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    // Verify centered logo-host span still exists
    const logoHost = page.locator('#logo-host');
    await expect(logoHost).toBeVisible();

    // Verify "All Projects" heading still exists
    const heading = page.locator('h1[data-i18n="all_projects.title"]');
    await expect(heading).toBeVisible();
  });

  test('theme picker remains unchanged', async ({ page }) => {
    const htmlPath = join(RENDERER_DIR, 'all-projects.html');
    await page.goto(`file://${htmlPath}`);
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

  test('project list and page structure remain intact', async ({ page }) => {
    const htmlPath = join(RENDERER_DIR, 'all-projects.html');
    await page.goto(`file://${htmlPath}`);
    await page.waitForLoadState('domcontentloaded');

    // Project list container exists
    const projectContainer = page.locator('#all-projects-container');
    await expect(projectContainer).toBeVisible();

    // Subtitle exists
    const subtitle = page.locator('p[data-i18n="all_projects.subtitle"]');
    await expect(subtitle).toBeVisible();

    // Back button exists
    const backBtn = page.locator('button.btn-back');
    await expect(backBtn).toBeVisible();
  });
});
