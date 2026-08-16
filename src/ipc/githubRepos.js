/**
 * @fileoverview IPC handlers for GitHub repository operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain } = require('electron');
const { secureTokenService } = require('../services/secureTokenService.js');
const { GITHUB_CONFIG } = require('../config/github-config.js');
const { getLogger } = require('../main/logging/logger.js');

const MAX_REPOS = 500;

// Cold-start @octokit/rest loading policy: the ESM-only module's first
// dynamic import() in Electron main can transiently fail at the loader
// stage (zero GitHub API requests made), which used to surface as a
// one-time 'Failed to initialize GitHub client' that self-healed on the
// user's retry — Node does not cache rejected dynamic imports. The
// shared loader below turns that into an in-process retry, caches the
// successful module for the process lifetime, and clears the cache on
// terminal failure so a later Try Again can still succeed.
const OCTOKIT_IMPORT_ATTEMPTS = 3;
const OCTOKIT_IMPORT_RETRY_DELAYS_MS = [250, 750];

const loaderLogger = getLogger('GithubReposLoader');

/**
 * Cached promise resolving to the (ESM) @octokit/rest module.
 * @type {Promise<{Octokit: any}> | null}
 */
let _octokitModulePromise = null;

/**
 * Load the @octokit/rest module with transient-failure retry, sharing one
 * in-flight/resolved promise across every caller for the process lifetime.
 * A terminal failure (all attempts exhausted) rejects and clears the cache
 * so the next call starts a fresh import cycle.
 *
 * Deliberately NOT `async`: an async function would wrap the cached promise
 * in a new one per call, breaking the shared-promise identity that lets
 * concurrent callers join the exact in-flight import.
 *
 * @returns {Promise<{Octokit: any}>} The octokit module namespace.
 */
function _loadOctokit() {
  if (_octokitModulePromise) {
    return _octokitModulePromise;
  }
  const promise = (async () => {
    for (let attempt = 1; attempt <= OCTOKIT_IMPORT_ATTEMPTS; attempt++) {
      try {
        return await import('@octokit/rest');
      } catch (error) {
        if (attempt === OCTOKIT_IMPORT_ATTEMPTS) {
          throw error;
        }
        loaderLogger.warn(
          `⚠️ @octokit/rest import failed (attempt ${attempt}/${OCTOKIT_IMPORT_ATTEMPTS}), retrying: ${error.message}`
        );
        await new Promise((resolve) => setTimeout(resolve, OCTOKIT_IMPORT_RETRY_DELAYS_MS[attempt - 1]));
      }
    }
  })();
  _octokitModulePromise = promise;
  // Identity-guarded clear on rejection: never clobbers a newer promise
  // started by a concurrent caller, so a retry cannot be wiped out.
  promise.catch(() => {
    if (_octokitModulePromise === promise) {
      _octokitModulePromise = null;
    }
  });
  return promise;
}

class GithubReposHandlers {
  constructor({ logger }) {
    this.logger = logger;
    // Single-flight guard: concurrent `github:find-documental-repos` invokes
    // share the in-flight scan promise (check-before-acquire, release in
    // finally — same discipline as GitHandlers.gitOperationInProgress).
    this._documentalScanInFlight = null;
  }

  async listUserRepos() {
    let token;
    try {
      token = await secureTokenService.getToken();
    } catch (error) {
      this.logger.error('Error getting GitHub token for repo listing:', error);
      return { success: false, error: 'Failed to retrieve authentication token' };
    }

    if (!token) {
      return { success: false, error: 'Not authenticated' };
    }

    let octokit;
    try {
      const { Octokit } = await _loadOctokit();
      octokit = new Octokit({ auth: token });
    } catch (error) {
      this.logger.error('Error initializing Octokit for repo listing:', error);
      return { success: false, error: 'Failed to initialize GitHub client' };
    }

    const allRepos = [];
    let page = 1;
    const perPage = 100;
    let truncated = false;

    try {
      while (allRepos.length < MAX_REPOS) {
        const response = await octokit.repos.listForAuthenticatedUser({
          per_page: perPage,
          page,
          sort: 'updated',
          affiliation: 'owner,collaborator,organization_member'
        });

        // Detect stale token missing required scopes; trigger re-auth
        const grantedScopesHeader = response.headers?.['x-oauth-scopes'] || '';
        const grantedScopes = grantedScopesHeader.split(',').map(s => s.trim()).filter(Boolean);
        if (grantedScopes.length > 0) {
          const missingScopes = GITHUB_CONFIG.SCOPES.filter(s => !grantedScopes.includes(s));
          if (missingScopes.length > 0) {
            this.logger.warn(`Token missing required scopes: ${missingScopes.join(', ')}. Invalidating for re-auth.`);
            try {
              await secureTokenService.deleteToken();
            } catch (deleteError) {
              this.logger.warn('Failed to delete stale token:', deleteError);
            }
            return { success: false, error: 'Token missing required scopes. Please re-authenticate.', reauthRequired: true };
          }
        }

        if (!response.data || response.data.length === 0) {
          break;
        }

        for (const repo of response.data) {
          allRepos.push({
            id: repo.id,
            name: repo.name,
            full_name: repo.full_name,
            clone_url: repo.clone_url,
            private: repo.private,
            fork: repo.fork || false,
            updated_at: repo.updated_at,
            description: repo.description,
            owner: repo.owner ? { login: repo.owner.login, type: repo.owner.type } : null
          });
        }

        if (response.data.length < perPage) {
          break;
        }

        // Full page received AND the cap is reached: older repos may exist
        // beyond MAX_REPOS — flag the listing as truncated (a notice, not
        // an error).
        if (allRepos.length >= MAX_REPOS) {
          truncated = true;
          break;
        }

        page++;
      }
    } catch (error) {
      if (error.status === 403) {
        this.logger.warn('GitHub rate limit hit while listing repos');
        return { success: false, error: 'Rate limit exceeded. Please try again later.' };
      }
      if (error.status === 401) {
        this.logger.warn('GitHub token expired while listing repos');
        return { success: false, error: 'Token expired. Please re-authenticate.' };
      }
      this.logger.error('Error listing user repos:', error);
      return { success: false, error: error.message };
    }

    const payload = { success: true, repos: allRepos };
    if (truncated) {
      payload.truncated = true;
    }
    return payload;
  }

  /**
   * Finds all repositories containing a documental.json marker file.
   * Uses GitHub Code Search API for efficiency (1-N calls instead of N calls).
   * Owners whose code search SUCCEEDS with 0 items are re-verified via
   * getContent probing (restricted to their repos) because the legacy
   * code-search index can return empty results for accounts that DO have
   * matching repos (task-12 live battery).
   * @returns {Promise<{success: boolean, documentalRepos?: string[], skippedOrgs?: string[], fallback?: boolean, error?: string}>}
   */
  async findDocumentalRepos() {
    let token;
    try {
      token = await secureTokenService.getToken();
    } catch (error) {
      this.logger.error('Error getting GitHub token for documental repo search:', error);
      return { success: false, error: 'Failed to retrieve authentication token' };
    }

    if (!token) {
      return { success: false, error: 'No GitHub token available' };
    }

    let octokit;
    try {
      const { Octokit } = await _loadOctokit();
      octokit = new Octokit({ auth: token });
    } catch (error) {
      this.logger.error('Error initializing Octokit for documental repo search:', error);
      return { success: false, error: 'Failed to initialize GitHub client' };
    }

    const documentalRepos = new Set();
    const skippedOrgs = [];

    try {
      const { data: user } = await octokit.rest.users.getAuthenticated();

      // Task 13 (badge lottery): a 2xx search with ZERO items is NOT
      // trusted — GitHub's legacy code-search index intermittently
      // returns empty results for accounts that DO have matching repos
      // (live battery task-12: identical cold starts alternate 0 vs 24
      // badges). Owners whose search SUCCEEDED with 0 items are
      // re-verified via getContent below.
      let userSearchEmpty = false;

      // Personal repos: search by filename qualifier. Note: space (not +) between qualifiers
      // because octokit encodes '+' as %2B; literal space becomes '+' in the URL query.
      try {
        const userSearch = await octokit.rest.search.code({
          q: `filename:documental.json user:${user.login}`
        });
        const userItems = userSearch.data.items || [];
        userSearchEmpty = userItems.length === 0;
        for (const item of userItems) {
          documentalRepos.add(item.repository.full_name);
        }
      } catch (error) {
        if (error.status === 422) {
          // Qualifier-only query rejected — retry with a literal search term.
          this.logger.warn('Code search 422 on user qualifier-only query; retrying with literal term');
          try {
            const userSearchAlt = await octokit.rest.search.code({
              q: `documental filename:documental.json user:${user.login}`
            });
            const userItemsAlt = userSearchAlt.data.items || [];
            userSearchEmpty = userItemsAlt.length === 0;
            for (const item of userItemsAlt) {
              documentalRepos.add(item.repository.full_name);
            }
          } catch (innerError) {
            this.logger.warn('Code search alternative query also failed for user:', innerError.message);
            throw innerError;
          }
        } else {
          throw error;
        }
      }

      // Org repos: enumerate orgs and search each sequentially (rate limit = 10/min).
      const { data: orgs } = await octokit.rest.orgs.listForAuthenticatedUser();
      const orgsSearchEmpty = new Set();
      for (const org of orgs) {
        try {
          const orgSearch = await octokit.rest.search.code({
            q: `filename:documental.json org:${org.login}`
          });
          const orgItems = orgSearch.data.items || [];
          if (orgItems.length === 0) {
            orgsSearchEmpty.add(org.login);
          }
          for (const item of orgItems) {
            documentalRepos.add(item.repository.full_name);
          }
        } catch (error) {
          if (error.status === 401) {
            // Fail fast: the token is dead, so every remaining org (and the
            // getContent fallback, which uses the same token) would fail too.
            this.logger.warn('GitHub token expired during org code search');
            return { success: false, error: 'Token expired. Please re-authenticate.' };
          }
          if (error.status === 422) {
            this.logger.warn(`Code search 422 on org qualifier-only query (${org.login}); retrying with literal term`);
            try {
              const orgSearchAlt = await octokit.rest.search.code({
                q: `documental filename:documental.json org:${org.login}`
              });
              const orgItemsAlt = orgSearchAlt.data.items || [];
              if (orgItemsAlt.length === 0) {
                orgsSearchEmpty.add(org.login);
              }
              for (const item of orgItemsAlt) {
                documentalRepos.add(item.repository.full_name);
              }
            } catch (innerError) {
              this.logger.warn(`Code search alternative query failed for org ${org.login}:`, innerError.message);
            }
          } else if (error.status === 403) {
            // PRESERVED (load-bearing): the code-search rate pool (10/min) is
            // exhausted — rethrow so the outer catch switches to the getContent
            // fallback, which draws from the core API pool (5000/hr). Never
            // "continue" the loop on 403.
            throw error;
          } else {
            // 5xx / network / anything else: skip this org, keep scanning.
            skippedOrgs.push(org.login);
            this.logger.warn(`Org code search failed for ${org.login} (status: ${error?.status ?? 'network'}); skipping org:`, error.message);
          }
        }
      }

      // Task 13: verify owners whose search SUCCEEDED with 0 items by
      // probing their repos via getContent (restricted to those owners —
      // owners with ≥1 match are trusted; 5xx-skipped orgs are already
      // surfaced via the skippedOrgs notice and are NOT re-verified here).
      const emptyOwners = [];
      if (userSearchEmpty) {
        emptyOwners.push(user.login);
      }
      for (const org of orgs) {
        if (orgsSearchEmpty.has(org.login)) {
          emptyOwners.push(org.login);
        }
      }

      let verificationRan = false;
      if (emptyOwners.length > 0) {
        this.logger.warn(
          `Code search returned 0 items for [${emptyOwners.join(', ')}] — verifying via getContent (legacy index can miss repos)`
        );
        try {
          const allRepos = await this._enumerateAllRepos(octokit);
          if (allRepos.length > 0) {
            const ownerPrefixes = emptyOwners.map((owner) => `${owner}/`);
            const ownerSubset = allRepos.filter((repo) =>
              ownerPrefixes.some((prefix) => repo.full_name && repo.full_name.startsWith(prefix))
            );
            if (ownerSubset.length > 0) {
              const verification = await this._probeReposForDocumental(octokit, ownerSubset);
              if (!verification.ok) {
                // Same rejection table as the fallback: an INCONCLUSIVE
                // probe (401/403/5xx/network) fails the scan atomically —
                // returning the unverified empty result would silently
                // untag repos (the exact lottery this fixes).
                return { success: false, error: verification.error };
              }
              for (const fullName of verification.found) {
                documentalRepos.add(fullName);
              }
              verificationRan = true;
            }
          }
        } catch (verificationError) {
          if (verificationError.status === 403) {
            return { success: false, error: 'GitHub API rate limit exceeded. Try again later.' };
          }
          this.logger.error('Documental empty-result verification failed:', verificationError);
          return { success: false, error: verificationError.message };
        }
      }

      const payload = { success: true, documentalRepos: Array.from(documentalRepos), skippedOrgs };
      if (verificationRan) {
        // Informational: the renderer does not branch on this.
        payload.fallback = true;
      }
      return payload;
    } catch (error) {
      if (error.status === 403) {
        this.logger.warn('GitHub rate limit hit during code search; attempting getContent fallback');
      } else if (error.status === 401) {
        this.logger.warn('GitHub token expired during documental repo search');
        return { success: false, error: 'GitHub token expired or invalid. Please re-authenticate.' };
      } else {
        this.logger.warn('Code search failed; attempting getContent fallback:', error.message);
      }

      // Fallback: enumerate repos via listForAuthenticatedUser and probe documental.json via getContent.
      try {
        const allRepos = await this._enumerateAllRepos(octokit);
        const fallback = await this._probeReposForDocumental(octokit, allRepos);
        if (!fallback.ok) {
          return { success: false, error: fallback.error };
        }
        return { success: true, documentalRepos: fallback.found, fallback: true, skippedOrgs };
      } catch (fallbackError) {
        if (fallbackError.status === 403) {
          return { success: false, error: 'GitHub API rate limit exceeded. Try again later.' };
        }
        this.logger.error('Documental repo search fallback failed:', fallbackError);
        return { success: false, error: fallbackError.message };
      }
    }
  }

  /**
   * Enumerates the authenticated user's repos with pagination, capped at
   * MAX_REPOS (same parameters as listUserRepos). Shared by the getContent
   * fallback and the empty-search verification path.
   * @param {object} octokit - Authenticated Octokit instance.
   * @returns {Promise<Array<object>>} Raw repo objects (owner.login, name, full_name).
   */
  async _enumerateAllRepos(octokit) {
    const allRepos = [];
    let page = 1;
    const perPage = 100;
    while (allRepos.length < MAX_REPOS) {
      const response = await octokit.repos.listForAuthenticatedUser({
        per_page: perPage,
        page,
        sort: 'updated',
        affiliation: 'owner,collaborator,organization_member'
      });
      if (!response.data || response.data.length === 0) {
        break;
      }
      allRepos.push(...response.data);
      if (response.data.length < perPage) {
        break;
      }
      page++;
    }
    return allRepos;
  }

  /**
   * Probes a set of repos for a documental.json marker via getContent,
   * chunked in groups of 10 to limit concurrency. Shared rejection table:
   * 404 → repo is not Documental (silent); 401/403/5xx/no-status → the
   * probe is INCONCLUSIVE and the scan must fail atomically (returning a
   * partial set would silently untag repos we could not verify).
   * @param {object} octokit - Authenticated Octokit instance.
   * @param {Array<object>} repos - Raw repo objects to probe.
   * @returns {Promise<{ok: true, found: string[]}|{ok: false, error: string}>}
   *   `found` holds the full_names of verified Documental repos; `error`
   *   carries the exact atomic-failure string on inconclusive probes.
   */
  async _probeReposForDocumental(octokit, repos) {
    const found = [];
    // Chunk in groups of 10 to limit concurrency.
    const chunkSize = 10;
    for (let i = 0; i < repos.length; i += chunkSize) {
      const chunk = repos.slice(i, i + chunkSize);
      const results = await Promise.allSettled(
        chunk.map((repo) =>
          octokit.repos.getContent({
            owner: repo.owner.login,
            repo: repo.name,
            path: 'documental.json'
          })
        )
      );
      for (let idx = 0; idx < results.length; idx++) {
        const result = results[idx];
        if (result.status === 'fulfilled') {
          found.push(chunk[idx].full_name);
          continue;
        }
        const reason = result.reason;
        if (reason && reason.status === 404) {
          // documental.json not present → repo is not Documental (silent).
          continue;
        }
        if (reason && reason.status === 401) {
          return { ok: false, error: 'Token expired. Please re-authenticate.' };
        }
        if (reason && reason.status === 403) {
          return { ok: false, error: 'GitHub API rate limit exceeded. Try again later.' };
        }
        const statusLabel = (reason && reason.status) || 'no status';
        const detail = (reason && reason.message) || 'network error';
        return {
          ok: false,
          error: `Documental scan failed while probing repositories (${statusLabel}): ${detail}`
        };
      }
    }
    return { ok: true, found };
  }

  registerHandlers() {
    this.logger.info('Registering GitHub Repos IPC handlers');
    ipcMain.handle('github:list-user-repos', async () => {
      try {
        return await this.listUserRepos();
      } catch (error) {
        this.logger.error('listUserRepos error:', error);
        return { success: false, error: error.message };
      }
    });
    ipcMain.handle('github:find-documental-repos', async () => {
      try {
        // Single-flight: a concurrent invoke joins the in-flight scan instead
        // of starting a duplicate one; both callers receive the same result.
        if (this._documentalScanInFlight) {
          return await this._documentalScanInFlight;
        }
        const scanPromise = this.findDocumentalRepos();
        this._documentalScanInFlight = scanPromise;
        try {
          return await scanPromise;
        } finally {
          if (this._documentalScanInFlight === scanPromise) {
            this._documentalScanInFlight = null;
          }
        }
      } catch (error) {
        this.logger.error('findDocumentalRepos error:', error);
        return { success: false, error: error.message };
      }
    });
    ipcMain.handle('github:list-user-orgs', async () => {
      try {
        const token = await secureTokenService.getToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        const { Octokit } = await _loadOctokit();
        const octokit = new Octokit({ auth: token });
        const { data: user } = await octokit.rest.users.getAuthenticated();
        const { data: orgs } = await octokit.rest.orgs.listForAuthenticatedUser();
        return { success: true, orgs: orgs.map(o => ({ login: o.login, avatar_url: o.avatar_url })), userLogin: user.login };
      } catch (error) {
        this.logger.error('Error listing user orgs:', error);
        return { success: false, error: error.message };
      }
    });
  }

  unregisterHandlers() {
    this.logger.info('Unregistering GitHub Repos IPC handlers');
    ipcMain.removeHandler('github:list-user-repos');
    ipcMain.removeHandler('github:find-documental-repos');
    ipcMain.removeHandler('github:list-user-orgs');
  }
}

module.exports = { GithubReposHandlers, warmUpOctokit: _loadOctokit };
