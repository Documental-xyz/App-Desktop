/**
 * @fileoverview IPC handlers for project management operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const { secureTokenService } = require('../services/secureTokenService.js');

/**
 * @typedef {Object} ProjectDetails
 * @property {string} projectName - Project name
 * @property {string} repoUrl - Repository URL
 * @property {string} projectPath - Project path
 * @property {string} repoFolderName - Repository folder name
 */

/**
 * @typedef {Object} FolderInfo
 * @property {boolean} isEmpty - Whether folder is empty
 * @property {boolean} isGitRepo - Whether folder is a git repository
 * @property {string|null} remoteUrl - Git remote URL if applicable
 * @property {number} fileCount - Number of files in folder
 */

/**
 * @typedef {Object} ProjectExistsResult
 * @property {boolean} exists - Whether project exists
 * @property {string|null} projectId - Project ID if exists
 * @property {FolderInfo|null} folderInfo - Folder info if doesn't exist
 */

/**
 * Get GitHub token from secure storage
 * @returns {Promise<string|null>} GitHub token or null
 */
async function getGitHubToken() {
  try {
    return await secureTokenService.getToken();
  } catch (error) {
    console.error('Error getting GitHub token:', error);
    return null;
  }
}

/**
 * Clone repository using isomorphic-git
 * @param {string} url - Repository URL
 * @param {string} dir - Target directory
 * @param {Object} options - Additional options
 * @returns {Promise<boolean>} Success status
 */
async function gitClone(url, dir, options = {}) {
  try {
    console.log(`🔄 Cloning repository from ${url} to ${dir}`);
    
    const token = await getGitHubToken();
    const auth = token ? { username: token, password: 'x-oauth-basic' } : undefined;
    
    await git.clone({
      fs,
      http,
      dir,
      url,
      auth,
      ...options,
      singleBranch: true,
      depth: 10
    });
    
    console.log(`✅ Repository cloned successfully to ${dir}`);
    return true;
  } catch (error) {
    console.error(`❌ Error cloning repository:`, error);
    throw error;
  }
}

/**
 * Project Management IPC Handlers
 */
class ProjectHandlers {
  /**
   * Create an instance of ProjectHandlers
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.databaseManager - Database manager instance
   * @param {Object} dependencies.projectService - Project service instance
   */
  constructor({ logger, databaseManager, projectService }) {
    this.logger = logger;
    this.databaseManager = databaseManager;
    this.projectService = projectService;
  }

  /**
   * Get project details by ID
   * @param {number} projectId - Project ID
   * @returns {Promise<ProjectDetails>} Project details
   */
  async getProjectDetails(projectId) {
    try {
      const db = await this.databaseManager.getDatabase();
      
      return new Promise((resolve, reject) => {
        const self = this; // Preserve reference to the class
        db.get(
          `SELECT projectName, repoUrl, projectPath, repoFolderName FROM projects WHERE id = ?`,
          [projectId],
          (err, row) => {
            if (err) {
              self.logger.error('Error getting project details:', err.message);
              reject(err.message);
            } else if (row) {
              resolve(row);
            } else {
              reject('Project not found');
            }
          }
        );
      });
    } catch (error) {
      this.logger.error('Error in getProjectDetails:', error);
      throw error;
    }
  }

  /**
   * Get recent projects (last 3)
   * @returns {Promise<Array>} Recent projects list
   */
  async getRecentProjects() {
    try {
      const db = await this.databaseManager.getDatabase();
      
      return new Promise((resolve, reject) => {
        const self = this; // Preserve reference to the class
        db.all(
          `SELECT id, projectName, projectPath, repoFolderName FROM projects ORDER BY createdAt DESC LIMIT 3`,
          (err, rows) => {
            if (err) {
              self.logger.error('Error getting recent projects:', err.message);
              reject(err.message);
            } else {
              resolve(rows);
            }
          }
        );
      });
    } catch (error) {
      this.logger.error('Error in getRecentProjects:', error);
      throw error;
    }
  }

  /**
   * Get all projects
   * @returns {Promise<Array>} All projects list
   */
  async getAllProjects() {
    try {
      this.logger.info('Getting all projects from database...');
      const db = await this.databaseManager.getDatabase();
      
      return new Promise((resolve, reject) => {
        const self = this; // Preserve reference to the class
        db.all(
          `SELECT id, projectName, projectPath, repoFolderName, createdAt FROM projects ORDER BY createdAt DESC`,
          (err, rows) => {
            if (err) {
              self.logger.error('Error getting all projects:', err.message);
              reject(err.message);
            } else {
              self.logger.info(`Found ${rows.length} projects`);
              resolve(rows);
            }
          }
        );
      });
    } catch (error) {
      this.logger.error('Error in getAllProjects:', error);
      throw error;
    }
  }

  /**
   * Check if project exists for given folder path
   * @param {string} folderPath - Folder path to check
   * @returns {Promise<ProjectExistsResult>} Project existence result
   */
  async checkProjectExists(folderPath) {
    try {
      // Check if folder exists
      if (!fs.existsSync(folderPath)) {
        throw new Error('Pasta não encontrada');
      }

      // Check if this path matches any existing project
      const db = await this.databaseManager.getDatabase();
      
      return new Promise((resolve, reject) => {
        db.all(`SELECT id, projectName, projectPath, repoFolderName FROM projects`, async (err, rows) => {
          if (err) {
            reject(err.message);
            return;
          }

          let matchingProject = null;
          for (const project of rows) {
            const fullProjectPath = path.join(project.projectPath, project.repoFolderName || '');
            if (fullProjectPath === folderPath) {
              matchingProject = project;
              break;
            }
          }

          if (matchingProject) {
            resolve({ exists: true, projectId: matchingProject.id });
          } else {
            // Get folder info
            try {
              const folderInfo = await this.getFolderInfo(folderPath);
              resolve({ exists: false, folderInfo });
            } catch (error) {
              reject(error.message);
            }
          }
        });
      });
    } catch (error) {
      this.logger.error('Error in checkProjectExists:', error);
      throw error;
    }
  }

  /**
   * Get folder information
   * @param {string} folderPath - Folder path
   * @returns {Promise<FolderInfo>} Folder information
   */
  async getFolderInfo(folderPath) {
    try {
      if (!fs.existsSync(folderPath)) {
        throw new Error('Pasta não encontrada');
      }

      const stats = fs.statSync(folderPath);
      if (!stats.isDirectory()) {
        throw new Error('Caminho não é uma pasta');
      }

      const files = fs.readdirSync(folderPath);
      const isEmpty = files.length === 0;

      let isGitRepo = false;
      let remoteUrl = null;

      // Check if it's a git repository
      const gitPath = path.join(folderPath, '.git');
      if (fs.existsSync(gitPath)) {
        isGitRepo = true;
        try {
          // Get remote URL using isomorphic-git
          remoteUrl = await git.getConfig({
            fs,
            dir: folderPath,
            path: 'remote.origin.url'
          });
        } catch (error) {
          this.logger.debug('Could not get git remote URL:', error.message);
        }
      }

      return {
        isEmpty,
        isGitRepo,
        remoteUrl,
        fileCount: files.length
      };
    } catch (error) {
      throw new Error(`Erro ao analisar pasta: ${error.message}`);
    }
  }

  /**
   * Save project to database
   * @param {Object} projectData - Project data
   * @returns {Promise<number>} Project ID
   */
  async saveProject(projectData) {
    try {
      const { projectName, repoUrl, projectPath } = projectData;
      const db = await this.databaseManager.getDatabase();
      
      return new Promise((resolve, reject) => {
        const self = this; // Preserve reference to the class
        db.run(
          `INSERT INTO projects (projectName, repoUrl, projectPath, repoFolderName) VALUES (?, ?, ?, ?)`,
          [projectName, repoUrl, projectPath, null], // repoFolderName is null initially
          function (err) {
            if (err) {
              self.logger.error('Error saving project:', err.message);
              reject(err.message);
            } else {
              self.logger.info(`Project inserted with rowid ${this.lastID}`);
              resolve(this.lastID);
            }
          }
        );
      });
    } catch (error) {
      this.logger.error('Error in saveProject:', error);
      throw error;
    }
  }

  /**
   * Update repo folder name in database
   * @param {number} projectId - Project ID
   * @param {string} folderName - Folder name
   * @returns {Promise<void>}
   */
  async updateRepoFolderName(projectId, folderName) {
    try {
      const db = await this.databaseManager.getDatabase();
      
      return new Promise((resolve, reject) => {
        const self = this; // Preserve reference to class
        db.run(`UPDATE projects SET repoFolderName = ? WHERE id = ?`, [folderName, projectId], function (err) {
          if (err) {
            self.logger.error('Error updating repoFolderName:', err.message);
            reject(err.message);
          } else {
            self.logger.info(`repoFolderName updated for project ${projectId}`);
            resolve();
          }
        });
      });
    } catch (error) {
      this.logger.error('Error in updateRepoFolderName:', error);
      throw error;
    }
  }

  /**
   * Remove project from database
   * @param {number} projectId - Project ID to remove
   * @returns {Promise<boolean>} Success status
   */
  async removeProject(projectId) {
    try {
      const db = await this.databaseManager.getDatabase();
      
      return new Promise((resolve, reject) => {
        const self = this; // Preserve reference to the class
        db.run(`DELETE FROM projects WHERE id = ?`, [projectId], function (err) {
          if (err) {
            self.logger.error('Error removing project:', err.message);
            reject(err.message);
          } else {
            self.logger.info(`Project ${projectId} removed successfully`);
            resolve(true);
          }
        });
      });
    } catch (error) {
      this.logger.error('Error in removeProject:', error);
      throw error;
    }
  }

  /**
   * Register all project management IPC handlers
   */
  registerHandlers() {
    this.logger.info('📁 Registering project management IPC handlers');

    /**
     * Get project details
     */
    ipcMain.handle('get-project-details', async (event, projectId) => {
      try {
        return await this.getProjectDetails(projectId);
      } catch (error) {
        this.logger.error('Error in get-project-details handler:', error);
        throw error;
      }
    });

    /**
     * Get recent projects
     */
    ipcMain.handle('get-recent-projects', async () => {
      try {
        return await this.getRecentProjects();
      } catch (error) {
        this.logger.error('Error in get-recent-projects handler:', error);
        throw error;
      }
    });

    /**
     * Get all projects
     */
    ipcMain.handle('getAllProjects', async () => {
      try {
        return await this.getAllProjects();
      } catch (error) {
        this.logger.error('Error in getAllProjects handler:', error);
        throw error;
      }
    });

    /**
     * Check if project exists
     */
    ipcMain.handle('checkProjectExists', async (event, folderPath) => {
      try {
        return await this.checkProjectExists(folderPath);
      } catch (error) {
        this.logger.error('Error in checkProjectExists handler:', error);
        throw error;
      }
    });

    /**
     * Get folder information
     */
    ipcMain.handle('getFolderInfo', async (event, folderPath) => {
      try {
        return await this.getFolderInfo(folderPath);
      } catch (error) {
        this.logger.error('Error in getFolderInfo handler:', error);
        throw error;
      }
    });

    /**
     * Save project
     */
    ipcMain.handle('save-project', async (event, projectData) => {
      try {
        return await this.saveProject(projectData);
      } catch (error) {
        this.logger.error('Error in save-project handler:', error);
        throw error;
      }
    });

    /**
     * Remove project
     */
    ipcMain.handle('remove-project', async (event, projectId) => {
      try {
        return await this.removeProject(projectId);
      } catch (error) {
        this.logger.error('Error in remove-project handler:', error);
        throw error;
      }
    });



    this.logger.info('✅ Project management IPC handlers registered');
  }

  /**
   * Unregister all project management IPC handlers
   */
  unregisterHandlers() {
    this.logger.info('📁 Unregistering project management IPC handlers');
    
    ipcMain.removeHandler('get-project-details');
    ipcMain.removeHandler('get-recent-projects');
    ipcMain.removeHandler('getAllProjects');
    ipcMain.removeHandler('checkProjectExists');
    ipcMain.removeHandler('getFolderInfo');
    ipcMain.removeHandler('save-project');
    ipcMain.removeHandler('remove-project');
    
    this.logger.info('✅ Project management IPC handlers unregistered');
  }
}

module.exports = { ProjectHandlers };