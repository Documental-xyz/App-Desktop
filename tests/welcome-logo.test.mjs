/**
 * @vitest-environment node
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RENDERER_DIR = join(__dirname, '../renderer');

test.describe('Welcome Page - Hero Logo (Step 1)', () => {
  test('displays Documental logo PNG with border, rounded corners, and shadow in Step 1', async ({ page }) => {
    const welcomeHtmlPath = join(RENDERER_DIR, 'welcome.html');
    await page.goto(`file://${welcomeHtmlPath}`);

    // Wait for the page to load and Alpine.js to initialize
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => window.Alpine !== undefined);

    // Find the logo image in Step 1 (currentStep === 1)
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

    // Verify the logo container has anim-logo class for animation
    const logoContainer = page.locator('.anim-logo');
    await expect(logoContainer).toBeVisible();

    // Verify the h1 title is still present (uses i18n, so check for any h1 in step 1)
    const heading = page.locator('[x-show="currentStep === 1"] h1');
    await expect(heading).toBeVisible();

    // Verify step cards are still present (3 cards)
    const stepCards = page.locator('[x-show="currentStep === 1"] .bg-surface-dark.rounded-lg.p-6.text-center');
    await expect(stepCards).toHaveCount(3);

    // Verify progress bar uses welcome-gradient class (not removed)
    const progressBar = page.locator('.welcome-gradient');
    await expect(progressBar.first()).toBeAttached();
  });

  test('logo loads successfully without 404', async ({ page }) => {
    const welcomeHtmlPath = join(RENDERER_DIR, 'welcome.html');
    const responsePromise = page.waitForResponse(response => 
      response.url().includes('logo-documental.png')
    );
    
    await page.goto(`file://${welcomeHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');
    
    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });

  test('Step 2 and Step 3 do not use the hero logo (they keep their original icons)', async ({ page }) => {
    const welcomeHtmlPath = join(RENDERER_DIR, 'welcome.html');
    await page.goto(`file://${welcomeHtmlPath}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => window.Alpine !== undefined);

    // Step 1 should have the hero logo
    const step1Logo = page.locator('[x-show="currentStep === 1"] .app-logo-hero');
    await expect(step1Logo).toBeVisible();

    // Step 2 should have GitHub SVG icon (not hero logo)
    // Check the step 2 content directly without navigation (since auth flow is complex)
    // Use first() to handle multiple elements with same x-show
    const step2Content = page.locator('[x-show="currentStep === 2"]').first();
    await expect(step2Content).toBeAttached();
    
    // Step 2 has an SVG icon (GitHub logo)
    const step2Svg = page.locator('[x-show="currentStep === 2"] svg').first();
    await expect(step2Svg).toBeAttached();
    
    // Step 2 should NOT have the hero logo
    const step2HeroLogo = page.locator('[x-show="currentStep === 2"] .app-logo-hero');
    await expect(step2HeroLogo).toHaveCount(0);

    // Step 3 should have cloud_download material icon (not hero logo)
    const step3Content = page.locator('[x-show="currentStep === 3"]').first();
    await expect(step3Content).toBeAttached();
    
    // Step 3 has a material-symbols-outlined with cloud_download
    const step3Icon = page.locator('[x-show="currentStep === 3"] .material-symbols-outlined:has-text("cloud_download")').first();
    await expect(step3Icon).toBeAttached();
    
    // Step 3 should NOT have the hero logo
    const step3HeroLogo = page.locator('[x-show="currentStep === 3"] .app-logo-hero');
    await expect(step3HeroLogo).toHaveCount(0);
  });
});