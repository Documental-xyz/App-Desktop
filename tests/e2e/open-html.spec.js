import { test, expect } from '@playwright/test';

test.describe('open.html - SVG Logo and Zoom Controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:8765/open.html');
    await page.waitForLoadState('networkidle');
  });

  test('should render SVG logo in top-left branding (static check)', async ({ page }) => {
    const topLeftLogo = page.locator('div[style*="position:fixed"][style*="top:clamp"] div[x-html]');
    await expect(topLeftLogo).toBeVisible();
    
    const xhtmlContent = await topLeftLogo.getAttribute('x-html');
    expect(xhtmlContent).toContain('renderLogoSVG');
    expect(xhtmlContent).toContain("size: 'lg'");
    
    const pngLogo = page.locator('img[src*="logo-documental.png"]');
    await expect(pngLogo).toHaveCount(0);
  });

  test('should render SVG logo in header page-logo (static check)', async ({ page }) => {
    const pageLogoScript = page.locator('#page-logo + script');
    const scriptContent = await pageLogoScript.textContent();
    expect(scriptContent).toContain('renderLogoSVG');
    expect(scriptContent).toContain("size: 'md'");
  });

  test('should have zoom controls markup left of theme selector', async ({ page }) => {
    // Check zoom controls container exists
    const zoomControlsContainer = page.locator('.theme-picker .inline-flex.items-center.gap-1');
    await expect(zoomControlsContainer).toBeVisible();
    
    // Check for zoom buttons by their icon content
    const zoomOutBtn = page.locator('.theme-picker button:has(span.material-symbols-outlined:text-is("zoom_out"))');
    const zoomInBtn = page.locator('.theme-picker button:has(span.material-symbols-outlined:text-is("zoom_in"))');
    const zoomResetBtn = page.locator('.theme-picker button:has(span.material-symbols-outlined:text-is("zoom_out_map"))');
    const zoomLevelDisplay = page.locator('.theme-picker span[x-text*="zoomLevel"]');
    
    await expect(zoomOutBtn).toBeVisible();
    await expect(zoomInBtn).toBeVisible();
    await expect(zoomResetBtn).toBeVisible();
    await expect(zoomLevelDisplay).toBeVisible();
  });

  test('should have theme selector with three buttons', async ({ page }) => {
    const themeAuto = page.locator('button.theme-btn[data-theme="auto"]');
    const themeDark = page.locator('button.theme-btn[data-theme="dark"]');
    const themeLight = page.locator('button.theme-btn[data-theme="light"]');
    
    await expect(themeAuto).toBeVisible();
    await expect(themeDark).toBeVisible();
    await expect(themeLight).toBeVisible();
  });

  test('should not have any PNG logo references in branding', async ({ page }) => {
    const pngLogos = page.locator('img[src*="logo-documental.png"]');
    await expect(pngLogos).toHaveCount(0);
  });

  test('should use renderLogoSVG for both branding locations', async ({ page }) => {
    const topLeftXhtml = page.locator('div[style*="position:fixed"][style*="top:clamp"] div[x-html]');
    const topLeftXhtmlContent = await topLeftXhtml.getAttribute('x-html');
    expect(topLeftXhtmlContent).toContain('renderLogoSVG');
    
    const pageLogoScript = page.locator('#page-logo + script');
    const scriptContent = await pageLogoScript.textContent();
    expect(scriptContent).toContain('renderLogoSVG');
  });

  test('should have zoom methods defined in x-data component', async ({ page }) => {
    const xDataElement = page.locator('[x-data]').first();
    const xDataContent = await xDataElement.getAttribute('x-data');
    expect(xDataContent).toContain('zoomLevel');
    expect(xDataContent).toContain('zoomIn');
    expect(xDataContent).toContain('zoomOut');
    expect(xDataContent).toContain('resetZoom');
    expect(xDataContent).toContain('initZoom');
    expect(xDataContent).toContain('applyZoom');
  });
});
