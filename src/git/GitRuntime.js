/**
 * GitRuntime — resolution of the bundled Git runtime with fatal semantics.
 *
 * Resolution order for the bundled Git directory:
 *  1. Production (extraResources): `<process.resourcesPath>/git`, falling back
 *     to `resources/git` relative to the application root.
 *  2. Development: `node_modules/dugite/git` via dugite's `resolveGitDir()`
 *     (single source of truth for the embedded Git location).
 *
 * The system PATH is NEVER consulted. If no bundled runtime is found, a fatal
 * `Error` with the exact message `Bundled Git runtime not found` is thrown —
 * there is no silent fallback to a system Git.
 *
 * NOTE (PRD §22): dugite overrides the `GIT_CONFIG_SYSTEM` environment
 * variable to point at its own embedded `etc/gitconfig` inside the bundled
 * runtime directory. Consumers spawning the bundled binary should use dugite's
 * `setupEnvironment()` (or set `GIT_CONFIG_SYSTEM` accordingly) so that
 * machine-level Git configuration comes from the bundled runtime, not from
 * `/etc/gitconfig` on the host.
 *
 * @module git/GitRuntime
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { resolveGitDir } = require('dugite');

/** Binary file name relative to the Git dir, per platform. */
const GIT_BINARIES = {
  win32: ['cmd/git.exe', 'bin/git.exe'],
  darwin: ['bin/git'],
  linux: ['bin/git'],
};

/**
 * Return the platform-relative candidate binary paths (most preferred first).
 *
 * @param {string} [platform=process.platform] Platform key (injectable for tests).
 * @returns {string[]} Relative binary paths within a Git dir.
 * @private
 */
function getCandidateBinaries(platform = process.platform) {
  return GIT_BINARIES[platform] || GIT_BINARIES.linux;
}

/**
 * Resolve the bundled Git binary path inside a candidate directory, or `null`
 * if no binary exists there.
 *
 * @param {string} dir Candidate Git directory.
 * @param {string} [platform=process.platform] Platform key (injectable for tests).
 * @returns {?string} Absolute path to the Git binary, or null.
 * @private
 */
function findBinaryInDir(dir, platform = process.platform) {
  for (const rel of getCandidateBinaries(platform)) {
    const bin = path.join(dir, ...rel.split('/'));
    try {
      if (fs.statSync(bin).isFile()) return bin;
    } catch {
      // candidate missing — try next
    }
  }
  return null;
}

/**
 * Build the production candidate directories (extraResources layout).
 *
 * @returns {string[]} Candidate dirs (may be empty when unknown).
 * @private
 */
function getProductionDirs() {
  const dirs = [];
  // Electron packaged app: <resources>/git (extraResources target).
  if (process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, 'git'));
  }
  // Fallback for non-Electron packaging: resources/git relative to app root.
  dirs.push(path.join(process.cwd(), 'resources', 'git'));
  return dirs;
}

/**
 * Resolve the bundled Git runtime directory.
 *
 * Fatal semantics: if none of the candidate directories contains a valid Git
 * binary, throws `Error('Bundled Git runtime not found')`. Never falls back
 * to the system PATH.
 *
 * @param {string[]} [overrideDirs] Optional explicit candidate directories
 *   (first match wins). Used by tests to simulate absence of the runtime
 *   without touching the filesystem.
 * @returns {string} Absolute path to the bundled Git directory.
 * @throws {Error} 'Bundled Git runtime not found' when no candidate holds a binary.
 */
function getGitDir(overrideDirs) {
  const candidates = Array.isArray(overrideDirs)
    ? overrideDirs
    : [...getProductionDirs(), resolveGitDir()];

  for (const dir of candidates) {
    if (dir && findBinaryInDir(dir)) return dir;
  }
  throw new Error('Bundled Git runtime not found');
}

/**
 * Resolve the absolute path of the bundled Git binary.
 *
 * Per-platform layout:
 *  - win32: `cmd/git.exe` preferred, `bin/git.exe` fallback
 *  - darwin/linux: `bin/git`
 *
 * @param {string[]} [overrideDirs] Optional candidate dirs (see {@link getGitDir}).
 * @returns {string} Absolute path to the Git binary.
 * @throws {Error} 'Bundled Git runtime not found' when no candidate holds a binary.
 */
function getGitBinaryPath(overrideDirs) {
  const dir = getGitDir(overrideDirs);
  return findBinaryInDir(dir);
}

/**
 * Execute the bundled binary with `--version` and return the raw version
 * string (e.g. `'git version 2.53.0'`).
 *
 * @param {string[]} [overrideDirs] Optional candidate dirs (see {@link getGitDir}).
 * @param {function(?Error, string): void} [callback] Node-style callback; when
 *   omitted a Promise is returned.
 * @returns {?Promise<string>} Version string, when called without a callback.
 */
function getBundledGitVersion(overrideDirs, callback) {
  const bin = getGitBinaryPath(overrideDirs);
  if (typeof callback === 'function') {
    execFile(bin, ['--version'], { timeout: 10000 }, (err, stdout) => {
      callback(err, err ? undefined : String(stdout).trim());
    });
    return null;
  }
  return new Promise((resolve, reject) => {
    execFile(bin, ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

/**
 * Non-fatal availability probe for diagnostics/preflight.
 *
 * @param {string[]} [overrideDirs] Optional candidate dirs (see {@link getGitDir}).
 * @returns {boolean} True when a bundled Git binary can be resolved.
 */
function isBundledGitAvailable(overrideDirs) {
  try {
    getGitDir(overrideDirs);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getGitDir,
  getGitBinaryPath,
  getBundledGitVersion,
  isBundledGitAvailable,
};
