'use strict';

/**
 * @fileoverview Visual-consistency specs for the 9 Documental screens
 * (index, welcome, language, open, all-projects, repo-select, create, new,
 * config — main.html intentionally excluded: no zoom.js, BrowserView host).
 *
 * Two layers:
 * - @smoke: 100% zoom, 1280×720, short fixture — the fast per-task gate.
 *   Screenshot ALWAYS saved to .omo/evidence/<screen>-100pct-short.png.
 * - full matrix (no tag): screen × zoom {50..200, step 25} × viewport
 *   {1280×720, 1920×1080, 900×600} × fixture {short, long}. Screenshots on
 *   failure. Run via Task 13; ~378 cells.
 *
 * IMPORTANT (baseline semantics): the screens are currently BROKEN (fixed
 * footers, 48px logos). Specs for the FIXED behavior therefore FAIL now —
 * that is the point of the before-state baseline. The harness itself (static
 * server, electronAPI stub, zoom reload, console monitoring) must NOT fail:
 * readiness problems surface as assertion failures with clear messages.
 *
 * Run:
 *   npx playwright test -c tests/e2e/visual/playwright.config.js --grep @smoke
 *
 * @author Documental Team
 * @since 1.0.0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const helpers = require('./helpers');
const stubs = require('./stubs');

/** Full-matrix axes (plan Task 2). 900×600 @200% is the harshest cell. */
const ZOOM_LEVELS = [50, 75, 100, 125, 150, 175, 200];
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 900, height: 600 }
];
const FIXTURES = ['short', 'long'];

/** @type {{server?: {baseUrl: string, close: () => Promise<void>}, translations?: object}} */
const state = {};

test.describe.configure({ mode: 'parallel' });

test.beforeAll(async () => {
  // Setup gate: regenerate theme-override.css (not in git!) + require
  // compiled.css. Throws with a clear message — never builds CSS itself.
  helpers.ensureBuildAssets();
  state.server = await helpers.startStaticServer(path.join(helpers.REPO_ROOT, 'renderer'));
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
      await helpers.saveScreenshot(page, helpers.EVIDENCE_DIR, `${name}-failure.png`);
    } catch (_e) {
      /* page may already be closed — best effort */
    }
  }
});

/**
 * Asserts (soft) that the page produced zero JS console errors / pageerrors —
 * first-class harness assertion: a missing stub method would throw pageerror
 * and invalidate every geometry measurement.
 *
 * Screens may declare `expectedJsErrorPatterns` (see helpers.js SCREENS) for
 * KNOWN, DOCUMENTED pageerrors that are OUT OF SCOPE to fix (e.g. welcome's
 * pre-existing init() auth race). Errors matching an expected pattern are
 * logged to `knownIssues` but do NOT fail the assertion. All other screens
 * leave the array empty → strict zero-error behavior unchanged.
 *
 * @param {ReturnType<typeof helpers.createConsoleMonitor>} monitor - Console monitor.
 * @param {string} screenId - Screen id for the failure message.
 * @param {helpers.SCREENS[0]} screen - Screen descriptor (for expectedJsErrorPatterns).
 * @returns {void}
 */
function assertZeroConsoleErrors(monitor, screenId, screen) {
  const patterns = (screen && screen.expectedJsErrorPatterns) || [];
  const knownIssues = [];
  const unexpected = monitor.jsErrors.filter((err) => {
    const isKnown = patterns.some((re) => re.test(err));
    if (isKnown) knownIssues.push(err);
    return !isKnown;
  });
  if (knownIssues.length) {
    // eslint-disable-next-line no-console
    console.log(`[${screenId}] knownIssues (documented, filtered):\n  - ${knownIssues.join('\n  - ')}`);
  }
  expect.soft(
    unexpected,
    `[${screenId}] zeroConsoleErrors — the electronAPI stub must cover every load-time call.\n${monitor.summary()}`
  ).toHaveLength(0);
}

/**
 * Runs the shared assertion battery for one screen cell.
 *
 * @param {object} args - Arguments.
 * @param {import('@playwright/test').Page} args.page - Playwright page.
 * @param {helpers.SCREENS[0]} args.screen - Screen descriptor.
 * @param {number} args.zoomPct - Zoom percent.
 * @param {'short'|'long'|'selection'} args.fixture - Fixture mode.
 * @param {string} args.cellLabel - Human label for assertion messages.
 * @param {boolean} args.smoke - Whether this is a @smoke cell.
 * @returns {Promise<void>}
 */
async function runVisualCell({ page, screen, zoomPct, fixture, cellLabel, smoke }) {
  const monitor = helpers.createConsoleMonitor(page);
  await helpers.openScreen(page, {
    baseUrl: state.server.baseUrl,
    file: screen.file,
    fixture,
    viewport: undefined, // viewport already set by the caller via test.use
    translations: state.translations
  });
  const ready = await helpers.setZoom(page, zoomPct);

  // @smoke screenshots are ALWAYS captured (baseline evidence), before any
  // assertion so a failing assertion can never lose the artifact.
  if (smoke) {
    await helpers.saveScreenshot(page, helpers.EVIDENCE_DIR, `${screen.id}-${zoomPct}pct-${fixture}.png`);
  }

  // --- Readiness (hard): without these, geometry measurements are invalid ---
  expect(ready.bodyExists, `[${cellLabel}] document.body must exist`).toBe(true);
  expect(ready.alpine, `[${cellLabel}] Alpine must initialize (window.Alpine defined)`).toBe(true);
  expect(
    ready.zoomApplied,
    `[${cellLabel}] zoom.js must apply body zoom via the sessionStorage restore path (body[style*="zoom"])`
  ).toBe(true);
  expect.soft(ready.fontsLoaded, `[${cellLabel}] document.fonts should settle before measuring`).toBe(true);

  // --- Console (soft): stub coverage is first-class ---
  assertZeroConsoleErrors(monitor, cellLabel, screen);

  // --- Geometry (soft): document ALL current-state failures per cell ---
  if (screen.footerSelector) {
    const footer = await helpers.footerFullWidthAndPinned(page, screen.footerSelector);
    if (!footer.present) {
      expect.soft(footer.present, `[${cellLabel}] footer must exist (${screen.footerSelector})`).toBe(true);
    } else {
      expect.soft(footer.visible, `[${cellLabel}] footer must be visible`).toBe(true);
      expect.soft(
        footer.fullWidth,
        `[${cellLabel}] footer must span full width: rect.width=${footer.width} vs clientWidth=${footer.docClientWidth} (±${helpers.FOOTER_TOLERANCE_PX}px)`
      ).toBe(true);
      expect.soft(
        footer.pinned,
        `[${cellLabel}] footer must be pinned to the bottom: rect.bottom=${footer.bottom} vs innerHeight=${footer.innerHeight} (±${helpers.FOOTER_TOLERANCE_PX}px)`
      ).toBe(true);
    }
  }

  const overflow = await helpers.noHorizontalOverflow(page);
  expect.soft(
    !overflow.hasOverflow,
    `[${cellLabel}] no horizontal page overflow: docScrollWidth=${overflow.docScrollWidth} vs docClientWidth=${overflow.docClientWidth}`
  ).toBe(true);

  if (screen.brandLogo) {
    const logo = await helpers.logoBoxConsistent(page, helpers.TARGET_LOGO_BOX_PX);
    expect.soft(logo.present, `[${cellLabel}] branding box must exist (.brand-logo-3x)`).toBe(true);
    if (logo.present) {
      expect.soft(logo.boxSizeOk, `[${cellLabel}] logo box must be ${helpers.TARGET_LOGO_BOX_PX}px square (±${helpers.LOGO_TOLERANCE_PX}px): got ${logo.boxWidth}×${logo.boxHeight}`).toBe(true);
      expect.soft(logo.innerFillsBox, `[${cellLabel}] logo svg/img must fill the branding box: inner=${logo.inner ? logo.inner.width + 'px' : 'none'} of box=${logo.boxWidth}px`).toBe(true);
    }
  }

  if (screen.scrollerSelector) {
    if (smoke && screen.smokeScrollbarExpectation !== undefined) {
      const scroller = await helpers.scrollbarIffOverflow(page, screen.scrollerSelector, screen.smokeScrollbarExpectation);
      expect.soft(scroller.present, `[${cellLabel}] scroller must exist (${screen.scrollerSelector})`).toBe(true);
      if (scroller.present) {
        expect.soft(
          scroller.matchesExpectation,
          `[${cellLabel}] scrollbar iff overflow: scrollHeight=${scroller.scrollHeight} vs clientHeight=${scroller.clientHeight}, expected overflow=${scroller.expectOverflow}`
        ).toBe(true);
      }
    }
    if (!smoke && fixture === 'long' && screen.longMustOverflow) {
      const scroller = await helpers.scrollbarIffOverflow(page, screen.scrollerSelector, true);
      expect.soft(scroller.present, `[${cellLabel}] scroller must exist (${screen.scrollerSelector})`).toBe(true);
      if (scroller.present) {
        expect.soft(
          scroller.matchesExpectation,
          `[${cellLabel}] fixture=long must overflow the scroller (fixture utility): scrollHeight=${scroller.scrollHeight} vs clientHeight=${scroller.clientHeight}`
        ).toBe(true);
      }
    }
  }
}

for (const screen of helpers.SCREENS) {
  // ------------------------------------------------------------------
  // @smoke — fast per-task gate: 100% zoom, 1280×720, short fixture.
  // ------------------------------------------------------------------
  test.describe(`${screen.id} smoke`, () => {
    test.use({ viewport: { width: 1280, height: 720 } });
    test(`@smoke ${screen.id} @100pct 1280x720 short`, async ({ page }) => {
      await runVisualCell({ page, screen, zoomPct: 100, fixture: 'short', cellLabel: `${screen.id} @100pct 1280x720 short`, smoke: true });
    });
  });

  // ------------------------------------------------------------------
  // Full matrix (Task 13). Includes the harshest cell (900×600 @200%).
  // ------------------------------------------------------------------
  test.describe(`${screen.id} matrix`, () => {
    for (const zoomPct of ZOOM_LEVELS) {
      for (const viewport of VIEWPORTS) {
        for (const fixture of FIXTURES) {
          const label = `${screen.id} @${zoomPct}pct ${viewport.width}x${viewport.height} ${fixture}`;
          test(`${label}`, async ({ page }) => {
            test.setTimeout(45_000);
            await page.setViewportSize(viewport);
            await runVisualCell({ page, screen, zoomPct, fixture, cellLabel: label, smoke: false });
          });
        }
      }
    }
  });
}
