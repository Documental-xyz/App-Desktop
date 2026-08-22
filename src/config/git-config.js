/**
 * @fileoverview Git Provider Configuration (main process only)
 * @since 2.0.0
 *
 * Resolves which git backend to use: 'isomorphic-git' or 'dugite'.
 * Priority: process.env.GIT_PROVIDER → runtime-env.json → 'isomorphic-git'
 *
 * IMPORTANT: This module MUST only be required from the main process
 * (it reads the filesystem for runtime-env.json). Do not import it
 * from the renderer process.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const DEFAULT_GIT_PROVIDER = 'isomorphic-git';
const SUPPORTED_GIT_PROVIDERS = ['isomorphic-git', 'dugite'];

function logGitConfigInfo(message) {
  if (process?.stdout?.write) {
    process.stdout.write(`[GitConfig] ${message}\n`);
  }
}

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
 * Priority: process.env.GIT_PROVIDER → runtime-env.json → 'isomorphic-git'
 * @returns {{ provider: string, source: string }}
 */
function resolveGitProvider() {
  const envProvider = (process.env.GIT_PROVIDER || '').trim();
  if (envProvider) {
    return { provider: envProvider, source: 'process.env' };
  }

  const runtimeProvider = (loadRuntimeEnvConfigSync()?.GIT_PROVIDER || '').trim();
  if (runtimeProvider) {
    return { provider: runtimeProvider, source: 'runtime-env.json' };
  }

  return { provider: DEFAULT_GIT_PROVIDER, source: 'default' };
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
  resolveGitProvider,
  isSupportedGitProvider
};
