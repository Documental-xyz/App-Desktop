/**
 * @fileoverview Git Provider Factory (main process only)
 * @since 2.0.0
 *
 * Creates the active git provider implementation based on GIT_PROVIDER
 * ('dugite' — the only supported backend since Task 14). Legacy
 * 'isomorphic-git' values are migrated upstream in
 * git-config.resolveGitProvider(); by the time a value reaches this
 * factory it is either 'dugite' or a fatal error — there is NO silent
 * fallback.
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
 *   constructor; loader-injected instances (loadGit/loadHttp module
 *   overrides, T11/T12 test injection) are never cached — only the
 *   default (optionless) instance is.
 * @returns {Object} provider instance implementing the GitProvider contract
 * @throws {Error} if GIT_PROVIDER is unsupported or the implementation
 *   module cannot be loaded
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

  const { provider } = resolveGitProvider();

  if (!isSupportedGitProvider(provider)) {
    throw new Error(
      `Unsupported GIT_PROVIDER: ${provider} (expected: dugite)`
    );
  }

  // dugite is the only backend; require errors (missing/corrupt module)
  // propagate as-is.
  const m = require('./providers/DugiteProvider');
  const Ctor = m.DugiteProvider || m;
  const instance = new Ctor();

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
