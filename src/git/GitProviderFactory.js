/**
 * @fileoverview Git Provider Factory (main process only)
 * @since 2.0.0
 *
 * Creates the active git provider implementation based on GIT_PROVIDER
 * ('isomorphic-git' | 'dugite'). Invalid values are a fatal error —
 * there is NO silent fallback.
 *
 * Requires of provider implementations are LAZY (inside the switch cases)
 * because the implementations land in later waves (Wave 3 / Wave 4).
 */

'use strict';

const {
  resolveGitProvider,
  isSupportedGitProvider
} = require('../config/git-config');

/** @type {Object|null} cached singleton instance */
let cachedInstance = null;

/**
 * Create (or return cached) git provider instance for the configured provider.
 * @param {Object} [providerOptions] - Passed through to the provider
 *   constructor (IsomorphicGitProvider accepts `loadGit`/`loadHttp` module
 *   overrides; loader-injected instances are never cached — only the
 *   default (optionless) instance is).
 * @returns {Object} provider instance implementing the GitProvider contract
 * @throws {Error} if GIT_PROVIDER is unsupported or implementation not yet available
 */
function createGitProvider(providerOptions = {}) {
  // Instances created with module-source loaders (T11/T12 injection) are
  // NOT cached nor served from the cache — each consumer's loaders must
  // reach its own provider instance (the singleton would bind whichever
  // consumer constructed first, breaking the others' mock visibility).
  const hasLoaders = Boolean(providerOptions && (providerOptions.loadGit || providerOptions.loadHttp));
  if (!hasLoaders && cachedInstance) {
    return cachedInstance;
  }

  const { provider, source } = resolveGitProvider();

  if (!isSupportedGitProvider(provider)) {
    throw new Error(
      `Unsupported GIT_PROVIDER: ${provider} (expected: isomorphic-git|dugite)`
    );
  }

  let instance;

  switch (provider) {
    case 'isomorphic-git': {
      let Ctor;
      try {
        const m = require('./providers/IsomorphicGitProvider');
        Ctor = m.IsomorphicGitProvider || m;
      } catch {
        throw new Error('IsomorphicGitProvider not implemented yet — Wave 3');
      }
      instance = new Ctor(providerOptions);
      break;
    }

    case 'dugite': {
      // T15 (network ops) + T16 (local ops) land in the same file;
      // require errors (missing/corrupt module) propagate as-is.
      const m = require('./providers/DugiteProvider');
      const Ctor = m.DugiteProvider || m;
      instance = new Ctor();
      break;
    }

    default:
      throw new Error(
        `Unsupported GIT_PROVIDER: ${provider} (expected: isomorphic-git|dugite)`
      );
  }

  if (!hasLoaders) {
    cachedInstance = instance;
  }
  return instance;
}

/**
 * Reset the cached instance (useful for tests).
 */
function resetGitProviderCache() {
  cachedInstance = null;
}

module.exports = {
  createGitProvider,
  resetGitProviderCache
};
