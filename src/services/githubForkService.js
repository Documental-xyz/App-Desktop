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
   * Check whether the authenticated user already has a repository with the given name.
   * @param {string} repoName - Repository name to check.
   * @returns {Promise<{ exists: boolean, owner?: string, error?: string }>}
   */
  async checkRepoExists(repoName) {
    try {
      const token = await secureTokenService.getToken();
      if (!token) {
        return { exists: false, error: 'Not authenticated' };
      }
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: token });
      const { data: user } = await octokit.users.getAuthenticated();
      await octokit.repos.get({ owner: user.login, repo: repoName });
      return { exists: true, owner: user.login };
    } catch (error) {
      if (error && error.status === 404) {
        return { exists: false };
      }
      return { exists: false, error: error?.message || 'Unknown error' };
    }
  }

  /**
   * Check if a fork of the given source repo already exists in the user's account or a specific org.
   * Uses the GitHub API: GET /repos/{owner}/{repo}/forks and checks if any fork's owner matches.
   * @param {string} sourceOwner - Source repo owner (e.g. "Documental-xyz")
   * @param {string} sourceRepo - Source repo name (e.g. "Documental")
   * @param {string} [targetOwner] - Optional: check if fork exists in this specific account/org
   * @returns {Promise<{ exists: boolean, existingForkFullName?: string }>}
   */
  async checkForkExists(sourceOwner, sourceRepo, targetOwner = null) {
    try {
      const token = await secureTokenService.getToken();
      if (!token) return { exists: false };
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: token });

      const { data: user } = await octokit.users.getAuthenticated();
      const checkOwner = targetOwner || user.login;

      const forks = await octokit.repos.listForks({ owner: sourceOwner, repo: sourceRepo, per_page: 100 });
      const existingFork = forks.data.find(f => f.owner && f.owner.login === checkOwner);
      if (existingFork) {
        return { exists: true, existingForkFullName: existingFork.full_name };
      }
      return { exists: false };
    } catch (error) {
      this.logger?.error?.('checkForkExists error:', error?.message);
      return { exists: false, error: error?.message };
    }
  }

  /**
   * Enable GitHub Pages on a repository using workflow build type.
   * @param {string} owner - Repository owner.
   * @param {string} repo - Repository name.
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async enableGitHubPages(owner, repo) {
    try {
      const token = await secureTokenService.getToken();
      if (!token) {
        return { success: false, error: 'Not authenticated' };
      }
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: token });

      try {
        await octokit.repos.createPagesSite({ owner, repo, build_type: 'workflow' });
        this.logger?.info?.('GitHub Pages enabled for', owner + '/' + repo);
      } catch (error) {
        // 409 = Pages already enabled — update build_type instead
        if (error && error.status === 409) {
          this.logger?.info?.('GitHub Pages already enabled for', owner + '/' + repo);
          try {
            await octokit.repos.updateInformationAboutPagesSite({ owner, repo, build_type: 'workflow' });
          } catch (updateError) {
            this.logger?.debug?.('Pages update returned:', updateError?.message);
          }
        } else {
          throw error;
        }
      }

      return { success: true };
    } catch (error) {
      this.logger?.error?.('Failed to enable GitHub Pages:', error?.message);
      return { success: false, error: error?.message || 'Unknown error' };
    }
  }

  /**
   * Create a fork of the given repository and poll until it is ready.
   *
   * @param {string} owner - Source repository owner (e.g. "documental").
   * @param {string} repo - Source repository name (e.g. "template").
   * @param {(message: string) => void} [onProgress] - Optional progress callback.
   * @param {string} [forkName] - Optional custom name for the fork (slug of project name).
   * @param {string} [organization] - Optional org login to fork into (instead of personal account).
   * @returns {Promise<{ success: boolean, forkCloneUrl: string, fork: Object }>}
   * @throws {Error} When not authenticated, fork creation fails, or polling times out.
   */
  async forkAndPoll(owner, repo, onProgress, forkName = null, organization = null) {
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

    const actualRepoName = forkName || repo;
    let forkFullName = null;

    // e. Create fork (202 accepted; GitHub processes async).
    try {
      const forkParams = { owner, repo };
      if (forkName) {
        forkParams.name = forkName;
      }
      if (organization) {
        forkParams.organization = organization;
      }
      const response = await octokit.repos.createFork(forkParams);
      this.logger?.info?.('createFork response status:', response?.status);
      if (response?.data?.full_name) {
        forkFullName = response.data.full_name;
        this.logger?.info?.('createFork full_name:', forkFullName);
      }
    } catch (error) {
      const status = error && error.status;
      const message = (error && error.message) || '';
      if (status === 202 || /already exist/i.test(message)) {
        throw new Error('A repository with this name already exists in your account. Please choose a different workspace name.');
      } else {
        throw new Error('Failed to create fork: ' + message);
      }
    }

    // Use the actual fork name from the API response when available
    const pollOwner = forkFullName ? forkFullName.split('/')[0] : (organization || userLogin);
    const pollRepo = forkFullName ? forkFullName.split('/')[1] : actualRepoName;

    // f. Poll until ready or timeout
    const { intervalMs, timeoutMs } = this._resolvePollingConfig();
    const startedAt = Date.now();
    let data = null;

    for (;;) {
      try {
        const response = await octokit.repos.get({ owner: pollOwner, repo: pollRepo });
        if (response.status === 200 && response.data && response.data.parent) {
          data = response.data;
          break;
        }
      } catch (error) {
        this.logger?.debug?.('Polling repos.get:', pollOwner + '/' + pollRepo, '→', error && error.message);
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new Error('Fork polling timed out after ' + timeoutMs + 'ms');
      }

      if (onProgress) onProgress(t('create.fork_waiting'));
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    // g. Return result (no rename — fork name is set at creation time via forkParams.name)
    return {
      success: true,
      forkCloneUrl: 'https://github.com/' + pollOwner + '/' + (data?.name || pollRepo) + '.git',
      fork: data
    };
  }

  /**
   * Create a new repository from a template repository.
   *
   * Unlike `forkAndPoll`, this operation is synchronous: GitHub returns 201
   * with the fully-created repository, so no polling is required.
   *
   * @param {string} templateOwner - Template repository owner (e.g. "Documental-xyz").
   * @param {string} templateRepo - Template repository name (e.g. "Template").
   * @param {string} repoName - Name for the new repository.
   * @param {(message: string) => void} [onProgress] - Optional progress callback.
   * @param {Object} [options] - Optional creation parameters.
   * @param {string} [options.owner] - Target org/account (omit to use authenticated user).
   * @param {string} [options.description] - Repository description.
   * @param {boolean} [options.private=false] - Whether to create a private repo.
   * @param {boolean} [options.includeAllBranches=false] - Whether to include all branches from the template.
   * @returns {Promise<{ success: boolean, cloneUrl: string, repo: Object }>}
   * @throws {Error} When not authenticated, template is not found, name is taken, or permission is denied.
   */
  async createFromTemplate(templateOwner, templateRepo, repoName, onProgress, options = {}) {
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

    // c. Authenticated user (validates token + provides fallback owner)
    let userLogin;
    try {
      const { data: user } = await octokit.users.getAuthenticated();
      userLogin = user.login;
    } catch (error) {
      throw new Error('Failed to get authenticated user: ' + error.message);
    }

    // d. Progress
    if (onProgress) onProgress(t('create.template_creating'));

    // e. Build params (template_owner/template_repo are path params managed by Octokit)
    const params = {
      template_owner: templateOwner,
      template_repo: templateRepo,
      name: repoName,
      description: options.description || '',
      include_all_branches: options.includeAllBranches !== undefined ? options.includeAllBranches : false,
      private: options.private !== undefined ? options.private : false
    };
    if (options.owner) {
      // When omitted, GitHub creates the repo under the authenticated user.
      params.owner = options.owner;
    }

    // f. Create from template (201 is synchronous — no polling needed)
    let response;
    try {
      response = await octokit.rest.repos.createUsingTemplate(params);
    } catch (error) {
      const status = error && error.status;
      const message = (error && error.message) || '';
      if (status === 404) {
        throw new Error(t('create.template_not_found'));
      }
      if (status === 422) {
        throw new Error(t('create.template_name_taken'));
      }
      if (status === 403) {
        if (/scope|private/i.test(message)) {
          throw new Error(t('create.template_invalid_scope'));
        }
        throw new Error(t('create.template_no_permission'));
      }
      throw new Error(t('create.template_error', { error: message }));
    }

    // g. Extract cloneUrl (prefer response, fallback to constructed URL)
    const effectiveOwner = options.owner || userLogin;
    const cloneUrl = (response && response.data && response.data.clone_url) ||
      ('https://github.com/' + effectiveOwner + '/' + repoName + '.git');

    return {
      success: true,
      cloneUrl,
      repo: response.data
    };
  }
}

module.exports = {
  githubForkService: new GithubForkService({ logger: console }),
  GithubForkService
};
