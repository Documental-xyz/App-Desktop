/**
 * @fileoverview Platform-aware app icon resolution for BrowserWindow windows
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const path = require('path');
const { app } = require('electron');

/**
 * Returns the app icon path for the current platform.
 *
 * - win32  → assets/icon.ico (ICO recommended by Electron for best quality)
 * - linux  → assets/icon.png
 * - darwin → undefined (BrowserWindow `icon` is ignored on macOS; the dock
 *   uses the bundled .icns)
 *
 * Resolves correctly in dev (repo root) and packaged builds (asar) because
 * `app.getAppPath()` returns the repo root in development and `app.asar`
 * when packaged, and Electron resolves asar paths transparently.
 *
 * @returns {string|undefined} Absolute icon path, or undefined on darwin
 */
function getAppIcon() {
  if (process.platform === 'darwin') return undefined;
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return path.join(app.getAppPath(), 'assets', iconName);
}

module.exports = { getAppIcon };
