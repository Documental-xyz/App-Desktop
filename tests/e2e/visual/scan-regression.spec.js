'use strict';

/**
 * @fileoverview Regression locks for the repo-select scan loading race
 * (plan: repo-select-loading-fix, Task 8).
 *
 * Four committed specs, driven entirely through the stub-param URL
 * parametrization from tests/e2e/visual/stubs.js (Task 4) — NO test hooks
 * exist in renderer/ production code:
 *
 * 1. Spinner persistence (?stubScanDelayMs=2000) — the scanning spinner
 *    must stay visible at t≈500ms and t≈1000ms, and the list must appear
 *    only after the 2s scan resolves, WITH Documental badges applied.
 * 2. Error screen composition (?stubScanFail=1) — a failing scan renders
 *    the error block with BOTH actions: "Tentar novamente"
 *    (data-i18n="common.try_again") and "Criar novo repositório"
 *    (data-i18n="repo_select.button_create_repo"). The harness loads pt-BR
 *    translations, so the translated texts are asserted too.
 * 3. THE race regression (?stubScanDelayMs=16000, > the OLD 15s
 *    Promise.race timeout — the exact user-reported scenario): the spinner
 *    is still visible at t≈8s, and once the 16s scan completes, the list
 *    renders WITH badges. Against the pre-fix renderer the 15s race
 *    silently discards the 16s result (all repos untagged → empty state,
 *    zero badges), so this spec FAILS on the old code — the lock genuinely
 *    locks. Runs in a SERIAL describe with an elevated timeout so the
 *    timing holds under parallel workers.
 * 4. Legitimate empty state — zero Documental repos with the filter on is
 *    correct UX, NOT an error: the empty state renders (not the error
 *    block) with its two buttons. The zero-Documental scan is forced by a
 *    second page.addInitScript wrapper installed AFTER the main stub
 *    (order preserved) — stubs.js itself is NOT modified.
 *
 * Run:
 *   npx playwright test -c tests/e2e/visual/playwright.config.js tests/e2e/visual
 *
 * Vitest note: vitest's include pattern also globs the tests tree for spec
 * files and cannot collect Playwright specs (the pre-existing visual.spec.js
 * already fails in the suite baseline for exactly this reason). This file
 * guards on process.env.VITEST so the vitest run registers a passing no-op
 * instead of a NEW failure; the Playwright runner executes the real specs.
 *
 * @author Documental Team
 * @since 1.0.0
 */

const path = require('path');

if (process.env.VITEST) {
  // Collected by vitest's tests/** glob — Playwright-only file, no-op here.
  describe('scan-regression (Playwright-only spec)', () => {
    it('is executed by the Playwright visual harness, not vitest', () => {
      /* intentional no-op — keeps the vitest failure set unchanged */
    });
  });
} else {
  const { test, expect } = require('@playwright/test');
  const helpers = require('./helpers');
  const stubs = require('./stubs');

  /** Verified selectors (Task 6 evidence — repo-select.html x-show gates).
   * The list-section expression also lives on the page footer (same Alpine
   * gate), so it is scoped to its <div> to stay strict-mode-unique. */
  const SCANNING_SELECTOR = '[x-show="scanning"]';
  const LIST_SELECTOR = 'div[x-show="!loading && !scanning && !error"]';
  const ERROR_SELECTOR = '[x-show="error && !loading && !scanning"]';
  const EMPTY_SELECTOR = '[x-show="repos.length === 0 || filteredRepos.length === 0"]';
  const BADGE_SELECTOR = '.badge-primary';

  /** @type {{server?: {baseUrl: string, close: () => Promise<void>}, translations?: object}} */
  const state = {};

  /**
   * Navigates to repo-select.html with the electronAPI stub installed before
   * any page script and with extra stub params appended to the query string
   * (the stub init script re-reads window.location.search on every load —
   * see stubs.js stubParam). Mirrors helpers.openScreen conventions.
   *
   * @param {import('@playwright/test').Page} page - Playwright page.
   * @param {string} extraQuery - Query fragment starting with '&' (e.g. '&stubScanDelayMs=2000').
   * @returns {Promise<void>}
   */
  async function openRepoSelect(page, extraQuery) {
    await page.addInitScript({ content: stubs.buildElectronApiInitScript(state.translations) });
    await page.goto(`${state.server.baseUrl}/repo-select.html?fixture=selection${extraQuery}`, {
      waitUntil: 'load'
    });
  }

  // Serial mode: the four specs share timing invariants and the 16s spec
  // must not compete with parallel workers for CPU mid-flight.
  test.describe.serial('repo-select scan regression locks', () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test.beforeAll(async () => {
      helpers.ensureBuildAssets();
      state.server = await helpers.startStaticServer(path.resolve(__dirname, '..', '..', '..', 'renderer'));
      state.translations = stubs.loadTranslations();
    });

    test.afterAll(async () => {
      if (state.server) await state.server.close();
    });

    test.afterEach(async ({ page }, testInfo) => {
      if (testInfo.status !== testInfo.expectedStatus) {
        const name = testInfo.title
          .replace(/[^a-z0-9]+/gi, '-')
          .replace(/^-+|-+$/g, '')
          .toLowerCase();
        try {
          await helpers.saveScreenshot(page, helpers.EVIDENCE_DIR, `task-8-${name}-failure.png`);
        } catch (_e) {
          /* page may already be closed — best effort */
        }
      }
    });

    test('scan spinner persists through slow 2s scan and badges apply', async ({ page }) => {
      test.setTimeout(30_000);
      const navStart = Date.now();
      await openRepoSelect(page, '&stubScanDelayMs=2000');

      const spinner = page.locator(SCANNING_SELECTOR);
      await page.waitForTimeout(500);
      await expect(spinner, 'spinner must be visible at t≈500ms (2s scan still in flight)').toBeVisible();
      await page.waitForTimeout(500);
      await expect(spinner, 'spinner must STILL be visible at t≈1000ms (scan is 2000ms)').toBeVisible();

      const list = page.locator(LIST_SELECTOR);
      await list.waitFor({ state: 'visible', timeout: 15_000 });
      const elapsedMs = Date.now() - navStart;
      expect(elapsedMs, 'list must not appear before the 2s scan resolves').toBeGreaterThanOrEqual(2000);

      await expect(
        page.locator(BADGE_SELECTOR).first(),
        'Documental badges must be rendered once the list appears'
      ).toBeVisible();
    });

    test('error screen shows try again and create new buttons on scan failure', async ({ page }) => {
      test.setTimeout(30_000);
      await openRepoSelect(page, '&stubScanFail=1');

      const errorBlock = page.locator(ERROR_SELECTOR);
      await errorBlock.waitFor({ state: 'visible', timeout: 15_000 });
      await expect(errorBlock, 'the stub scan failure message must surface').toContainText('stub scan failure');

      const tryAgain = errorBlock.locator('[data-i18n="common.try_again"]');
      await expect(tryAgain, 'error state must have a Try Again button').toBeVisible();
      await expect(tryAgain, 'Try Again label must be translated (pt-BR harness locale)').toContainText(
        'Tentar novamente'
      );

      const createNew = errorBlock.locator('[data-i18n="repo_select.button_create_repo"]');
      await expect(createNew, 'error state must have a Create New Repository button').toBeVisible();
      await expect(createNew, 'Create New label must be translated (pt-BR harness locale)').toContainText(
        'Criar novo repositório'
      );
    });

    test('race regression 16s delay beats old 15s timeout and badges survive', async ({ page }) => {
      test.setTimeout(60_000);
      await openRepoSelect(page, '&stubScanDelayMs=16000');

      // t≈8s: the 16s scan is mid-flight (old race timeout was 15s, not yet
      // reached) — loading must persist. True on the fixed AND the old code;
      // pins the loading contract mid-flight.
      const spinner = page.locator(SCANNING_SELECTOR);
      await page.waitForTimeout(8_000);
      await expect(spinner, 'spinner must still be visible at t≈8s (16s scan in flight)').toBeVisible();

      // The discriminator: the 16s result must NOT be discarded. The old
      // code's 15s Promise.race resolved null → all repos untagged → empty
      // state with ZERO badges, so this assertion FAILS on the old renderer.
      const list = page.locator(LIST_SELECTOR);
      await list.waitFor({ state: 'visible', timeout: 25_000 });
      await expect(
        page.locator(BADGE_SELECTOR).first(),
        'Documental badges must be present after the 16s scan (race result NOT discarded)'
      ).toBeVisible({ timeout: 10_000 });
    });

    test('empty state zero documental is not error and keeps both buttons', async ({ page }) => {
      test.setTimeout(30_000);
      // Zero-Documental stubbing WITHOUT editing stubs.js (Task 7 owns it):
      // a second init script, registered AFTER the main stub (addInitScript
      // order is preserved), wraps findDocumentalRepos to resolve an empty
      // documentalRepos array once the main stub has installed electronAPI.
      await page.addInitScript({ content: stubs.buildElectronApiInitScript(state.translations) });
      await page.addInitScript(() => {
        if (window.electronAPI && typeof window.electronAPI.findDocumentalRepos === 'function') {
          window.electronAPI.findDocumentalRepos = function () {
            return Promise.resolve({ success: true, documentalRepos: [] });
          };
        }
      });
      await page.goto(`${state.server.baseUrl}/repo-select.html?fixture=selection`, { waitUntil: 'load' });

      const list = page.locator(LIST_SELECTOR);
      await list.waitFor({ state: 'visible', timeout: 15_000 });

      // Alpine x-show hides asynchronously — retrying visibility assertions.
      const errorBlock = page.locator(ERROR_SELECTOR);
      await expect(errorBlock, 'zero Documental repos is a legitimate empty state, NOT an error').toBeHidden();

      const empty = page.locator(EMPTY_SELECTOR);
      await expect(empty, 'empty state must be visible when the Documental filter matches nothing').toBeVisible();

      const retryButton = empty.locator('button', { hasText: 'Tentar novamente' });
      await expect(retryButton, 'empty state keeps its Try Again button').toBeVisible();
      const createButton = empty.locator('button', { hasText: 'Criar novo repositório' });
      await expect(createButton, 'empty state keeps its Create New Repository button').toBeVisible();

      await expect(
        page.locator(BADGE_SELECTOR),
        'no badges expected when the scan finds zero Documental repos'
      ).toHaveCount(0);
    });
  });
}
