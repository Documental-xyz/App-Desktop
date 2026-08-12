/**
 * @fileoverview Permission handler with caching for branch-level access checks
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain } = require('electron');
const { secureTokenService } = require('../services/secureTokenService.js');

// Import cache TTL from gitFlowTypes with fallback for resilience (Task 1 parallel).
const { PERMISSION_CACHE_TTL_MS } = (() => {
  try {
    return require('./gitFlowTypes.js');
  } catch (_e) {
    return { PERMISSION_CACHE_TTL_MS: 30 * 60 * 1000 };
  }
})();

/**
 * @typedef {Object} PermissionResult
 * @property {boolean} success - Whether the check succeeded
 * @property {('admin'|'maintain'|'write'|'triage'|'read'|'none')} permission - GitHub permission level
 * @property {boolean} canPushToMain - Whether the user can push directly to main
 * @property {boolean} cached - Whether the result came from cache
 * @property {string} [error] - Error message if success is false
 */

/**
 * Regex to extract owner/repo from a GitHub remote URL.
 * Handles both SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git) forms.
 */
const GITHUB_URL_RE = /github\.com[\/:]([^\/]+)\/([^\/\.]+)(\.git)?$/;

/** Permissions that allow pushing directly to a protected branch like main. */
const MAIN_PUSH_PERMISSIONS = ['admin', 'maintain', 'write'];

/** Network error codes that should trigger a single retry with backoff. */
const RETRYABLE_ERROR_CODES = new Set(['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']);

/** Backoff (ms) before retrying a transient network error. */
const NETWORK_RETRY_BACKOFF_MS = 1000;

/**
 * Permission IPC Handlers.
 *
 * Wraps `octokit.repos.getCollaboratorPermissionLevel` with a 30-minute
 * in-memory cache so repeated UI gating checks for the same user/repo
 * resolve in microseconds instead of round-tripping the GitHub API.
 */
class PermissionHandlers {
  /**
   * Create an instance of PermissionHandlers.
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} [dependencies.auth] - AuthHandlers instance (used when available)
   * @param {Object} dependencies.databaseManager - Database manager instance
   * @param {Object} dependencies.logger - Logger instance
   */
  constructor({ auth, databaseManager, logger }) {
    this.auth = auth || null;
    this.databaseManager = databaseManager;
    this.logger = logger;

    /**
     * In-memory permission cache.
     * Key format: `${owner}/${repo}:${username}`
     * Value: { permission, canPushToMain, timestamp }
     * @type {Map<string, {permission: string, canPushToMain: boolean, timestamp: number}>}
     * @private
     */
    this._permissionCache = new Map();

    /**
     * In-memory branch protection cache.
     * Key format: `${owner}/${repo}:${branch}`
     * Value: { isProtected, allowsForcePushes, enforceAdmins, canUserPush, note, timestamp }
     * @type {Map<string, {isProtected: boolean, allowsForcePushes: boolean|null, enforceAdmins: boolean|null, canUserPush: boolean|null, note?: string, timestamp: number}>}
     * @private
     */
    this._branchProtectionCache = new Map();

    /**
     * Reverse index from projectId to cache keys, so invalidation by project
     * does not require scanning every entry.
     * @type {Map<string, Set<string>>}
     * @private
     */
    this._projectToCacheKeys = new Map();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Check whether the current user has permission to push to the main branch
   * of the repository associated with `projectId`.
   *
   * Flow:
   *  1. Resolve owner/repo from the project via the database.
   *  2. Resolve the current username.
   *  3. Return a cached entry if still fresh (< PERMISSION_CACHE_TTL_MS).
   *  4. Otherwise call GitHub's collaborator permission endpoint, cache, return.
   *
   * @param {number|string} projectId - Project ID to check.
   * @returns {Promise<PermissionResult>} Permission result.
   */
  async checkMainPermission(projectId) {
    try {
      // Step 1: resolve owner/repo from the project row.
      const { owner, repo, remoteUrl } = await this._resolveRepo(projectId);
      if (!owner || !repo) {
        return {
          success: false,
          permission: 'none',
          canPushToMain: false,
          cached: false,
          error: `Could not determine owner/repo for project ${projectId} (remoteUrl: ${remoteUrl || 'unknown'})`,
        };
      }

      // Step 2: resolve the current username.
      const username = await this._resolveUsername();
      if (!username) {
        return {
          success: false,
          permission: 'none',
          canPushToMain: false,
          cached: false,
          error: 'Not authenticated. Sign in to GitHub first.',
        };
      }

      // Fast path: if the user IS the repo owner, they always have push permission.
      // This avoids false 404 from getCollaboratorPermissionLevel (owners aren't
      // listed as "collaborators" in the GitHub API).
      if (username === owner) {
        this.logger.info(`🔐 ${username} is the owner of ${owner}/${repo} — permission granted (admin)`);
        const cacheKey = `${owner}/${repo}:${username}`;
        const result = { success: true, permission: 'admin', canPushToMain: true, cached: false };
        this._permissionCache.set(cacheKey, { permission: 'admin', canPushToMain: true, timestamp: Date.now() });
        this._indexCacheKey(String(projectId), cacheKey);
        return result;
      }

      // Step 3: check cache.
      const cacheKey = `${owner}/${repo}:${username}`;
      const now = Date.now();
      const cached = this._permissionCache.get(cacheKey);
      if (cached && (now - cached.timestamp) < PERMISSION_CACHE_TTL_MS) {
        this.logger.info(`🔐 Permission cache HIT for ${cacheKey}`);
        return {
          success: true,
          permission: cached.permission,
          canPushToMain: cached.canPushToMain,
          cached: true,
        };
      }

      // Step 4: call GitHub.
      const permission = await this._fetchPermissionWithRetry(owner, repo, username);
      const canPushToMain = MAIN_PUSH_PERMISSIONS.includes(permission);

      // Cache & index for invalidation.
      this._permissionCache.set(cacheKey, { permission, canPushToMain, timestamp: Date.now() });
      this._indexCacheKey(String(projectId), cacheKey);

      return { success: true, permission, canPushToMain, cached: false };
    } catch (error) {
      this.logger.error(`❌ checkMainPermission failed for project ${projectId}:`, error);

      // 401/403 → re-authentication required; propagate a clear message.
      if (error.status === 401 || error.status === 403) {
        return {
          success: false,
          permission: 'none',
          canPushToMain: false,
          cached: false,
          error: 'Authentication expired. Sign in again.',
        };
      }
      return {
        success: false,
        permission: 'none',
        canPushToMain: false,
        cached: false,
        error: error.message,
      };
    }
  }

  /**
   * Check whether a branch is protected and what rules apply.
   *
   * Informational only — publish gating happens in the preflight task.
   *
   * Flow:
   *  1. Resolve owner/repo from the project via the database.
   *  2. Resolve the current username.
   *  3. Return a cached entry if still fresh (< PERMISSION_CACHE_TTL_MS).
   *  4. Otherwise call GitHub's branch protection endpoint, cache, return.
   *
   * @param {number|string} projectId - Project ID to check.
   * @param {string} branchName - Branch name to check (e.g. 'main').
   * @returns {Promise<Object>} Branch protection result.
   */
  async checkBranchProtection(projectId, branchName) {
    try {
      // Step 1: resolve owner/repo from the project row.
      const { owner, repo, remoteUrl } = await this._resolveRepo(projectId);
      if (!owner || !repo) {
        return {
          success: false,
          isProtected: null,
          allowsForcePushes: null,
          enforceAdmins: null,
          canUserPush: null,
          cached: false,
          error: `Could not determine owner/repo for project ${projectId} (remoteUrl: ${remoteUrl || 'unknown'})`,
        };
      }

      // Step 2: resolve the current username (used for canUserPush).
      const username = await this._resolveUsername();
      if (!username) {
        return {
          success: false,
          isProtected: null,
          allowsForcePushes: null,
          enforceAdmins: null,
          canUserPush: null,
          cached: false,
          error: 'Not authenticated. Sign in to GitHub first.',
        };
      }

      // Step 3: check cache.
      const cacheKey = `${owner}/${repo}:${branchName}`;
      const now = Date.now();
      const cached = this._branchProtectionCache.get(cacheKey);
      if (cached && (now - cached.timestamp) < PERMISSION_CACHE_TTL_MS) {
        this.logger.info(`🔐 Branch protection cache HIT for ${cacheKey}`);
        return {
          success: true,
          isProtected: cached.isProtected,
          allowsForcePushes: cached.allowsForcePushes,
          enforceAdmins: cached.enforceAdmins,
          canUserPush: cached.canUserPush,
          note: cached.note,
          cached: true,
        };
      }

      // Step 4: call GitHub.
      const result = await this._fetchBranchProtectionWithRetry(owner, repo, branchName, username);

      // Cache & index for invalidation.
      this._branchProtectionCache.set(cacheKey, { ...result, timestamp: Date.now() });
      this._indexCacheKey(String(projectId), cacheKey);

      return { ...result, cached: false };
    } catch (error) {
      this.logger.error(`❌ checkBranchProtection failed for project ${projectId} branch ${branchName}:`, error);

      // 401 → re-authentication required; propagate a clear message.
      if (error.status === 401) {
        return {
          success: false,
          isProtected: null,
          allowsForcePushes: null,
          enforceAdmins: null,
          canUserPush: null,
          cached: false,
          error: 'Authentication expired. Sign in again.',
        };
      }
      return {
        success: false,
        isProtected: null,
        allowsForcePushes: null,
        enforceAdmins: null,
        canUserPush: null,
        cached: false,
        error: error.message,
      };
    }
  }

  /**
   * Invalidate all cached permission entries for a given project.
   * Useful after a user re-authenticates, is added/removed as a collaborator,
   * or switches branches.
   * @param {number|string} projectId - Project ID whose cache entries to drop.
   * @returns {void}
   */
  invalidatePermissionCache(projectId) {
    const keys = this._projectToCacheKeys.get(String(projectId));
    if (!keys || keys.size === 0) {
      return;
    }
    for (const key of keys) {
      this._permissionCache.delete(key);
    }
    this._projectToCacheKeys.delete(String(projectId));
    this.logger.info(`🧹 Invalidated ${keys.size} permission cache entr${keys.size === 1 ? 'y' : 'ies'} for project ${projectId}`);
  }

  /**
   * Register IPC handlers for the permission domain.
   * @param {typeof import('electron').ipcMain} [ipcMainInstance] - ipcMain instance (defaults to imported one).
   * @returns {void}
   */
  register(ipcMainInstance = ipcMain) {
    this.logger.info('🔐 Registering permission IPC handlers');

    ipcMainInstance.handle(
      'git:check-main-permission',
      async (_event, projectId) => this.checkMainPermission(projectId),
    );
    ipcMainInstance.handle(
      'git:check-branch-protection',
      async (_event, projectId, branchName) => this.checkBranchProtection(projectId, branchName),
    );
    ipcMainInstance.handle(
      'git:invalidate-permission-cache',
      async (_event, projectId) => {
        this.invalidatePermissionCache(projectId);
        return { success: true };
      },
    );

    this.logger.info('✅ Permission IPC handlers registered');
  }

  /**
   * Unregister IPC handlers (useful for hot-reload).
   * @param {typeof import('electron').ipcMain} [ipcMainInstance]
   * @returns {void}
   */
  unregister(ipcMainInstance = ipcMain) {
    ipcMainInstance.removeHandler('git:check-main-permission');
    ipcMainInstance.removeHandler('git:check-branch-protection');
    ipcMainInstance.removeHandler('git:invalidate-permission-cache');
    this.logger.info('🔐 Permission IPC handlers unregistered');
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Resolve owner/repo for a project by reading the database row.
   * Uses the `repoUrl` column (mirrors ProjectHandlers.getProjectDetails).
   * @param {number|string} projectId
   * @returns {Promise<{owner: string|null, repo: string|null, remoteUrl: string|null}>}
   * @private
   */
  async _resolveRepo(projectId) {
    const row = await this._getProjectRow(projectId);
    if (!row) {
      return { owner: null, repo: null, remoteUrl: null };
    }
    const remoteUrl = row.repoUrl || row.remoteUrl || null;
    if (!remoteUrl) {
      return { owner: null, repo: null, remoteUrl: null };
    }
    const match = remoteUrl.match(GITHUB_URL_RE);
    if (!match) {
      return { owner: null, repo: null, remoteUrl };
    }
    return { owner: match[1], repo: match[2], remoteUrl };
  }

  /**
   * Read a single project row from the database.
   * @param {number|string} projectId
   * @returns {Promise<Object|null>}
   * @private
   */
  _getProjectRow(projectId) {
    return new Promise((resolve) => {
      let settled = false;
      this.databaseManager
        .getDatabase()
        .then((db) => {
          db.get(
            `SELECT projectName, repoUrl, repoFullName, projectPath, repoFolderName FROM projects WHERE id = ?`,
            [projectId],
            (err, row) => {
              if (settled) return;
              settled = true;
              if (err) {
                this.logger.error(`Error loading project ${projectId}:`, err.message);
                resolve(null);
                return;
              }
              resolve(row || null);
            },
          );
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          this.logger.error(`Error opening database for project ${projectId}:`, error);
          resolve(null);
        });
    });
  }

  /**
   * Resolve the current authenticated GitHub username.
   * Prefers the injected auth handler's user info; falls back to the API.
   * @returns {Promise<string|null>}
   * @private
   */
  async _resolveUsername() {
    // 1) Try the auth handler's stored user info (no network round trip).
    if (this.auth && typeof this.auth.getUserInfoFromDatabase === 'function') {
      try {
        const info = await this.auth.getUserInfoFromDatabase();
        if (info && info.login) {
          return info.login;
        }
      } catch (error) {
        this.logger.warn('getUserInfoFromDatabase failed, falling back to token lookup:', error.message);
      }
    }
    // 2) Fall back to fetching the authenticated user via token + Octokit.
    try {
      const token = await secureTokenService.getToken();
      if (!token) {
        return null;
      }
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: token });
      const { data } = await octokit.users.getAuthenticated();
      return (data && data.login) || null;
    } catch (error) {
      this.logger.error('Error resolving GitHub username:', error);
      return null;
    }
  }

  /**
   * Build an authenticated Octokit instance from the secure token.
   * @returns {Promise<Object|null>} Octokit instance or null if not authenticated.
   * @private
   */
  async _getOctokit() {
    const token = await secureTokenService.getToken();
    if (!token) {
      return null;
    }
    const { Octokit } = await import('@octokit/rest');
    return new Octokit({ auth: token });
  }

  /**
   * Fetch the collaborator permission level for (owner, repo, username),
   * retrying once on transient network errors.
   *
   * Error mapping:
   *  - 404 → 'none' (user is not a collaborator)
   *  - 401/403 → thrown (propagated to caller, which converts to auth-expired message)
   *  - network (ENOTFOUND, ETIMEDOUT, ...) → retry once after backoff, then propagate
   *
   * @param {string} owner
   * @param {string} repo
   * @param {string} username
   * @returns {Promise<string>} Permission level ('admin'|'maintain'|'write'|'triage'|'read'|'none')
   * @private
   */
  async _fetchPermissionWithRetry(owner, repo, username) {
    try {
      return await this._fetchPermission(owner, repo, username);
    } catch (error) {
      if (this._isRetryableNetworkError(error)) {
        this.logger.warn(`🌐 Transient network error checking permission for ${owner}/${repo}; retrying in ${NETWORK_RETRY_BACKOFF_MS}ms...`, error.message);
        await this._sleep(NETWORK_RETRY_BACKOFF_MS);
        return this._fetchPermission(owner, repo, username); // propagate if it fails again
      }
      throw error;
    }
  }

  /**
   * Single attempt to fetch the collaborator permission level.
   * @param {string} owner
   * @param {string} repo
   * @param {string} username
   * @returns {Promise<string>}
   * @private
   */
  async _fetchPermission(owner, repo, username) {
    const octokit = await this._getOctokit();
    if (!octokit) {
      // No token means we cannot authenticate — surface as auth error.
      const err = new Error('Authentication expired. Sign in again.');
      err.status = 401;
      throw err;
    }

    try {
      const { data } = await octokit.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username,
      });
      return data && data.permission ? data.permission : 'read';
    } catch (error) {
      // 404: user is not a collaborator → treat as no permission, not an error.
      if (error.status === 404) {
        this.logger.info(`ℹ️ ${username} is not a collaborator on ${owner}/${repo} (404 → 'none')`);
        return 'none';
      }
      // 401/403 and network errors propagate to the retry/caller layers.
      throw error;
    }
  }

  /**
   * Fetch branch protection rules for (owner, repo, branch), retrying once on
   * transient network errors.
   *
   * Error mapping:
   *  - 200 → parsed protection rules
   *  - 404 → branch is not protected
   *  - 403 → branch is protected but rules are not visible (non-admin)
   *  - network (ENOTFOUND, ETIMEDOUT, ...) → retry once after backoff, then propagate
   *
   * @param {string} owner
   * @param {string} repo
   * @param {string} branch
   * @param {string} username
   * @returns {Promise<Object>}
   * @private
   */
  async _fetchBranchProtectionWithRetry(owner, repo, branch, username) {
    try {
      return await this._fetchBranchProtection(owner, repo, branch, username);
    } catch (error) {
      if (this._isRetryableNetworkError(error)) {
        this.logger.warn(`🌐 Transient network error checking branch protection for ${owner}/${repo}:${branch}; retrying in ${NETWORK_RETRY_BACKOFF_MS}ms...`, error.message);
        await this._sleep(NETWORK_RETRY_BACKOFF_MS);
        return this._fetchBranchProtection(owner, repo, branch, username); // propagate if it fails again
      }
      throw error;
    }
  }

  /**
   * Single attempt to fetch branch protection rules.
   * @param {string} owner
   * @param {string} repo
   * @param {string} branch
   * @param {string} username
   * @returns {Promise<Object>}
   * @private
   */
  async _fetchBranchProtection(owner, repo, branch, username) {
    const octokit = await this._getOctokit();
    if (!octokit) {
      // No token means we cannot authenticate — surface as auth error.
      const err = new Error('Authentication expired. Sign in again.');
      err.status = 401;
      throw err;
    }

    try {
      const { data } = await octokit.repos.getBranchProtection({ owner, repo, branch });
      const allowsForcePushes = Boolean(data && data.allow_force_pushes && data.allow_force_pushes.enabled);
      const enforceAdmins = Boolean(data && data.enforce_admins && data.enforce_admins.enabled);
      const requiredStatusChecks = (data && data.required_status_checks && data.required_status_checks.contexts) || [];
      return {
        success: true,
        isProtected: true,
        allowsForcePushes,
        enforceAdmins,
        requiredStatusChecks,
        canUserPush: this._canUserPushFromCache(owner, repo, username),
      };
    } catch (error) {
      // 404: branch is not protected.
      if (error.status === 404) {
        this.logger.info(`ℹ️ Branch ${branch} on ${owner}/${repo} is not protected (404)`);
        return {
          success: true,
          isProtected: false,
          allowsForcePushes: null,
          enforceAdmins: null,
          canUserPush: true,
        };
      }
      // 403: branch is protected but rules are not visible to this user.
      if (error.status === 403) {
        this.logger.info(`ℹ️ Cannot view protection rules for ${owner}/${repo}:${branch} (403)`);
        return {
          success: true,
          isProtected: true,
          allowsForcePushes: null,
          enforceAdmins: null,
          canUserPush: null,
          note: 'Cannot view protection rules — insufficient permissions',
        };
      }
      throw error;
    }
  }

  /**
   * Determine whether the user can push to a protected branch by consulting
   * the existing permission cache (admin → can push past branch protection).
   * @param {string} owner
   * @param {string} repo
   * @param {string} username
   * @returns {boolean|null} true if admin, false if known non-admin, null if unknown.
   * @private
   */
  _canUserPushFromCache(owner, repo, username) {
    const cached = this._permissionCache.get(`${owner}/${repo}:${username}`);
    if (!cached) {
      return null;
    }
    return cached.permission === 'admin';
  }

  /**
   * Heuristic: does this error represent a transient network failure worth retrying?
   * @param {Error & {code?: string, status?: number}} error
   * @returns {boolean}
   * @private
   */
  _isRetryableNetworkError(error) {
    if (!error) return false;
    // HTTP-level errors already have a status; only retry socket/DNS-level codes.
    if (typeof error.status === 'number') return false;
    if (error.code && RETRYABLE_ERROR_CODES.has(error.code)) return true;
    const msg = (error.message || '').toLowerCase();
    return msg.includes('network') || msg.includes('timeout') || msg.includes('socket hang up');
  }

  /**
   * Associate a cache key with a projectId so it can be invalidated later.
   * @param {string} projectId
   * @param {string} cacheKey
   * @private
   */
  _indexCacheKey(projectId, cacheKey) {
    let set = this._projectToCacheKeys.get(projectId);
    if (!set) {
      set = new Set();
      this._projectToCacheKeys.set(projectId, set);
    }
    set.add(cacheKey);
  }

  /**
   * Promise-based sleep helper.
   * @param {number} ms
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { PermissionHandlers, PERMISSION_CACHE_TTL_MS };
