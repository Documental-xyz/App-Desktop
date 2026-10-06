'use strict';

/**
 * @fileoverview Scoped Playwright config for the menu→modal resilience
 * spec ONLY (container-friendly: --no-sandbox launch arg). Runs main.html
 * through the visual harness infra. Run:
 *   npx playwright test -c tests/e2e/visual/menu-modal.playwright.config.js
 */

const { defineConfig } = require('@playwright/test');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /menu-modal-resilience\.spec\.js/,
  outputDir: path.join(REPO_ROOT, '.omo', 'evidence', 'pw-artifacts'),
  reporter: [['list']],
  use: {
    headless: true,
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] }
  },
  expect: { timeout: 5000 }
});
