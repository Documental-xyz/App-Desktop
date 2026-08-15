/**
 * @fileoverview IPC handlers for GitHub repository operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain } = require('electron');
const { secureTokenService } = require('../services/secureTokenService.js');
const { GITHUB_CONFIG } = require('../config/github-config.js');

const MAX_REPOS = 500;

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
      const { Octokit } = await import('@octokit/rest');
      octokit = new Octokit({ auth: token });
    } catch (error) {
      this.logger.error('Error initializing Octokit for repo listing:', error);
      return { success: false, error: 'Failed to initialize GitHub client' };
    }

    const allRepos = [];
    let page = 1;
    const perPage = 100;

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

    return { success: true, repos: allRepos };
  }

  /**
   * Finds all repositories containing a documental.json marker file.
   * Uses GitHub Code Search API for efficiency (1-N calls instead of N calls).
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
      const { Octokit } = await import('@octokit/rest');
      octokit = new Octokit({ auth: token });
    } catch (error) {
      this.logger.error('Error initializing Octokit for documental repo search:', error);
      return { success: false, error: 'Failed to initialize GitHub client' };
    }

    const documentalRepos = new Set();
    const skippedOrgs = [];

    try {
      const { data: user } = await octokit.rest.users.getAuthenticated();

      // Personal repos: search by filename qualifier. Note: space (not +) between qualifiers
      // because octokit encodes '+' as %2B; literal space becomes '+' in the URL query.
      try {
        const userSearch = await octokit.rest.search.code({
          q: `filename:documental.json user:${user.login}`
        });
        for (const item of userSearch.data.items) {
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
            for (const item of userSearchAlt.data.items) {
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
      for (const org of orgs) {
        try {
          const orgSearch = await octokit.rest.search.code({
            q: `filename:documental.json org:${org.login}`
          });
          for (const item of orgSearch.data.items) {
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
              for (const item of orgSearchAlt.data.items) {
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

      return { success: true, documentalRepos: Array.from(documentalRepos), skippedOrgs };
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

        const fallbackRepos = new Set();
        // Chunk in groups of 10 to limit concurrency.
        const chunkSize = 10;
        for (let i = 0; i < allRepos.length; i += chunkSize) {
          const chunk = allRepos.slice(i, i + chunkSize);
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
              fallbackRepos.add(chunk[idx].full_name);
              continue;
            }
            const reason = result.reason;
            if (reason && reason.status === 404) {
              // documental.json not present → repo is not Documental (silent).
              continue;
            }
            // 401/403/5xx/no-status (network): the probe is INCONCLUSIVE, not
            // negative. Fail the whole scan atomically — returning a partial
            // set would silently untag repos we could not verify.
            if (reason && reason.status === 401) {
              return {
                success: false,
                error: 'Token expired. Please re-authenticate.'
              };
            }
            if (reason && reason.status === 403) {
              return {
                success: false,
                error: 'GitHub API rate limit exceeded. Try again later.'
              };
            }
            const statusLabel = (reason && reason.status) || 'no status';
            const detail = (reason && reason.message) || 'network error';
            return {
              success: false,
              error: `Documental scan failed while probing repositories (${statusLabel}): ${detail}`
            };
          }
        }

        return { success: true, documentalRepos: Array.from(fallbackRepos), fallback: true, skippedOrgs };
      } catch (fallbackError) {
        if (fallbackError.status === 403) {
          return { success: false, error: 'GitHub API rate limit exceeded. Try again later.' };
        }
        this.logger.error('Documental repo search fallback failed:', fallbackError);
        return { success: false, error: fallbackError.message };
      }
    }
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
        const { Octokit } = await import('@octokit/rest');
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

module.exports = { GithubReposHandlers };
