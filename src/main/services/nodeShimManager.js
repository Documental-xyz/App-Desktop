/**
 * nodeShimManager — generates node/npm/npx shims in a writable userData directory.
 *
 * The shims point to the app binary (Electron) run with ELECTRON_RUN_AS_NODE=1,
 * so child processes spawned by npm lifecycle scripts resolve `node` from PATH.
 * Shims live in `<userData>/node-shims/` (never next to execPath: AppImage mounts
 * are read-only and ephemeral). Consumers prepend getShimsDir() to PATH.
 */

const fs = require('fs');
const path = require('path');

const MARKER_FILE = '.shim-meta.json';
const SHIMS_DIR_NAME = 'node-shims';
const SHIM_VERSION = 1;

/**
 * Get default app binary path. Works when required from plain node (tests):
 * process.execPath is the electron binary in packaged apps and dev (electron runner).
 * @returns {string}
 */
function defaultAppPath() {
  return process.execPath;
}

/**
 * Get default userData path from the Electron app object when available.
 * @returns {string|undefined}
 */
function defaultUserDataPath() {
  try {
    // Lazy require: must work when required from plain node (tests, scripts)
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch {
    // Not running inside Electron
  }
  return undefined;
}

/**
 * Resolve bundled npm/npx cli paths via embeddedRuntimeService when available.
 * Lazy require so this still works outside Electron or when the service is absent.
 * @returns {{npmCliPath: string|undefined, npxCliPath: string|undefined}}
 */
function defaultNpmCliPaths() {
  const paths = { npmCliPath: undefined, npxCliPath: undefined };
  let svc;
  try {
    const { EmbeddedRuntimeService } = require('./embeddedRuntimeService');
    svc = new EmbeddedRuntimeService();
  } catch {
    return paths;
  }
  // A shim needs a .js CLI script to pass after the app binary. If the descriptor
  // execs something else directly (non-.js CUSTOM_NPM_PATH), there is nothing to shim.
  const cliPathFrom = (descriptor) => (
    descriptor && descriptor.command === process.execPath && descriptor.args.length
      ? descriptor.args[0]
      : undefined
  );
  try {
    paths.npmCliPath = cliPathFrom(svc.getNpmExecutable());
  } catch { /* npm CLI not resolvable */ }
  try {
    paths.npxCliPath = cliPathFrom(svc.getNpxExecutable());
  } catch { /* npx CLI not resolvable */ }
  return paths;
}

/**
 * Build the marker content describing the current shim generation.
 * @private
 */
function buildMarker({ platform, appPath, npmCliPath, npxCliPath }) {
  return `${JSON.stringify({ v: SHIM_VERSION, platform, appPath, npmCliPath, npxCliPath })}\n`;
}

/**
 * Get the shims directory path for a given userData (PATH prepending is done by consumers).
 * @param {string} [userDataPath] - Defaults to Electron app userData; required outside Electron.
 * @returns {string}
 */
function getShimsDir(userDataPath) {
  const userData = userDataPath || defaultUserDataPath();
  if (!userData) {
    throw new Error('getShimsDir: userDataPath required outside Electron');
  }
  return path.join(userData, SHIMS_DIR_NAME);
}

/**
 * Unix shim: POSIX /bin/sh script. All paths double-quoted (spaces/non-ASCII safe).
 * ELECTRON_RUN_AS_NODE propagates to grandchildren, so npm→npm recursion works.
 * @private
 */
function unixShim(appPath, cliPath) {
  const target = cliPath ? `"${appPath}" "${cliPath}" "$@"` : `"${appPath}" "$@"`;
  return `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${target}\n`;
}

/**
 * Windows .cmd shim. Paths double-quoted; %* forwards all args.
 * @private
 */
function windowsShim(appPath, cliPath) {
  const target = cliPath ? `"${appPath}" "${cliPath}" %*` : `"${appPath}" %*`;
  return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n${target}\r\n`;
}

/**
 * Atomically write a file: write to tmp in the same dir, then rename over the target.
 * Rename is atomic on POSIX and Windows same-volume, making concurrent ensureShims()
 * calls race-safe (last writer wins with identical content).
 * @private
 */
function atomicWrite(filePath, content, executable) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, executable ? { mode: 0o755 } : {});
  if (executable) {
    fs.chmodSync(tmp, 0o755);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Ensure shims exist and are up to date. Idempotent: if the marker file matches the
 * current configuration (app binary path, npm cli paths, platform, version), nothing
 * is rewritten. If the embedded binary path changed (e.g. AppImage mount), shims are
 * regenerated.
 * @param {object} [options]
 * @param {string} [options.userDataPath] - Writable userData dir (defaults to Electron app).
 * @param {string} [options.appPath] - App binary to exec (defaults to process.execPath).
 * @param {string} [options.npmCliPath] - Bundled npm-cli.js path (defaults to embeddedRuntimeService resolution).
 * @param {string} [options.npxCliPath] - Bundled npx-cli.js path (defaults to embeddedRuntimeService resolution).
 * @returns {Promise<string>} The shims directory path.
 */
async function ensureShims(options = {}) {
  const userDataPath = options.userDataPath || defaultUserDataPath();
  if (!userDataPath) {
    throw new Error('ensureShims: userDataPath required outside Electron');
  }
  const platform = process.platform;
  const appPath = options.appPath || defaultAppPath();
  const defaults = defaultNpmCliPaths();
  const npmCliPath = 'npmCliPath' in options ? options.npmCliPath : defaults.npmCliPath;
  const npxCliPath = 'npxCliPath' in options ? options.npxCliPath : defaults.npxCliPath;

  const shimsDir = getShimsDir(userDataPath);
  const markerPath = path.join(shimsDir, MARKER_FILE);
  const marker = buildMarker({ platform, appPath, npmCliPath, npxCliPath });

  try {
    if (fs.readFileSync(markerPath, 'utf8') === marker) {
      return shimsDir;
    }
  } catch {
    // Missing/corrupt marker: regenerate
  }

  fs.mkdirSync(shimsDir, { recursive: true });

  const isWindows = platform === 'win32';
  const makeShim = isWindows ? windowsShim : unixShim;
  const ext = isWindows ? '.cmd' : '';
  const shims = { [`node${ext}`]: makeShim(appPath) };
  if (npmCliPath) {
    shims[`npm${ext}`] = makeShim(appPath, npmCliPath);
  }
  if (npxCliPath) {
    shims[`npx${ext}`] = makeShim(appPath, npxCliPath);
  }

  for (const [name, content] of Object.entries(shims)) {
    atomicWrite(path.join(shimsDir, name), content, !isWindows);
  }
  atomicWrite(markerPath, marker, false);

  return shimsDir;
}

module.exports = { ensureShims, getShimsDir };
