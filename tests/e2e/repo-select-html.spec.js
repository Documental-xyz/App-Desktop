import { test, expect } from '@playwright/test';

test.describe('repo-select.html - SVG Logo and Zoom Controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:8765/repo-select.html');
    await page.waitForLoadState('networkidle');
    // Wait for Alpine to initialize
    await page.waitForFunction(() => window.Alpine !== undefined);
  });

  test('should render SVG logo in top-left branding (static check)', async ({ page }) => {
    const topLeftLogo = page.locator('div[style*="position:fixed"][style*="top:clamp"] div[x-html]');
    await expect(topLeftLogo).toBeAttached();
    
    const xhtmlContent = await topLeftLogo.getAttribute('x-html');
    expect(xhtmlContent).toContain('renderLogoSVG');
    expect(xhtmlContent).toContain("size: 'lg'");
    
    const pngLogo = page.locator('img[src*="logo-documental.png"]');
    await expect(pngLogo).toHaveCount(0);
  });

  test('should render SVG logo in header page-logo (static check)', async ({ page }) => {
    // Find the script that injects the logo into #page-logo
    const scripts = page.locator('script');
    const scriptContents = await scripts.allTextContents();
    const logoScript = scriptContents.find(s => s.includes('page-logo') && s.includes('renderLogoSVG'));
    expect(logoScript).toBeDefined();
    expect(logoScript).toContain("size: 'md'");
  });

  test('should have zoom controls markup left of theme selector', async ({ page }) => {
    // Check zoom controls container exists
    const zoomControlsContainer = page.locator('.theme-picker .inline-flex.items-center.gap-1');
    await expect(zoomControlsContainer).toBeAttached();
    
    // Check for zoom buttons by their icon content
    const zoomOutBtn = page.locator('.theme-picker button:has(span.material-symbols-outlined:text-is("zoom_out"))');
    const zoomInBtn = page.locator('.theme-picker button:has(span.material-symbols-outlined:text-is("zoom_in"))');
    const zoomResetBtn = page.locator('.theme-picker button:has(span.material-symbols-outlined:text-is("zoom_out_map"))');
    const zoomLevelDisplay = page.locator('.theme-picker span[x-text*="zoomLevel"]');
    
    await expect(zoomOutBtn).toBeAttached();
    await expect(zoomInBtn).toBeAttached();
    await expect(zoomResetBtn).toBeAttached();
    await expect(zoomLevelDisplay).toBeAttached();
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
    
    const scripts = page.locator('script');
    const scriptContents = await scripts.allTextContents();
    const logoScript = scriptContents.find(s => s.includes('page-logo') && s.includes('renderLogoSVG'));
    expect(logoScript).toBeDefined();
  });

  test('should have zoom methods defined in Alpine component', async ({ page }) => {
    // Check the Alpine component definition in the script
    const scripts = page.locator('script');
    const scriptContents = await scripts.allTextContents();
    const alpineScript = scriptContents.find(s => s.includes("Alpine.data('repoSelect'"));
    expect(alpineScript).toBeDefined();
    expect(alpineScript).toContain('zoomLevel');
    expect(alpineScript).toContain('zoomIn');
    expect(alpineScript).toContain('zoomOut');
    expect(alpineScript).toContain('resetZoom');
    expect(alpineScript).toContain('initZoom');
    expect(alpineScript).toContain('applyZoom');
  });
});