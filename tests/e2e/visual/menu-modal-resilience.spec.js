'use strict';

/**
 * @fileoverview Menu → modal resilience regression (publish/update dead
 * buttons follow-up): after using a MENU ITEM (e.g. "Limpar cache"), the
 * Publicar/Atualizar buttons must still open their modals — real clicks,
 * no Alpine state mutation. Runs main.html through the visual harness's
 * static server + electronAPI stub (BrowserViews don't exist here; the
 * overlay IPC resolves via the stub's Proxy fallback).
 *
 * Run: npx playwright test tests/e2e/visual/menu-modal-resilience.spec.js \
 *        -c tests/e2e/visual/playwright.config.js
 */

const { test, expect } = require('@playwright/test');
const stubs = require('./stubs');
const helpers = require('./helpers');

const MENU_TOGGLE = 'header button:has(span.material-icons:text-is("menu"))';
const MENU_DROPDOWN = 'div[x-show="menuOpen"]';
const CLEAR_CACHE_ITEM = `${MENU_DROPDOWN} a:has(span.material-icons:text-is("delete_sweep"))`;
const CLEAR_CACHE_MODAL = 'div[x-show="clearCacheModalOpen"]';
const PUBLISH_MODAL = 'div[x-show="publishSetupModalOpen"]';
const REFRESH_MODAL = 'div[x-show="refreshConfirmModalOpen"]';
const PUBLISH_BTN = 'header button.bg-primary';
const REFRESH_BTN = 'header button.bg-accent-orange';

test.describe('menu → modal resilience (main.html)', () => {
  let server;

  test.beforeAll(async () => {
    server = await helpers.startStaticServer(
      require('path').join(helpers.REPO_ROOT, 'renderer')
    );
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  /**
   * Open main.html with the stub and wait for the Alpine component to be
   * live and past the initial loading state (12s fallback forces it even
   * without BrowserView events).
   */
  async function openMain(page) {
    await page.addInitScript({ content: stubs.buildElectronApiInitScript({}) });
    await page.goto(`${server.baseUrl}/main.html?fixture=short`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => {
        if (typeof window.Alpine === 'undefined') return false;
        const el = document.querySelector('[x-data]');
        if (!el || !window.Alpine.$data) return false;
        const data = window.Alpine.$data(el);
        return Boolean(data && data.initialLoading === false);
      },
      null,
      { timeout: 20000, polling: 'raf' }
    );
  }

  test('cancel Limpar cache, then Publicar and Atualizar still open their modals', async ({ page }) => {
    const monitor = helpers.createConsoleMonitor(page);
    await openMain(page);

    // 1. Open the menu, click the "Limpar cache" item.
    await page.click(MENU_TOGGLE);
    await expect(page.locator(MENU_DROPDOWN)).toBeVisible();
    await page.click(CLEAR_CACHE_ITEM);
    await expect(page.locator(CLEAR_CACHE_MODAL)).toBeVisible({ timeout: 3000 });

    // 2. Cancel the clear-cache modal.
    await page.click(`${CLEAR_CACHE_MODAL} button.bg-surface-secondary`);
    await expect(page.locator(CLEAR_CACHE_MODAL)).toBeHidden({ timeout: 3000 });

    // 3. Publicar must still open its modal.
    await page.click(PUBLISH_BTN);
    await expect(page.locator(PUBLISH_MODAL)).toBeVisible({ timeout: 3000 });

    // 4. Close it, then Atualizar must still open its modal.
    await page.keyboard.press('Escape');
    await expect(page.locator(PUBLISH_MODAL)).toBeHidden({ timeout: 3000 });
    await page.click(REFRESH_BTN);
    await expect(page.locator(REFRESH_MODAL)).toBeVisible({ timeout: 3000 });

    const jsErrors = monitor.jsErrors.filter(
      (e) => !/Failed to load resource|favicon/i.test(e)
    );
    expect(jsErrors, monitor.summary()).toEqual([]);
  });

  test('confirm Limpar cache (stub reload), then Publicar still opens', async ({ page }) => {
    const monitor = helpers.createConsoleMonitor(page);
    await openMain(page);

    await page.click(MENU_TOGGLE);
    await page.click(CLEAR_CACHE_ITEM);
    await expect(page.locator(CLEAR_CACHE_MODAL)).toBeVisible({ timeout: 3000 });

    // Confirm — stub clearBrowserCache resolves {success:true} → the page
    // reloads views through stubbed IPC (Proxy fallback) and re-arms the
    // loading state; the 12s fallback clears it.
    await page.click(`${CLEAR_CACHE_MODAL} button.bg-red-600`);
    await expect(page.locator(CLEAR_CACHE_MODAL)).toBeHidden({ timeout: 3000 });

    await page.click(PUBLISH_BTN);
    await expect(page.locator(PUBLISH_MODAL)).toBeVisible({ timeout: 3000 });

    const jsErrors = monitor.jsErrors.filter(
      (e) => !/Failed to load resource|favicon/i.test(e)
    );
    expect(jsErrors, monitor.summary()).toEqual([]);
  });
});
