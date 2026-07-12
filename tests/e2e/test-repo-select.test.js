const { test, expect } = require('@playwright/test');
const path = require('path');

const RENDERER_DIR = path.resolve(__dirname, '../../renderer');

test.describe('repo-select.html', () => {
  test('loads page and renders SVG logo', async ({ page }) => {
    const filePath = path.resolve(RENDERER_DIR, 'repo-select.html');
    await page.goto(`file://${filePath}`);
    
    // Wait for page to load
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    
    // Check that the page-logo contains SVG (not PNG)
    const pageLogo = page.locator('#page-logo');
    await expect(pageLogo).toBeVisible();
    
    // Verify SVG is rendered inside page-logo
    const svgInLogo = pageLogo.locator('svg');
    await expect(svgInLogo).toBeVisible();
    
    // Verify no PNG logo references in the header
    const pngImages = page.locator('img[src*="logo-documental.png"]');
    await expect(pngImages).toHaveCount(0);
    
    // Verify favicon PNG is still there (that's OK)
    const favicon = page.locator('link[rel="icon"][href*="icon-favicon.png"]');
    await expect(favicon).toHaveCount(1);
  });

  test('zoom controls are present and functional', async ({ page }) => {
    const filePath = path.resolve(RENDERER_DIR, 'repo-select.html');
    await page.goto(`file://${filePath}`);
    
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    
    // Check zoom controls exist
    const zoomOutBtn = page.locator('#zoom-out').first();
    const zoomInBtn = page.locator('#zoom-in').first();
    const resetZoomBtn = page.locator('#zoom-reset').first();
    const zoomLevelDisplay = page.locator('#zoom-level').first();
    
    await expect(zoomOutBtn).toBeVisible();
    await expect(zoomInBtn).toBeVisible();
    await expect(resetZoomBtn).toBeVisible();
    await expect(zoomLevelDisplay).toBeVisible();
    
    // Check initial zoom level is 100%
    await expect(zoomLevelDisplay).toContainText('100%');
    
    // Test zoom in
    await zoomInBtn.click();
    await page.waitForTimeout(100);
    await expect(zoomLevelDisplay).toContainText('125%');
    
    // Test zoom out
    await zoomOutBtn.click();
    await page.waitForTimeout(100);
    await expect(zoomLevelDisplay).toContainText('100%');
    
    // Test reset zoom
    await zoomInBtn.click();
    await zoomInBtn.click();
    await page.waitForTimeout(100);
    await expect(zoomLevelDisplay).toContainText('150%');
    
    await resetZoomBtn.click();
    await page.waitForTimeout(100);
    await expect(zoomLevelDisplay).toContainText('100%');
  });

  test('zoom controls are left of theme selector', async ({ page }) => {
    const filePath = path.resolve(RENDERER_DIR, 'repo-select.html');
    await page.goto(`file://${filePath}`);
    
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    
    // Get positions of zoom controls and theme selector
    const zoomControls = page.locator('#zoom-controls').first();
    const themeSelector = page.locator('.theme-picker-group').nth(1);
    
    const zoomBox = await zoomControls.boundingBox();
    const themeBox = await themeSelector.boundingBox();
    
    // Zoom controls should be to the left of theme selector
    expect(zoomBox.x + zoomBox.width).toBeLessThan(themeBox.x);
  });

  test('theme selector works', async ({ page }) => {
    const filePath = path.resolve(RENDERER_DIR, 'repo-select.html');
    await page.goto(`file://${filePath}`);
    
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    
    // Check theme buttons exist
    const autoBtn = page.locator('.theme-btn[data-theme="auto"]');
    const darkBtn = page.locator('.theme-btn[data-theme="dark"]');
    const lightBtn = page.locator('.theme-btn[data-theme="light"]');
    
    await expect(autoBtn).toBeVisible();
    await expect(darkBtn).toBeVisible();
    await expect(lightBtn).toBeVisible();
  });

  test('fixed branding uses SVG logo', async ({ page }) => {
    const filePath = path.resolve(RENDERER_DIR, 'repo-select.html');
    await page.goto(`file://${filePath}`);
    
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    
    // Check fixed branding has SVG
    const brandingLogo = page.locator('div[style*="position:fixed"] >> svg').first();
    await expect(brandingLogo).toBeVisible();
    
    // No PNG in fixed branding
    const pngInBranding = page.locator('div[style*="position:fixed"] >> img[src*="logo-documental.png"]');
    await expect(pngInBranding).toHaveCount(0);
  });
});