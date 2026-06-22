/**
 * @fileoverview GitHub Fork Service - creates a fork and polls until ready
 * @author Documental Team
 * @since 1.0.0
 *
 * Forks a source repository into the authenticated user's account and polls
 * until the fork is fully populated (data.parent exists). Uses dynamic import
 * of @octokit/rest to keep the module ESM-compatible.
 */

'use strict';

const { GITHUB_CONFIG } = require('../config/github-config');
const { secureTokenService } = require('./secureTokenService');
const { t } = require('../utils/mainI18n');

/**
 * Default polling configuration used when GITHUB_CONFIG.FORK_POLLING is absent.
 */
const FallbackForkPolling = Object.freeze({ intervalMs: 2000, timeoutMs: 60000 });

/**
 * GithubForkService
 *
 * Creates a fork of a repository and waits for GitHub to finish populating it.
 */
class GithubForkService {
  /**
   * @param {Object} dependencies
   * @param {Object} [dependencies.logger=console] - Logger instance (DI).
   */
  constructor({ logger = console } = {}) {
    this.logger = logger;
  }

  /**
   * Resolve polling configuration, preferring GITHUB_CONFIG.FORK_POLLING
   * and falling back to hardcoded defaults when not yet provided.
   * @returns {{ intervalMs: number, timeoutMs: number }}
   * @private
   */
  _resolvePollingConfig() {
    const cfg = (GITHUB_CONFIG && GITHUB_CONFIG.FORK_POLLING) || FallbackForkPolling;
    return {
      intervalMs: cfg.intervalMs,
      timeoutMs: cfg.timeoutMs
    };
  }

  /**
   * Check if a fork is ready (repo exists and has a populated parent).
   *
   * This helper is self-contained: it resolves the token, builds an Octokit
   * instance, calls repos.get, and returns a boolean. It is used to gate the
   * polling loop and may also be called independently.
   *
   * @param {string} owner - Owner of the forked repo (the authenticated user).
   * @param {string} repo - Repository name.
   * @returns {Promise<boolean>} True when the repo exists and data.parent is populated.
   */
  async isForkReady(owner, repo) {
    try {
      const token = await secureTokenService.getToken();
      if (!token) {
        return false;
      }
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: token });
      const { data, status } = await octokit.repos.get({ owner, repo });
      return status === 200 && Boolean(data && data.parent);
    } catch (error) {
      // 404 is expected while GitHub is still creating the fork.
      this.logger?.debug?.('isForkReady check returned error:', error?.message);
      return false;
    }
  }

  /**
   * Create a fork of the given repository and poll until it is ready.
   *
   * @param {string} owner - Source repository owner (e.g. "documental").
   * @param {string} repo - Source repository name (e.g. "template").
   * @param {(message: string) => void} [onProgress] - Optional progress callback.
   * @returns {Promise<{ success: boolean, forkCloneUrl: string, fork: Object }>}
   * @throws {Error} When not authenticated, fork creation fails, or polling times out.
   */
  async forkAndPoll(owner, repo, onProgress) {
    // a. Retrieve token
    const token = await secureTokenService.getToken();
    if (!token) {
      throw new Error('Not authenticated: no GitHub token found');
    }

    // b. Dynamic import + Octokit instance
    let octokit;
    try {
      const { Octokit } = await import('@octokit/rest');
      octokit = new Octokit({ auth: token });
    } catch (error) {
      throw new Error('Failed to initialize Octokit: ' + error.message);
    }

    // c. Authenticated user
    let userLogin;
    try {
      const { data: user } = await octokit.users.getAuthenticated();
      userLogin = user.login;
    } catch (error) {
      throw new Error('Failed to get authenticated user: ' + error.message);
    }

    // d. Progress
    if (onProgress) onProgress(t('create.fork_creating'));

    // e. Create fork (202 accepted; GitHub processes async).
    //    If the fork already exists, GitHub returns 202 silently — treat as success.
    try {
      await octokit.repos.createFork({ owner, repo });
    } catch (error) {
      // If the error indicates the fork already exists, we can proceed to polling.
      const status = error && error.status;
      const message = (error && error.message) || '';
      if (status === 202 || /already exist/i.test(message)) {
        this.logger?.info?.('Fork already exists; proceeding to polling.');
      } else {
        throw new Error('Failed to create fork: ' + message);
      }
    }

    // f. Poll until ready or timeout
    const { intervalMs, timeoutMs } = this._resolvePollingConfig();
    const startedAt = Date.now();
    let data = null;

    for (;;) {
      try {
        const response = await octokit.repos.get({ owner: userLogin, repo });
        if (response.status === 200 && response.data && response.data.parent) {
          data = response.data;
          break;
        }
      } catch (error) {
        // 404 expected while fork is being created; keep polling unless we time out.
        this.logger?.debug?.('Polling repos.get error:', error && error.message);
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new Error('Fork polling timed out after ' + timeoutMs + 'ms');
      }

      if (onProgress) onProgress(t('create.fork_waiting'));
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    // g. Return result
    return {
      success: true,
      forkCloneUrl: 'https://github.com/' + userLogin + '/' + repo + '.git',
      fork: data
    };
  }
}

module.exports = {
  githubForkService: new GithubForkService({ logger: console }),
  GithubForkService
};
