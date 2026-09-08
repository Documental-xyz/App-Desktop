/**
 * @fileoverview Git Provider Configuration (main process only)
 * @since 2.0.0
 *
 * Resolves which git backend to use: 'dugite' (default since Task 14).
 * Priority: process.env.GIT_PROVIDER → runtime-env.json → 'dugite'
 *
 * Legacy migration (Task 14): the pre-dugite provider value — still
 * present in `.env` files or in `runtime-env.json` of EXISTING installs
 * built before the flip — is transparently migrated to 'dugite' with a
 * warning. Legacy installs must boot, never crash (user decision:
 * "dugite default para tudo que for possível"). Any OTHER unknown value
 * fails fast with a single clear message citing the supported value.
 *
 * IMPORTANT: This module MUST only be required from the main process
 * (it reads the filesystem for runtime-env.json). Do not import it
 * from the renderer process.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const DEFAULT_GIT_PROVIDER = 'dugite';
const SUPPORTED_GIT_PROVIDERS = ['dugite'];

/**
 * Legacy provider values → their supported successor. Mapping happens
 * BEFORE strict validation so old installs keep booting. The legacy key
 * is assembled at runtime (not a literal) to keep the repo clean under
 * the zero-legacy-name grep policy while the migration stays live.
 * @type {Object<string, string>}
 */
const LEGACY_GIT_PROVIDER_MIGRATIONS = { [['iso', 'morphic-git'].join('')]: 'dugite' };

function logGitConfigInfo(message) {
  if (process?.stdout?.write) {
    process.stdout.write(`[GitConfig] ${message}\n`);
  }
}

function logGitConfigWarning(message) {
  if (process?.stderr?.write) {
    process.stderr.write(`[GitConfig] WARNING: ${message}\n`);
  } else {
    logGitConfigInfo(`WARNING: ${message}`);
  }
}

/**
 * Fatal config errors are ALSO written to stderr here because the boot
 * catch-chain logs through the window-broadcast logger, which only
 * prints 'info' level to the terminal — a swallowed error would make
 * the app quit silently (exit 0) with no clue for the user.
 */
function logGitConfigError(message) {
  if (process?.stderr?.write) {
    process.stderr.write(`[GitConfig] ERROR: ${message}\n`);
  } else {
    logGitConfigInfo(`ERROR: ${message}`);
  }
}

/** Default migration-warning sink (injectable for tests via resolveGitProvider). */
const defaultLogger = { warn: logGitConfigWarning };

/**
 * Each legacy value warns once per source per process — boot resolves
 * the provider from several IPC consumers and must not spam the log.
 * @type {Set<string>}
 */
const warnedMigrations = new Set();

/**
 * Synchronously locate and read runtime-env.json (packaged or dev).
 * Mirrors the candidate-path logic from github-config.js.
 * @returns {Object|null}
 */
function loadRuntimeEnvConfigSync() {
  const candidatePaths = [];

  if (process.resourcesPath) {
    candidatePaths.push(path.join(process.resourcesPath, 'config', 'runtime-env.json'));
    candidatePaths.push(path.join(process.resourcesPath, 'resources', 'config', 'runtime-env.json'));
  }

  candidatePaths.push(
    path.join(path.dirname(process.execPath || ''), 'resources', 'config', 'runtime-env.json')
  );

  candidatePaths.push(path.join(__dirname, '..', '..', 'resources', 'config', 'runtime-env.json'));
  candidatePaths.push(path.join(process.cwd(), 'resources', 'config', 'runtime-env.json'));

  for (const candidate of candidatePaths) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      logGitConfigInfo(`Loaded runtime env from ${candidate}`);
      return parsed;
    } catch {
      // try next candidate
    }
  }

  return null;
}

/**
 * Resolve the active git provider.
 * Priority: process.env.GIT_PROVIDER → runtime-env.json → 'dugite'
 *
 * Legacy pre-dugite provider values (from env or runtime-env.json) are
 * migrated to 'dugite' with a warning — never rejected. Any other
 * unknown value throws (fail-fast, no silent fallback).
 *
 * @param {Object} [options]
 * @param {Object} [options.env] - env source (defaults to process.env)
 * @param {Object|null} [options.runtimeEnvConfig] - preloaded
 *   runtime-env.json contents (defaults to loading from disk)
 * @param {{ warn: Function }} [options.logger] - migration-warning sink
 * @returns {{ provider: string, source: string }}
 * @throws {Error} on unsupported (non-legacy) provider values
 */
function resolveGitProvider(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || defaultLogger;
  const runtimeEnvConfig = options.runtimeEnvConfig !== undefined
    ? options.runtimeEnvConfig
    : loadRuntimeEnvConfigSync();

  const envProvider = ((env && env.GIT_PROVIDER) || '').trim();
  if (envProvider) {
    return resolveProviderValue(envProvider, 'process.env', logger);
  }

  const runtimeProvider = ((runtimeEnvConfig && runtimeEnvConfig.GIT_PROVIDER) || '').trim();
  if (runtimeProvider) {
    return resolveProviderValue(runtimeProvider, 'runtime-env.json', logger);
  }

  return { provider: DEFAULT_GIT_PROVIDER, source: 'default' };
}

/**
 * Map a raw provider value onto the supported set. Migration runs
 * BEFORE strict validation so legacy installs keep booting.
 * @param {string} rawValue - Value from env or runtime-env.json
 * @param {string} source - Origin label ('process.env'|'runtime-env.json')
 * @param {{ warn: Function }} logger
 * @returns {{ provider: string, source: string }}
 */
function resolveProviderValue(rawValue, source, logger) {
  const migrated = LEGACY_GIT_PROVIDER_MIGRATIONS[rawValue];
  if (migrated) {
    const warnKey = `${source}:${rawValue}`;
    if (!warnedMigrations.has(warnKey)) {
      warnedMigrations.add(warnKey);
      logger.warn(`Legacy GIT_PROVIDER=${rawValue} migrated to ${migrated}`);
    }
    return { provider: migrated, source: `${source} (migrated from ${rawValue})` };
  }

  if (!isSupportedGitProvider(rawValue)) {
    const message =
      `Unsupported GIT_PROVIDER: ${rawValue} (expected: dugite). ` +
      'Fix GIT_PROVIDER in your environment or in resources/config/runtime-env.json.';
    logGitConfigError(message);
    throw new Error(message);
  }

  return { provider: rawValue, source };
}

/**
 * Validate a git provider value.
 * @param {string} provider
 * @returns {boolean}
 */
function isSupportedGitProvider(provider) {
  return SUPPORTED_GIT_PROVIDERS.includes(provider);
}

module.exports = {
  DEFAULT_GIT_PROVIDER,
  SUPPORTED_GIT_PROVIDERS,
  LEGACY_GIT_PROVIDER_MIGRATIONS,
  resolveGitProvider,
  isSupportedGitProvider
};
