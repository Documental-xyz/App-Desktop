/**
 * @fileoverview e2e: dynamic app version in page titles and the About modal (D4).
 * Stubs window.electronAPI (getAppVersion → package.json version, real en.yaml
 * translations) — same addInitScript approach as the visual harness stub — then
 * asserts document.title carries the ` v{version}` suffix on main.html and
 * index.html, and the About modal renders `Documental {version}`.
 * @author Documental Team
 * @since 1.0.0
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const RENDERER_DIR = path.join(ROOT, 'renderer');
const EVIDENCE_DIR = path.join(ROOT, '.omo', 'evidence');

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function loadEnTranslations() {
  const yaml = require('js-yaml');
  return yaml.load(fs.readFileSync(path.join(ROOT, 'src', 'locales', 'en.yaml'), 'utf8')) || {};
}

async function installElectronApiStub(page) {
  const translations = loadEnTranslations();
  await page.addInitScript(({ version, en }) => {
    const base = {
      getAppVersion: () => Promise.resolve(version),
      getAppLocale: () => Promise.resolve('en'),
      getAppLocaleSync: () => 'en',
      getTranslations: () => Promise.resolve(en),
      getTranslationsSync: () => en
    };
    window.electronAPI = new Proxy(base, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'string' && prop.startsWith('on')) {
          return () => () => {};
        }
        return () => Promise.resolve({ success: true });
      }
    });
  }, { version: VERSION, en: translations });
}

test.describe('dynamic app version display', () => {
  test.beforeEach(async ({ page }) => {
    await installElectronApiStub(page);
  });

  test('main.html document.title ends with v{version}', async ({ page }) => {
    await page.goto(`file://${path.join(RENDERER_DIR, 'main.html')}`);
    await page.waitForLoadState('domcontentloaded');

    await expect
      .poll(() => page.title(), { timeout: 5000 })
      .toBe(`Documental v${VERSION}`);

    const title = await page.title();
    expect(title.endsWith(` v${VERSION}`)).toBe(true);
  });

  test('index.html document.title ends with v{version}', async ({ page }) => {
    await page.goto(`file://${path.join(RENDERER_DIR, 'index.html')}`);
    await page.waitForLoadState('domcontentloaded');

    // index.page_title = "Documental - Select Workspace"
    await expect
      .poll(() => page.title(), { timeout: 5000 })
      .toBe(`Documental - Select Workspace v${VERSION}`);

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-6-title-e2e.png') });
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'task-6-title-e2e.txt'),
      `index.html document.title = "${await page.title()}"\n` +
        `main.html document.title    = "Documental v${VERSION}" (asserted in sibling test)\n` +
        `package.json version        = "${VERSION}"\n`
    );
  });

  test('About modal shows Documental {version} from app.getVersion()', async ({ page }) => {
    await page.goto(`file://${path.join(RENDERER_DIR, 'main.html')}`);
    await page.waitForLoadState('domcontentloaded');

    // Wait for Alpine init to fetch the version before opening the modal
    await page.waitForFunction(
      () => document.querySelector('p[x-text*="about_version"]') !== null,
      { timeout: 5000 }
    );

    await page.click('button:has(span.material-icons:text-is("menu"))');
    await page.click('a:has(span.material-icons:text-is("info_outline"))');

    const modal = page.locator('div[x-show="aboutModalOpen"]');
    await expect(modal).toBeVisible();

    const versionLine = modal.locator('p[x-text*="about_version"]');
    await expect(versionLine).toHaveText(`Documental ${VERSION}`, { timeout: 5000 });

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-6-about-modal.png') });
  });
});
