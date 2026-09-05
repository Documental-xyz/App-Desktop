'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolves the application version from the app's own package.json.
 *
 * `app.getVersion()` falls back to the ELECTRON executable version when it
 * cannot locate the application's package.json (observed in packaged builds:
 * title showed "v42.3.3" — the bundled Electron — instead of the app version).
 * Reading package.json explicitly via fs is transparent to asar archives and
 * works identically in development and packaged modes.
 * @param {Electron.App} electronApp - The Electron app instance
 * @returns {string} Semver string from package.json, or app.getVersion() as fallback
 */
function resolveAppVersion(electronApp) {
  try {
    const pkgPath = path.join(electronApp.getAppPath(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg && typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version.trim())) {
      return pkg.version.trim();
    }
  } catch (_e) {
    // package.json missing/unreadable/invalid — fall through to app.getVersion()
  }
  return electronApp.getVersion();
}

module.exports = { resolveAppVersion };
