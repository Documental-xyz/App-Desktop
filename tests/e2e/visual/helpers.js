'use strict';

/**
 * @fileoverview Reusable helpers for the visual-consistency Playwright harness.
 * Provides: a zero-dependency static HTTP server for `renderer/` (Node `http`
 * module only), the setup gate (theme-override generation + compiled.css
 * presence check), console-error monitoring, app-readiness waits (Alpine +
 * body zoom + fonts), the real-path zoom driver (`sessionStorage` + reload),
 * and metric-based geometry assertion helpers (footer pinning, horizontal
 * overflow, scrollbar-iff-overflow, logo box consistency).
 *
 * Geometry checks are METRIC-based (getBoundingClientRect / scrollHeight vs
 * clientHeight ±1) — never visual inspection. Helpers return metric objects;
 * specs turn them into assertions with clear messages so current-state
 * breakage surfaces as assertion failures, not setup errors.
 *
 * @author Documental Team
 * @since 1.0.0
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

/** Repository root (tests/e2e/visual -> 3 levels up). */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Directory where screenshots / harness evidence are written (git-ignored). */
const EVIDENCE_DIR = path.join(REPO_ROOT, '.omo', 'evidence');

/** Directory holding the task-2 BEFORE-state baseline screenshots. */
const BASELINE_DIR = path.join(EVIDENCE_DIR, 'task-2-baseline');

/** Canonical logo box size in px once the branding normalization lands
 *  (plan candidate 160×160; see plan Task 1/Task 12). */
const TARGET_LOGO_BOX_PX = 160;

/** Preferred static-server port (falls back to +1..+11 on EADDRINUSE so
 *  parallel workers never collide). */
const PREFERRED_PORT = 4173;

/** Tolerances (plan-mandated — do NOT relax): footer ±1px, logo ±2px. */
const FOOTER_TOLERANCE_PX = 1;
const LOGO_TOLERANCE_PX = 2;

/**
 * The 9 screens under test (main.html intentionally excluded — it has no
 * zoom.js and hosts BrowserView panes, not reproducible via static serving).
 *
 * IMPORTANT (Wave 3 — post-conversion): every selector below targets the
 * POST-conversion markup (`.app-shell`/`.app-scroll`/`.app-footer`/
 * `.brand-logo-3x` foundation from Task 4, commit b381a7c). Until each Wave-3
 * screen task lands its conversion, `@smoke` for those screens FAILS on
 * selector-based assertions (element not found → present=false) — that is
 * EXPECTED and doubles as each screen task's gate. The harness itself
 * (server, stub, readiness, console monitoring) must never fail in setup.
 *
 * - `footerSelector`: footer element measured by footerFullWidthAndPinned
 *   (null = screen has no footer / footer is out of scope). Post-conversion
 *   footers carry the `.app-footer` class (stable — no more brittle
 *   `[style*="position:fixed"]` substring matches that Alpine x-show rewrites).
 * - `scrollerSelector`: the `.app-scroll` content scroller, when the screen
 *   has one.
 * - `brandLogo`: screen renders the top-left `[data-logo-fallback].brand-logo-3x`
 *   branding (welcome hides it on step 1 and uses an <img>, language has none).
 * - `longMustOverflow`: fixture=long is expected to make the scroller content
 *   exceed the scroller box at any matrix viewport (fixture-utility assertion).
 * - `smokeScrollbarExpectation`: scrollbarIffOverflow expectation valid for the
 *   @smoke cell (100% zoom, 1280×720, short fixture); undefined = skip.
 * - `expectedJsErrorPatterns`: regex literals for KNOWN, DOCUMENTED pageerrors
 *   this screen fires on EVERY load that are OUT OF SCOPE to fix (e.g.
 *   welcome's pre-existing init() auth race — see
 *   .omo/notepads/visual-consistency-fix/issues.md). The console assertion
 *   filters jsErrors through these before failing. All other screens leave the
 *   array empty → strict zero-error behavior unchanged.
 */
const SCREENS = [
  {
    id: 'index',
    file: 'index.html',
    footerSelector: null,
    scrollerSelector: '.app-scroll',
    brandLogo: true,
    longMustOverflow: true
  },
  {
    id: 'welcome',
    file: 'welcome.html',
    // Task 10 keeps the empty footer a <div> (aria-hidden) — converted to
    // .app-footer. The scroller div exists at L556 (flex-1 flex items-start
    // justify-center px-8 pb-4 overflow-y-auto) → .app-scroll.
    footerSelector: 'div.app-footer[aria-hidden="true"]',
    scrollerSelector: '.app-scroll',
    brandLogo: false, // branding hidden on step 1 (x-show currentStep !== 1)
    longMustOverflow: false,
    // DOCUMENTED pre-existing race (issues.md): init() does not return the
    // auth promise → Alpine dereferences userInfo.* under x-show before
    // resolution → these 5 pageerrors on EVERY load (production too). Exact
    // texts captured via the harness (5 per load; ~10 per @smoke cell after
    // the setZoom reload). Filtered here — NOT fixed (plan guardrail: no
    // behavioral JS changes). Follow-up recommended in the final summary.
    expectedJsErrorPatterns: [
      /^pageerror: Cannot read properties of null \(reading 'avatar_url'\)$/,
      /^pageerror: Cannot read properties of null \(reading 'name'\)$/,
      /^pageerror: Cannot read properties of null \(reading 'email'\)$/
    ]
  },
  {
    id: 'language',
    file: 'language.html',
    footerSelector: null,
    // Task 11 wraps main-content in the app frame → .app-scroll scroller.
    scrollerSelector: '.app-scroll',
    brandLogo: false,
    longMustOverflow: false
  },
  {
    id: 'open',
    file: 'open.html',
    footerSelector: 'footer.app-footer',
    scrollerSelector: '.app-scroll',
    brandLogo: true,
    longMustOverflow: false
  },
  {
    id: 'all-projects',
    file: 'all-projects.html',
    footerSelector: null,
    scrollerSelector: '.app-scroll',
    brandLogo: true,
    longMustOverflow: true,
    smokeScrollbarExpectation: false
  },
  {
    id: 'repo-select',
    file: 'repo-select.html',
    // x-show stays on the tag after conversion (conditional footer behavior
    // preserved — decisions.md); the class makes the selector stable.
    footerSelector: 'footer.app-footer[x-show]',
    scrollerSelector: '.app-scroll',
    brandLogo: true,
    longMustOverflow: true
  },
  {
    id: 'create',
    file: 'create.html',
    footerSelector: 'footer.app-footer',
    // Scroller div exists at L556 (flex-1 flex items-start justify-center
    // px-8 pb-4 overflow-y-auto) → .app-scroll.
    scrollerSelector: '.app-scroll',
    brandLogo: true,
    longMustOverflow: false
  },
  {
    id: 'new',
    file: 'new.html',
    footerSelector: 'footer.app-footer',
    // Scroller div exists at L390 → .app-scroll.
    scrollerSelector: '.app-scroll',
    brandLogo: true,
    longMustOverflow: false
  },
  {
    id: 'config',
    file: 'config.html',
    // Dual-pane layout — Task 12 keeps the pane classes; no single scroller
    // and no footer to measure.
    footerSelector: null,
    scrollerSelector: null,
    brandLogo: true, // note: config's markup is currently malformed (plan Task 3)
    longMustOverflow: false
  }
];

/** MIME map for the static server (pages load css/js/svg/png/woff2/fonts). */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

/**
 * Starts a static file server for `rootDir` on 127.0.0.1 using only Node's
 * built-in `http` module (zero new dependencies). Falls back to subsequent
 * ports when the preferred one is taken (parallel Playwright workers).
 *
 * @param {string} rootDir - Directory to serve (repo `renderer/`).
 * @param {number} [preferredPort=PREFERRED_PORT] - First port to try.
 * @param {number} [attempts=12] - How many consecutive ports to try.
 * @returns {Promise<{server: http.Server, port: number, baseUrl: string, close: () => Promise<void>}>}
 */
function startStaticServer(rootDir, preferredPort = PREFERRED_PORT, attempts = 12) {
  return new Promise((resolve, reject) => {
    const tryListen = (port, remaining) => {
      const server = http.createServer((req, res) => {
        handleStaticRequest(req, res, rootDir);
      });
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && remaining > 0) {
          tryListen(port + 1, remaining - 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        const close = () =>
          new Promise((resolveClose) => {
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            server.close(() => resolveClose());
          });
        resolve({ server, port, baseUrl: `http://127.0.0.1:${port}`, close });
      });
    };
    tryListen(preferredPort, attempts);
  });
}

/**
 * Serves one static request with correct MIME type and no caching.
 * Path-traversal safe (resolved path must stay inside rootDir).
 *
 * @param {http.IncomingMessage} req - Request.
 * @param {http.ServerResponse} res - Response.
 * @param {string} rootDir - Serve root.
 * @returns {void}
 */
function handleStaticRequest(req, res, rootDir) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch (_e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad request');
    return;
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const resolved = path.normalize(path.join(rootDir, urlPath));
  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`not found: ${urlPath}`);
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(resolved).pipe(res);
  });
}

/**
 * Setup gate for the visual spec (run in beforeAll):
 * 1. regenerates `renderer/assets/css/theme-override.css` (not in git; pages
 *    link it — without it every screenshot is invalid);
 * 2. asserts `renderer/assets/css/compiled.css` exists (fails with a clear
 *    message pointing at `npm run build:css`; the harness never builds CSS
 *    itself).
 *
 * @returns {void}
 * @throws {Error} with a clear, actionable message when the gate fails.
 */
function ensureBuildAssets() {
  const generator = path.join(REPO_ROOT, 'scripts', 'generate-theme-override.js');
  if (!fs.existsSync(generator)) {
    throw new Error(
      `[harness] theme generator missing: ${generator}. The visual harness cannot produce valid screenshots without it.`
    );
  }
  try {
    execFileSync('node', [generator], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (err) {
    throw new Error(
      `[harness] 'node scripts/generate-theme-override.js' failed (exit ${err.status}): ${String(
        err.stderr || err.message
      ).slice(0, 500)}`
    );
  }
  const themeOverride = path.join(REPO_ROOT, 'renderer', 'assets', 'css', 'theme-override.css');
  if (!fs.existsSync(themeOverride)) {
    throw new Error(
      `[harness] ${themeOverride} was not generated — screenshots would use a 404 stylesheet.`
    );
  }
  const compiled = path.join(REPO_ROOT, 'renderer', 'assets', 'css', 'compiled.css');
  if (!fs.existsSync(compiled)) {
    throw new Error(
      `[harness] ${compiled} is missing. Run 'npm run build:css' once, then re-run the visual spec. ` +
        '(The harness intentionally does not build CSS itself — task scope.)'
    );
  }
}

/**
 * Creates a console/pageerror monitor for a page. Classifies:
 * - `jsErrors`: pageerror events + console.error messages (the stub must keep
 *   these at zero — first-class harness assertion);
 * - `resourceErrors`: "Failed to load resource" console errors (recorded, but
 *   reported separately so a stray 404 does not mask real JS breakage).
 *
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @returns {{jsErrors: Array<string>, resourceErrors: Array<string>, summary: () => string}}
 */
function createConsoleMonitor(page) {
  const jsErrors = [];
  const resourceErrors = [];
  page.on('pageerror', (error) => {
    jsErrors.push(`pageerror: ${error.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/^Failed to load resource/i.test(text)) {
      resourceErrors.push(text);
    } else {
      jsErrors.push(`console.error: ${text}`);
    }
  });
  return {
    jsErrors,
    resourceErrors,
    summary() {
      const parts = [];
      if (jsErrors.length) parts.push(`JS errors:\n  - ${jsErrors.join('\n  - ')}`);
      if (resourceErrors.length) parts.push(`Resource errors:\n  - ${resourceErrors.join('\n  - ')}`);
      return parts.join('\n') || 'no console errors';
    }
  };
}

/**
 * Opens a screen with the electronAPI stub installed before any page script.
 * Registers the init script (persists across reloads), sets the viewport and
 * navigates with `?fixture=<mode>`.
 *
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @param {object} options - Options.
 * @param {string} options.baseUrl - Static server base URL.
 * @param {string} options.file - Screen file name (e.g. 'welcome.html').
 * @param {'short'|'long'|'selection'} options.fixture - Fixture mode.
 * @param {{width: number, height: number}} [options.viewport] - Optional viewport.
 * @param {object} [options.translations] - i18n dictionary for the stub.
 * @returns {Promise<void>}
 */
async function openScreen(page, options) {
  const { baseUrl, file, fixture, viewport, translations } = options;
  if (viewport) await page.setViewportSize(viewport);
  const stubs = require('./stubs');
  await page.addInitScript({ content: stubs.buildElectronApiInitScript(translations || {}) });
  await page.goto(`${baseUrl}/${file}?fixture=${fixture}`, { waitUntil: 'load' });
}

/**
 * Waits for the app to reach a measurable state: Alpine initialized
 * (window.Alpine), body zoom applied by zoom.js (body[style*="zoom"]) and
 * document.fonts settled. Never throws — returns readiness flags so specs
 * can report unmet conditions as assertion failures with clear messages
 * (current screens are intentionally broken; the harness must not fail
 * in setup).
 *
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @param {number} [timeoutMs=15000] - Max wait.
 * @returns {Promise<{alpine: boolean, zoomApplied: boolean, fontsLoaded: boolean, bodyExists: boolean}>}
 */
async function waitForAppReady(page, timeoutMs = 15000) {
  await page
    .waitForFunction(
      async () => {
        if (document.fonts && document.fonts.ready) {
          try {
            await document.fonts.ready;
          } catch (_e) {
            /* fonts.ready never rejects in practice */
          }
        }
        const style = document.body ? document.body.getAttribute('style') || '' : '';
        return typeof window.Alpine !== 'undefined' && /zoom\s*:/.test(style);
      },
      null,
      { timeout: timeoutMs, polling: 'raf' }
    )
    .catch(() => null);
  return page.evaluate(() => {
    const style = document.body ? document.body.getAttribute('style') || '' : '';
    return {
      alpine: typeof window.Alpine !== 'undefined',
      zoomApplied: /zoom\s*:/.test(style),
      fontsLoaded: Boolean(document.fonts && document.fonts.status === 'loaded'),
      bodyExists: Boolean(document.body)
    };
  });
}

/**
 * Drives the REAL app zoom path: persists 'zoom-level' in sessionStorage,
 * reloads (zoom.js restores it on init) and waits for readiness.
 * Exercise-by-reload is mandated by the plan — do not shortcut via
 * body.style.zoom assignment.
 *
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @param {number} pct - Zoom percent (50..200, steps of 25).
 * @returns {Promise<{alpine: boolean, zoomApplied: boolean, fontsLoaded: boolean, bodyExists: boolean}>}
 */
async function setZoom(page, pct) {
  await page.evaluate((value) => {
    sessionStorage.setItem('zoom-level', String(value));
  }, pct);
  await page.reload({ waitUntil: 'load' });
  return waitForAppReady(page);
}

/**
 * footerFullWidthAndPinned — metrics for the footer pinned/width contract:
 * rect.width == documentElement.clientWidth ±1 AND rect.bottom ==
 * window.innerHeight ±1 (plan acceptance criteria).
 *
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @param {string} selector - Footer selector.
 * @returns {Promise<object>} Metrics incl. `fullWidth`, `pinned` booleans and deltas.
 */
async function footerFullWidthAndPinned(page, selector) {
  return page.evaluate(
    (args) => {
      const el = document.querySelector(args.selector);
      if (!el) return { present: false, selector: args.selector };
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible =
        style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      const doc = document.documentElement;
      return {
        present: true,
        selector: args.selector,
        visible,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
        docClientWidth: doc.clientWidth,
        innerHeight: window.innerHeight,
        widthDelta: Math.abs(rect.width - doc.clientWidth),
        bottomDelta: Math.abs(rect.bottom - window.innerHeight),
        fullWidth: Math.abs(rect.width - doc.clientWidth) <= args.tolerance,
        pinned: Math.abs(rect.bottom - window.innerHeight) <= args.tolerance
      };
    },
    { selector, tolerance: FOOTER_TOLERANCE_PX }
  );
}

/**
 * noHorizontalOverflow — metrics for "page must not scroll horizontally":
 * documentElement.scrollWidth <= clientWidth + 1 (body checked too).
 *
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @returns {Promise<object>} Metrics incl. `hasOverflow` boolean.
 */
async function noHorizontalOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      bodyScrollWidth: body ? body.scrollWidth : 0,
      bodyClientWidth: body ? body.clientWidth : 0,
      hasOverflow: doc.scrollWidth > doc.clientWidth + 1 || (body && body.scrollWidth > body.clientWidth + 1)
    };
  });
}

/**
 * scrollbarIffOverflow — metric check that a scroller shows a scrollbar if
 * and only if its content overflows (scrollHeight vs clientHeight ±1).
 *
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @param {string} scrollerSelector - Scroller element selector.
 * @param {boolean} expectOverflow - Whether content is expected to overflow.
 * @returns {Promise<object>} Metrics incl. `hasScrollbar`, `matchesExpectation`.
 */
async function scrollbarIffOverflow(page, scrollerSelector, expectOverflow) {
  return page.evaluate(
    (args) => {
      const el = document.querySelector(args.selector);
      if (!el) return { present: false, selector: args.selector, expectOverflow: args.expectOverflow };
      const hasScrollbar = el.scrollHeight > el.clientHeight + 1;
      return {
        present: true,
        selector: args.selector,
        expectOverflow: args.expectOverflow,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        hasScrollbar,
        matchesExpectation: hasScrollbar === args.expectOverflow
      };
    },
    { selector: scrollerSelector, expectOverflow }
  );
}

/**
 * logoBoxConsistent — metrics for the canonical branding box: the
 * `[data-logo-fallback].brand-logo-3x` box must be square at `expectedPx`
 * (±2) and its inner svg/img must fill it (>= 90%). Current state (48px SVG
 * inside a 144px box) intentionally fails — that is the baseline.
 *
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @param {number} expectedPx - Canonical box size (TARGET_LOGO_BOX_PX).
 * @param {string} [selector='.brand-logo-3x'] - Branding box selector.
 * @returns {Promise<object>} Metrics incl. `boxSizeOk`, `innerFillsBox`, `pass`.
 */
async function logoBoxConsistent(page, expectedPx, selector = '.brand-logo-3x') {
  return page.evaluate(
    (args) => {
      const el = document.querySelector(args.selector);
      if (!el) return { present: false, selector: args.selector, expectedPx: args.expectedPx };
      const box = el.getBoundingClientRect();
      const inner = el.querySelector('svg, img');
      let innerInfo = null;
      if (inner) {
        const r = inner.getBoundingClientRect();
        innerInfo = {
          tag: inner.tagName.toLowerCase(),
          width: r.width,
          height: r.height,
          fillRatio: box.width > 0 ? r.width / box.width : 0
        };
      }
      const boxDeltaW = Math.abs(box.width - args.expectedPx);
      const boxDeltaH = Math.abs(box.height - args.expectedPx);
      const boxSizeOk =
        boxDeltaW <= args.tolerance &&
        boxDeltaH <= args.tolerance &&
        Math.abs(box.width - box.height) <= args.tolerance;
      const innerFillsBox = Boolean(innerInfo && innerInfo.fillRatio >= 0.9);
      return {
        present: true,
        selector: args.selector,
        expectedPx: args.expectedPx,
        visible: box.width > 0 && box.height > 0,
        boxWidth: box.width,
        boxHeight: box.height,
        boxDeltaW,
        boxDeltaH,
        boxSizeOk,
        inner: innerInfo,
        innerFillsBox,
        pass: boxSizeOk && innerFillsBox
      };
    },
    { selector, expectedPx, tolerance: LOGO_TOLERANCE_PX }
  );
}

/**
 * Saves a viewport screenshot (deviceScaleFactor: 1) under the evidence dir.
 *
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @param {string} dir - Target directory (created when missing).
 * @param {string} name - File name (e.g. 'welcome-100pct-short.png').
 * @returns {Promise<string>} Absolute path of the written file.
 */
async function saveScreenshot(page, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await page.screenshot({ path: filePath });
  return filePath;
}

module.exports = {
  REPO_ROOT,
  EVIDENCE_DIR,
  BASELINE_DIR,
  TARGET_LOGO_BOX_PX,
  PREFERRED_PORT,
  FOOTER_TOLERANCE_PX,
  LOGO_TOLERANCE_PX,
  SCREENS,
  MIME_TYPES,
  startStaticServer,
  handleStaticRequest,
  ensureBuildAssets,
  createConsoleMonitor,
  openScreen,
  waitForAppReady,
  setZoom,
  footerFullWidthAndPinned,
  noHorizontalOverflow,
  scrollbarIffOverflow,
  logoBoxConsistent,
  saveScreenshot
};
