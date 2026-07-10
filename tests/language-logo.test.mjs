/**
 * @vitest-environment node
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RENDERER_DIR = join(__dirname, '../renderer');

test.describe('Language Page - Hero Logo', () => {
  test('displays Documental logo PNG with border, rounded corners, and shadow', async ({ page }) => {
    const languageHtmlPath = join(RENDERER_DIR, 'language.html');
    await page.goto(`file://${languageHtmlPath}`);

    // Wait for the page to load
    await page.waitForLoadState('domcontentloaded');

    // Find the logo image
    const logoImg = page.locator('.app-logo-hero');
    await expect(logoImg).toBeVisible();

    // Verify it's an image with the correct source
    await expect(logoImg).toHaveAttribute('src', './assets/img/logo-documental.png');
    await expect(logoImg).toHaveAttribute('alt', 'Documental');

    // Verify the app-logo-hero class is applied
    await expect(logoImg).toHaveClass(/app-logo-hero/);

    // Verify computed styles for border, rounded corners, and shadow
    const styles = await logoImg.evaluate(el => {
      const computed = window.getComputedStyle(el);
      return {
        borderRadius: computed.borderRadius,
        borderWidth: computed.borderWidth,
        borderColor: computed.borderColor,
        boxShadow: computed.boxShadow,
        width: computed.width,
        height: computed.height,
      };
    });

    // Check rounded corners (16px = 1rem)
    expect(styles.borderRadius).toBe('16px');

    // Check border exists (2px)
    expect(styles.borderWidth).toBe('2px');

    // Check box shadow exists
    expect(styles.boxShadow).not.toBe('none');
    expect(styles.boxShadow).not.toBe('');

    // Check dimensions (80px)
    expect(styles.width).toBe('80px');
    expect(styles.height).toBe('80px');

    // Verify the logo container has mb-8 spacing
    const logoContainer = page.locator('.anim-logo');
    await expect(logoContainer).toHaveClass(/mb-8/);

    // Verify the h1 "Documental" heading is still present
    const heading = page.locator('h1:has-text("Documental")');
    await expect(heading).toBeVisible();
    await expect(heading).toHaveClass(/text-3xl/);
    await expect(heading).toHaveClass(/font-black/);

    // Verify language cards are still present
    const langCards = page.locator('.lang-card');
    await expect(langCards).toHaveCount(3);
  });

  test('logo loads successfully without 404', async ({ page }) => {
    const languageHtmlPath = join(RENDERER_DIR, 'language.html');
    const responsePromise = page.waitForResponse(response => 
      response.url().includes('logo-documental.png')
    );
    
    await page.goto(`file://${languageHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');
    
    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });
});