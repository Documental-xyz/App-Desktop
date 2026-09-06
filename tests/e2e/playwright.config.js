'use strict';

/**
 * @fileoverview Playwright config for the Electron E2E specs that live
 * directly under tests/e2e (excludes tests/e2e/visual — that folder has its
 * own scoped config). Run with:
 *   npx playwright test tests/e2e/close-project-ghost.spec.js --config=tests/e2e/playwright.config.js
 * These specs launch the real Electron app via _electron — no browser
 * download is needed, but a display (or xvfb-run) is.
 * @author Documental Team
 * @since 1.0.0
 */

const { defineConfig } = require('@playwright/test');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

module.exports = defineConfig({
  testDir: __dirname,
  testIgnore: /visual/, // visual/ has its own playwright.config.js
  fullyParallel: false,
  workers: 1, // one Electron app instance at a time
  timeout: 120000,
  outputDir: path.join(REPO_ROOT, '.omo', 'evidence', 'pw-artifacts'),
  reporter: [['list']],
  use: {
    trace: 'off'
  }
});
