const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const RENDERER_DIR = path.resolve(__dirname, '../../renderer');
const EVIDENCE_DIR = path.resolve(__dirname, '../../.omo/evidence');

test.describe('index.html - SVG Logo and Zoom Controls', () => {
  test.beforeEach(async ({ page }) => {
    const filePath = path.resolve(RENDERER_DIR, 'index.html');
    await page.goto(`file://${filePath}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);
  });

  test('brand logo uses renderLogoSVG with xl size', async ({ page }) => {
    // Verify brand-logo container exists
    const brandLogo = page.locator('#brand-logo');
    await expect(brandLogo).toBeVisible();

    // Verify SVG logo is rendered (not material-symbols workspaces)
    const svg = brandLogo.locator('svg');
    await expect(svg).toBeVisible();
    await expect(svg).toHaveClass(/h-16/); // xl size = h-16 w-16
    await expect(svg).toHaveClass(/w-16/);

    // Verify no material-symbols workspaces icon
    const workspacesIcon = brandLogo.locator('.material-symbols-outlined:has-text("workspaces")');
    await expect(workspacesIcon).toHaveCount(0);

    // Verify centered heading still exists (check data-i18n attr since i18n may not run in test)
    const centerHeading = page.locator('#brand-logo h1');
    await expect(centerHeading).toBeVisible();
    await expect(centerHeading).toHaveAttribute('data-i18n', 'index.heading');
  });

  test('no fixed top-left branding exists', async ({ page }) => {
    // Verify no fixed-position branding div with logo image
    const fixedBranding = page.locator('div[style*="position:fixed"][style*="top:"][style*="left:"]');
    await expect(fixedBranding).toHaveCount(0);

    // Verify no logo-documental.png in branding
    const logoImg = page.locator('img[src="./assets/img/logo-documental.png"]');
    await expect(logoImg).toHaveCount(0);
  });

  test('zoom controls visible left of theme selector', async ({ page }) => {
    // Verify zoom controls container exists
    const zoomControls = page.locator('#zoom-controls');
    await expect(zoomControls).toBeVisible();

    // Verify zoom controls are inside theme-picker (left of theme selector)
    const themePicker = page.locator('.theme-picker');
    await expect(themePicker).toBeVisible();

    // Verify zoom control buttons
    const zoomOutBtn = page.locator('#zoom-out');
    const zoomInBtn = page.locator('#zoom-in');
    const zoomResetBtn = page.locator('#zoom-reset');
    const zoomLevel = page.locator('#zoom-level');

    await expect(zoomOutBtn).toBeVisible();
    await expect(zoomInBtn).toBeVisible();
    await expect(zoomResetBtn).toBeVisible();
    await expect(zoomLevel).toBeVisible();
    await expect(zoomLevel).toHaveText('100%');

    // Verify zoom buttons have correct icons
    await expect(zoomOutBtn.locator('.material-symbols-outlined')).toHaveText('zoom_out');
    await expect(zoomInBtn.locator('.material-symbols-outlined')).toHaveText('zoom_in');
    await expect(zoomResetBtn.locator('.material-symbols-outlined')).toHaveText('zoom_out_map');
  });

  test('zoom in increases level, persists to sessionStorage', async ({ page }) => {
    const zoomInBtn = page.locator('#zoom-in');
    const zoomLevel = page.locator('#zoom-level');

    // Click zoom in
    await zoomInBtn.click();
    await expect(zoomLevel).toHaveText('125%');

    // Verify sessionStorage persistence
    const stored = await page.evaluate(() => sessionStorage.getItem('zoom-level'));
    expect(stored).toBe('125');
  });

  test('zoom out decreases level', async ({ page }) => {
    const zoomInBtn = page.locator('#zoom-in');
    const zoomOutBtn = page.locator('#zoom-out');
    const zoomLevel = page.locator('#zoom-level');

    // First zoom in to 125%
    await zoomInBtn.click();
    await expect(zoomLevel).toHaveText('125%');

    // Then zoom out back to 100%
    await zoomOutBtn.click();
    await expect(zoomLevel).toHaveText('100%');
  });

  test('reset zoom returns to 100%', async ({ page }) => {
    const zoomInBtn = page.locator('#zoom-in');
    const zoomResetBtn = page.locator('#zoom-reset');
    const zoomLevel = page.locator('#zoom-level');

    // Zoom in twice to 150%
    await zoomInBtn.click();
    await zoomInBtn.click();
    await expect(zoomLevel).toHaveText('150%');

    // Reset zoom
    await zoomResetBtn.click();
    await expect(zoomLevel).toHaveText('100%');

    // Verify sessionStorage
    const stored = await page.evaluate(() => sessionStorage.getItem('zoom-level'));
    expect(stored).toBe('100');
  });

  test('zoom level persists across page reloads via sessionStorage', async ({ page }) => {
    const zoomInBtn = page.locator('#zoom-in');
    const zoomLevel = page.locator('#zoom-level');

    // Zoom in to 125%
    await zoomInBtn.click();
    await expect(zoomLevel).toHaveText('125%');

    // Reload page
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    // Verify zoom level persisted
    await expect(zoomLevel).toHaveText('125%');
  });

  test('min (50%) and max (200%) limits enforced', async ({ page }) => {
    const zoomOutBtn = page.locator('#zoom-out');
    const zoomInBtn = page.locator('#zoom-in');
    const zoomLevel = page.locator('#zoom-level');

    // Zoom out to minimum (50%) - from 100% need 2 clicks: 100->75->50
    await zoomOutBtn.click();
    await zoomOutBtn.click();
    await expect(zoomLevel).toHaveText('50%');
    await expect(zoomOutBtn).toBeDisabled();

    // Zoom in to maximum (200%) - from 50% need 6 clicks: 50->75->100->125->150->175->200
    for (let i = 0; i < 6; i++) {
      await zoomInBtn.click();
    }
    await expect(zoomLevel).toHaveText('200%');
    await expect(zoomInBtn).toBeDisabled();
  });

  test('theme selector with three buttons intact', async ({ page }) => {
    const themeAuto = page.locator('button.theme-btn[data-theme="auto"]');
    const themeDark = page.locator('button.theme-btn[data-theme="dark"]');
    const themeLight = page.locator('button.theme-btn[data-theme="light"]');

    await expect(themeAuto).toBeVisible();
    await expect(themeDark).toBeVisible();
    await expect(themeLight).toBeVisible();
  });

  test('action cards remain intact', async ({ page }) => {
    const createCard = page.locator('h2[data-i18n="index.create_new"]');
    const openCard = page.locator('h2[data-i18n="index.open_folder"]');
    const recentCard = page.locator('h2[data-i18n="index.open_recent"]');

    await expect(createCard).toBeVisible();
    await expect(openCard).toBeVisible();
    await expect(recentCard).toBeVisible();
  });
});

test.describe('index.html - Recent Workspaces path normalization', () => {
  test('recent card renders normalized path for NULL repoFolderName, never raw DB string', async ({ page }) => {
    const raw1 = 'C:/Users/Dev/Workspaces';
    const raw2 = 'C:/Users//Dev/../Dev/Workspaces';
    // path.join(raw, '') mirrors the renderer's PathUtils.join(projectPath, '')
    // and yields exactly what the real join-path IPC (fileService path.join)
    // returns on this host. Raw2 contains duplicate + dot-dot segments that
    // path.join provably rewrites on every host, so the raw string must not
    // survive into the DOM.
    const expected1 = path.join(raw1, '');
    const expected2 = path.join(raw2, '');

    const projects = [
      { id: 1, projectName: 'Docs WS', projectPath: raw1, repoFolderName: null, repoFullName: null },
      { id: 2, projectName: 'Unnormalized DB Row', projectPath: raw2, repoFolderName: null, repoFullName: null }
    ];
    // Fake joinPath keyed by the exact spread segments PathUtils forwards
    // (including the empty repoFolderName segment).
    const joinKey = (...segments) => segments.join('||');
    const joinExpectations = {
      [joinKey(raw1, '')]: expected1,
      [joinKey(raw2, '')]: expected2
    };

    await page.addInitScript(({ seededProjects, expectations }) => {
      window.electronAPI = {
        getRecentProjects: () => Promise.resolve(seededProjects),
        joinPath: (...segments) =>
          Promise.resolve(expectations[segments.join('||')]),
        normalizePath: (p) => Promise.resolve(p)
      };
    }, { seededProjects: projects, expectations: joinExpectations });

    const filePath = path.resolve(RENDERER_DIR, 'index.html');
    await page.goto(`file://${filePath}`);
    await page.waitForLoadState('domcontentloaded');

    const container = page.locator('#recent-projects-container');
    const card1 = container.locator('.recent-project-item[data-project-id="1"]');
    const card2 = container.locator('.recent-project-item[data-project-id="2"]');
    await expect(card1).toBeVisible();
    await expect(card2).toBeVisible();

    // Path <p> is the last <p> per card; its textContent is the "folder"
    // icon ligature followed by the rendered path.
    const readPathText = async (card) => {
      const text = await card.locator('p').last().textContent();
      return text.replace(/^folder/, '').trim();
    };

    const rendered1 = await readPathText(card1);
    expect(rendered1).toBe(expected1);

    const rendered2 = await readPathText(card2);
    expect(rendered2).toBe(expected2);
    if (expected2 !== raw2) {
      expect(rendered2).not.toBe(raw2);
    }

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'task-4-recent-normalized.png'),
      fullPage: true
    });
  });
});