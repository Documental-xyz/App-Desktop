/**
 * @fileoverview IPC handlers for GitHub repository operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain } = require('electron');
const { secureTokenService } = require('../services/secureTokenService.js');

const MAX_REPOS = 500;

class GithubReposHandlers {
  constructor({ logger }) {
    this.logger = logger;
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
          affiliation: 'owner,collaborator'
        });

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
  }

  unregisterHandlers() {
    this.logger.info('Unregistering GitHub Repos IPC handlers');
    ipcMain.removeHandler('github:list-user-repos');
  }
}

module.exports = { GithubReposHandlers };
