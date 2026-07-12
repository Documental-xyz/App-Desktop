const { test, expect } = require('@playwright/test');
const path = require('path');

test('main.html loads without hero logo branding', async ({ page }) => {
  const filePath = path.resolve(__dirname, '../../renderer/main.html');
  await page.goto(`file://${filePath}`);
  
  // Wait for page to load
  await page.waitForLoadState('domcontentloaded');
  
  // Check that the fixed-position hero branding div is NOT present
  const heroBranding = page.locator('div[style*="position:fixed"][style*="top:clamp"]');
  await expect(heroBranding).toHaveCount(0);
  
  // Check that the top-bar branding in header IS present
  const topBarLogo = page.locator('header img[src="./assets/img/logo-documental.svg"]');
  await expect(topBarLogo).toHaveCount(1);
  
  const topBarTitle = page.locator('header h1:has-text("Documental")');
  await expect(topBarTitle).toHaveCount(1);
  
  // Verify no other logo-documental.svg references outside header
  const allLogos = page.locator('img[src="./assets/img/logo-documental.svg"]');
  await expect(allLogos).toHaveCount(1);
  
  console.log('✅ Test passed: Hero logo removed, top-bar branding retained');
});