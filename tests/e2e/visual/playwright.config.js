'use strict';

/**
 * @fileoverview Playwright config for the visual-consistency harness.
 * Scoped to tests/e2e/visual ONLY (the root playwright.config.js is NOT
 * touched — run with: `npx playwright test -c tests/e2e/visual/playwright.config.js`).
 * Artifacts are kept inside git-ignored .omo/evidence/.
 *
 * @author Documental Team
 * @since 1.0.0
 */

const { defineConfig } = require('@playwright/test');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

module.exports = defineConfig({
  testDir: __dirname,
  fullyParallel: true,
  outputDir: path.join(REPO_ROOT, '.omo', 'evidence', 'pw-artifacts'),
  reporter: [['list'], ['line']],
  use: {
    headless: true,
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 720 }
  },
  expect: {
    timeout: 5000
  }
});
