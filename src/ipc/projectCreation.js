/**
 * @fileoverview Complete project creation handler
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { GitOperations } = require('./gitOperations.js');
const { ProcessManager } = require('./processManager.js');

/**
 * Project Creation Handler Class
 */
class ProjectCreationHandler {
  /**
   * Create an instance of ProjectCreationHandler
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.databaseManager - Database manager instance
   * @param {Object} dependencies.nodeDetectionService - Node.js detection service
   */
  constructor({ logger, databaseManager, nodeDetectionService }) {
    this.logger = logger;
    this.databaseManager = databaseManager;
    this.nodeDetectionService = nodeDetectionService;
    this.gitOps = new GitOperations({ logger, databaseManager });
    this.processManager = new ProcessManager({ logger, nodeDetectionService });
  }

  /**
   * Check if directory has partial .git (config without HEAD)
   * @param {string} dir - Directory to check
   * @returns {Promise<boolean>} Whether directory has partial .git
   */
  async hasPartialGit(dir) {
    try {
      const gitDir = path.join(dir, '.git');
      if (!fs.existsSync(gitDir)) {
        return false;
      }

      // Check for essential git files
      const headPath = path.join(gitDir, 'HEAD');
      const configPath = path.join(gitDir, 'config');
      
      const hasConfig = fs.existsSync(configPath);
      const hasHead = fs.existsSync(headPath);
      
      // If config exists but no HEAD, it's likely a partial git setup
      return hasConfig && !hasHead;
    } catch (error) {
      this.logger.warn('Error checking for partial git:', error);
      return false;
    }
  }

  /**
   * Clean partial .git directory
   * @param {string} dir - Directory to clean
   * @returns {Promise<void>}
   */
  async cleanPartialGit(dir) {
    try {
      const gitDir = path.join(dir, '.git');
      if (fs.existsSync(gitDir)) {
        this.logger.info(`🧹 Cleaning partial .git directory: ${gitDir}`);
        
        // Simple recursive removal
        const { execSync } = require('child_process');
        const isWindows = process.platform === 'win32';
        const rmCommand = isWindows ? 'rmdir /s /q' : 'rm -rf';
        
        try {
          execSync(`${rmCommand} "${gitDir}"`, { stdio: 'ignore' });
        } catch (execError) {
          // Fallback to manual removal if command fails
          const removeRecursive = (dirPath) => {
            if (fs.existsSync(dirPath)) {
              const files = fs.readdirSync(dirPath);
              for (const file of files) {
                const curPath = path.join(dirPath, file);
                const stat = fs.lstatSync(curPath);
                if (stat.isDirectory()) {
                  removeRecursive(curPath);
                } else {
                  fs.unlinkSync(curPath);
                }
              }
              fs.rmdirSync(dirPath);
            }
          };
          removeRecursive(gitDir);
        }
        
        this.logger.info('✅ Partial .git directory cleaned');
      }
    } catch (error) {
      this.logger.error('Error cleaning partial git:', error);
      throw error;
    }
  }

  /**
   * Clone repository
   * @param {string} url - Repository URL
   * @param {string} dir - Directory to clone into
   * @param {Function} sendOutput - Output function
   * @returns {Promise<void>}
   */
  async gitClone(url, dir, sendOutput) {
    try {
      this.logger.info(`Cloning repository from ${url} to ${dir}`);
      
      // Check for and clean partial .git before cloning
      if (await this.hasPartialGit(dir)) {
        sendOutput('🧹 Found partial git setup, cleaning before clone...\n');
        await this.cleanPartialGit(dir);
      }
      
      const isGithubUrl = /^https:\/\/github\.com\//i.test(url);
      const token = isGithubUrl ? await this.gitOps.getGitHubToken() : null;
      const auth = token ? { username: token, password: 'x-oauth-basic' } : undefined;
      if (!isGithubUrl) {
        this.logger.warn('Clone URL is not a GitHub URL — proceeding without token auth');
        sendOutput('⚠️ URL não é github.com — clone sem credenciais OAuth\n');
      }
      
      const git = require('isomorphic-git');
      const http = require('isomorphic-git/http/node');
      
      await git.clone({
        fs: require('fs'),
        http,
        dir,
        url,
        auth,
        singleBranch: true,
        depth: 10
      });
      
      this.logger.info(`Repository cloned successfully to ${dir}`);
      return true;
    } catch (error) {
      this.logger.error(`Error cloning repository:`, error);
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
   * Retrieve repository folder name from database
   * @param {number} projectId - Project ID
   * @returns {Promise<string|null>} Folder name or null if not stored
   */
  async getRepoFolderName(projectId) {
    try {
      const db = await this.databaseManager.getDatabase();
      return new Promise((resolve, reject) => {
        db.get('SELECT repoFolderName FROM projects WHERE id = ?', [projectId], (err, row) => {
          if (err) {
            this.logger.error('Error fetching repoFolderName:', err.message);
            reject(err);
          } else {
            resolve(row ? row.repoFolderName : null);
          }
        });
      });
    } catch (error) {
      this.logger.error('Error in getRepoFolderName:', error);
      throw error;
    }
  }

  /**
   * Determine repository directory information before running commands
   * @param {string} projectPath - Base project path
   * @param {string} repoUrl - Repository URL
   * @param {boolean} isExistingGitRepo - Whether using an existing repo
   * @param {boolean} isEmptyFolder - Whether cloning into an empty folder
   * @returns {{ repoDirPath: string, repoFolderName: string, shouldClone: boolean }}
   */
  determineRepositoryTarget(projectPath, repoUrl, isExistingGitRepo, isEmptyFolder) {
    const ensureDirectory = (targetPath) => {
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
      }
    };

    if (!fs.existsSync(projectPath)) {
      ensureDirectory(projectPath);
    }

    if (isExistingGitRepo) {
      return {
        repoDirPath: projectPath,
        repoFolderName: path.basename(projectPath),
        shouldClone: false
      };
    }

    if (isEmptyFolder) {
      return {
        repoDirPath: projectPath,
        repoFolderName: path.basename(projectPath),
        shouldClone: true
      };
    }

    const fallbackName = 'documental-project';
    const repoName = repoUrl ? repoUrl.split('/').pop().replace('.git', '') : fallbackName;
    let finalRepoFolderName = repoName || fallbackName;
    let counter = 0;
    while (fs.existsSync(path.join(projectPath, finalRepoFolderName))) {
      counter += 1;
      finalRepoFolderName = `${repoName}-${counter}`;
    }

    const repoDirPath = path.join(projectPath, finalRepoFolderName);
    ensureDirectory(repoDirPath);

    return {
      repoDirPath,
      repoFolderName: finalRepoFolderName,
      shouldClone: true
    };
  }


  /**
   * Start complete project creation process
   * @param {number} projectId - Project ID
   * @param {string} projectPath - Project path
   * @param {string} repoUrl - Repository URL
   * @param {boolean} isExistingGitRepo - Whether it's an existing git repo
   * @param {boolean} isEmptyFolder - Whether it's an empty folder
   * @returns {Promise<Object>} Result object
   */
  async startProjectCreation(projectId, projectPath, repoUrl, isExistingGitRepo = false, isEmptyFolder = false, shouldForkFirst = false) {
    try {
      this.logger.info('Starting complete project creation:', { projectId, projectPath, repoUrl, isExistingGitRepo, isEmptyFolder });
      
      const broadcastToWindows = (channel, payload) => {
        const normalizedPayload = typeof payload === 'object' && payload !== null
          ? payload
          : { message: String(payload) };

        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send(channel, normalizedPayload);
          }
        });
      };

      const sendOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('command-output', payload);
      };

      const sendServerOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('server-output', payload);
      };

      const sendStatus = (stepOrPayload, maybeStatus) => {
        let payload;
        if (typeof maybeStatus === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { status: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, status: maybeStatus };
        }
        broadcastToWindows('command-status', payload);
      };

      const getStepOutput = (stepId) => (message) => sendOutput(stepId, message);
      const getStepServerOutput = (stepId) => (message) => sendServerOutput(stepId, message);
      const getStepStatusSender = (stepId) => (status) => sendStatus(stepId, status);

      if (shouldForkFirst) {
        const step0Output = getStepOutput(0);
        const step0Status = getStepStatusSender(0);

        step0Output('🍴 Creating fork...\n');
        step0Status('active');

        const forkMatch = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/i);
        if (!forkMatch) {
          step0Output('❌ Invalid GitHub URL for fork\n');
          step0Status('failure');
          throw new Error('Invalid GitHub URL for fork: ' + repoUrl);
        }

        const [, forkOwner, forkRepo] = forkMatch;
        const { githubForkService } = require('../services/githubForkService.js');

        try {
          const result = await githubForkService.forkAndPoll(forkOwner, forkRepo, step0Output);
          if (result.success) {
            repoUrl = result.forkCloneUrl;
            step0Output('✅ Fork ready\n');
            step0Status('success');
          }
        } catch (error) {
          step0Output('❌ Fork failed: ' + error.message + '\n');
          step0Status('failure');
          throw error;
        }
      }

      const { repoDirPath, repoFolderName, shouldClone } = this.determineRepositoryTarget(
        projectPath,
        repoUrl,
        isExistingGitRepo,
        isEmptyFolder
      );

      const step1Output = getStepOutput(1);
      const step2Output = getStepOutput(2);
      const step3Output = getStepOutput(3);
      const step4Output = getStepOutput(4);
      const step5ServerOutput = getStepServerOutput(5);
      const step1Status = getStepStatusSender(1);
      const step2Status = getStepStatusSender(2);
      const step3Status = getStepStatusSender(3);
      const step4Status = getStepStatusSender(4);
      const step5Status = getStepStatusSender(5);

      if (repoFolderName) {
        await this.updateRepoFolderName(projectId, repoFolderName);
      }

      if (isExistingGitRepo) {
        step1Output(`📁 Using existing repository at ${repoDirPath}\n`);
        
        // Configure git user for existing repos
        step1Output('🔧 Configuring git user for existing repository...\n');
        try {
          const configured = await this.gitOps.configureGitForUser(repoDirPath);
          if (configured) {
            step1Output('✅ Git user configured successfully.\n');
          } else {
            step1Output('⚠️ Could not configure git user, using default configuration.\n');
            step1Output('💡 This may happen if:\n');
            step1Output('   • No GitHub authentication is set up\n');
            step1Output('   • No internet connection is available\n');
            step1Output('   • GitHub API is temporarily unavailable\n');
          }
        } catch (error) {
          step1Output(`⚠️ Warning: Could not configure git user: ${error.message}\n`);
          step1Output('💡 Git operations will use system default configuration\n');
        }
        
        step1Status('success');
        await this.processManager.delay(3000);
      } else {
        // For new repos: clone first, then configure git user
        const cloneMessage = isEmptyFolder
          ? '📥 Cloning repository directly into selected folder...\n'
          : '📥 Cloning repository...\n';
        step1Output(cloneMessage);

        if (shouldClone) {
          try {
            await this.gitClone(repoUrl, repoDirPath, step1Output);
            step1Output(`✅ Repository cloned into ${repoDirPath}\n`);
            
            // Now configure git user in the cloned repository
            step1Output('🔧 Configuring git user for cloned repository...\n');
            try {
              const configured = await this.gitOps.configureGitForUser(repoDirPath);
              if (configured) {
                step1Output('✅ Git user configured successfully.\n');
              } else {
                step1Output('⚠️ Could not configure git user, using default configuration.\n');
                step1Output('💡 This may happen if:\n');
                step1Output('   • No GitHub authentication is set up\n');
                step1Output('   • No internet connection is available\n');
                step1Output('   • GitHub API is temporarily unavailable\n');
              }
            } catch (error) {
              step1Output(`⚠️ Warning: Could not configure git user: ${error.message}\n`);
              step1Output('💡 Git operations will use system default configuration\n');
            }
            
            step1Status('success');
          } catch (error) {
            step1Output(`❌ Error cloning repository: ${error.message}\n`);
            throw error;
          }
        } else {
          step1Status('success');
        }

        await this.processManager.delay(3000);
      }


      // Step 2: ensure preview branch exists and checkout it (skip if existing git repo)
      if (!isExistingGitRepo) {
        step2Output('🔍 Verificando e garantindo branch preview...\n');
        try {
          await this.gitOps.gitEnsurePreviewBranch(repoDirPath, step2Output);
          step2Output('✅ Preview branch checked out.\n');
          step2Status('success');
        } catch (error) {
          step2Output(`❌ Error checking out preview branch: ${error.message}\n`);
          // Don't throw error for checkout failure, continue with setup
          step2Status('success');
        }
        await this.processManager.delay(3000);
      } else {
        step2Output('⏭️ Skipping checkout for existing repository.\n');
        step2Status('success');
        await this.processManager.delay(3000);
      }

      // Step 3: npm install
      step3Output('📦 Installing dependencies...\n');
      try {
        await this.processManager.executeCommand('npm', ['install'], repoDirPath, projectId, step3Output);
        step3Output('✅ Dependencies installed.\n');
        step3Status('success');
      } catch (error) {
        step3Output(`❌ Error installing dependencies: ${error.message}\n`);
        throw error;
      }
      await this.processManager.delay(3000);

      // Step 4: npm run build
      step4Output('🔨 Building project...\n');
      try {
        await this.processManager.executeCommand('npm', ['run', 'build'], repoDirPath, `build-${projectId}`, step4Output);
        step4Output('✅ Project built.\n');
        step4Status('success');
      } catch (error) {
        step4Output(`❌ Error building project: ${error.message}\n`);
        throw error;
      }
      await this.processManager.delay(3000);

      // Step 5: npm run dev (keep in background)
      step5ServerOutput('🚀 Starting development server...\n');
      try {
        await this.processManager.startDevServer(repoDirPath, projectId, step5ServerOutput, step5Status);
      } catch (error) {
        step5ServerOutput(`❌ Error starting development server: ${error.message}\n`);
        throw error;
      }

      


      return { success: true };
      
    } catch (error) {
      this.logger.error('Error in start-project-creation handler:', error);
      throw error;
    }
  }

  /**
   * Open project with preview branch check and dev server only
   * @param {number} projectId - Project ID
   * @param {string} projectPath - Project path
   * @param {string} repoUrl - Repository URL
   * @param {string} repoFolderName - Repository folder name
   * @returns {Promise<Object>} Result object
   */
  async openProjectOnlyPreviewAndServer(projectId, projectPath, repoUrl, repoFolderName) {
    try {
      this.logger.info('Opening project with preview and server only:', { projectId, projectPath, repoUrl, repoFolderName });
      
      const broadcastToWindows = (channel, payload) => {
        const normalizedPayload = typeof payload === 'object' && payload !== null
          ? payload
          : { message: String(payload) };

        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send(channel, normalizedPayload);
          }
        });
      };

      const sendOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('command-output', payload);
      };

      const sendServerOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('server-output', payload);
      };

      const sendStatus = (stepOrPayload, maybeStatus) => {
        let payload;
        if (typeof maybeStatus === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { status: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, status: maybeStatus };
        }
        broadcastToWindows('command-status', payload);
      };

      const step2Output = (message) => sendOutput(2, message);
      const step2Status = (status) => sendStatus(2, status);
      const step5ServerOutput = (message) => sendServerOutput(5, message);
      const step5Status = (status) => sendStatus(5, status);

      // For empty folders that were cloned directly, repoFolderName might be folder name itself
      let repoDirPath;
      if (repoFolderName && fs.existsSync(path.join(projectPath, repoFolderName))) {
        repoDirPath = path.join(projectPath, repoFolderName);
      } else {
        // Check if projectPath itself is repo (for empty folder case)
        if (fs.existsSync(path.join(projectPath, '.git'))) {
          repoDirPath = projectPath;
        } else {
          throw new Error('Repository folder not found');
        }
      }

      // Step 2: ensure preview branch exists and checkout it
      step2Output('🔍 Verificando e garantindo branch preview...\n');
      try {
        await this.gitOps.gitEnsurePreviewBranch(repoDirPath, step2Output);
        step2Output('✅ Branch preview verificada.\n');
        step2Status('success');
      } catch (error) {
        step2Output(`❌ Erro ao verificar branch preview: ${error.message}\n`);
        // Don't throw error for checkout failure, continue with setup
        step2Status('success');
      }
      await this.processManager.delay(3000);

      // Step 5: npm run dev (keep in background)
      step5ServerOutput('🚀 Executando servidor do modo dev...\n');
      try {
        await this.processManager.startDevServer(repoDirPath, projectId, step5ServerOutput, step5Status);
      } catch (error) {
        step5ServerOutput(`❌ Erro ao iniciar servidor de desenvolvimento: ${error.message}\n`);
        throw error;
      }

      return { success: true };
      
    } catch (error) {
      this.logger.error('Error in open-project-only-preview-and-server handler:', error);
      throw error;
    }
  }

  /**
   * Reopen existing project
   * @param {number} projectId - Project ID
   * @param {string} projectPath - Project path
   * @param {string} repoUrl - Repository URL
   * @param {string} repoFolderName - Repository folder name
   * @returns {Promise<Object>} Result object
   */
  async reopenProject(projectId, projectPath, repoUrl, repoFolderName) {
    try {
      this.logger.info('Reopening project:', { projectId, projectPath, repoUrl, repoFolderName });
      
      const broadcastToWindows = (channel, payload) => {
        const normalizedPayload = typeof payload === 'object' && payload !== null
          ? payload
          : { message: String(payload) };

        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send(channel, normalizedPayload);
          }
        });
      };

      const sendOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('command-output', payload);
      };

      const sendServerOutput = (stepOrPayload, maybeMessage) => {
        let payload;
        if (typeof maybeMessage === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { message: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, message: maybeMessage };
        }
        broadcastToWindows('server-output', payload);
      };

      const sendStatus = (stepOrPayload, maybeStatus) => {
        let payload;
        if (typeof maybeStatus === 'undefined') {
          if (typeof stepOrPayload === 'object' && stepOrPayload !== null) {
            payload = stepOrPayload;
          } else {
            payload = { status: String(stepOrPayload) };
          }
        } else {
          payload = { stepId: stepOrPayload, status: maybeStatus };
        }
        broadcastToWindows('command-status', payload);
      };

      const step4Output = (message) => sendOutput(4, message);
      const step4Status = (status) => sendStatus(4, status);
      const step5ServerOutput = (message) => sendServerOutput(5, message);
      const step5Status = (status) => sendStatus(5, status);

      // For empty folders that were cloned directly, repoFolderName might be folder name itself
      let repoDirPath;
      if (repoFolderName && fs.existsSync(path.join(projectPath, repoFolderName))) {
        repoDirPath = path.join(projectPath, repoFolderName);
      } else {
        // Check if projectPath itself is repo (for empty folder case)
        if (fs.existsSync(path.join(projectPath, '.git'))) {
          repoDirPath = projectPath;
        } else {
          throw new Error('Repository folder not found');
        }
      }

      // Step 4: npm run build
      step4Output('🔨 Building project...\n');
      try {
        await this.processManager.executeCommand('npm', ['run', 'build'], repoDirPath, `reopen-${projectId}`, step4Output);
        step4Output('✅ Project built.\n');
        step4Status('success');
      } catch (error) {
        step4Output(`❌ Error building project: ${error.message}\n`);
        throw error;
      }
      await this.processManager.delay(3000);

      // Step5: npm run dev (keep in background)
      step5ServerOutput('🚀 Starting development server...\n');
      try {
        await this.processManager.startDevServer(repoDirPath, projectId, step5ServerOutput, step5Status);
      } catch (error) {
        step5ServerOutput(`❌ Error starting development server: ${error.message}\n`);
        throw error;
      }

      return { success: true };
      
    } catch (error) {
      this.logger.error('Error in reopen-project handler:', error);
      throw error;
    }
  }

  /**
   * Cancel project creation
   * @param {number} projectId - Project ID
   * @param {string} projectPath - Project path
   * @param {string} repoFolderName - Repository folder name
   * @returns {Promise<void>}
   */
  async cancelProjectCreation(projectId, projectPath, repoFolderName, shouldDeleteFiles = false) {
    try {
      const resolvedFolderName = repoFolderName || await this.getRepoFolderName(projectId);
      this.logger.info('Canceling project creation:', { projectId, projectPath, repoFolderName: resolvedFolderName, shouldDeleteFiles });
      
      const sendOutput = (output) => {
        // Send to all windows for synchronization
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send('command-output', output);
          }
        });
      };

      await this.processManager.cancelProjectCreation(
        projectId,
        projectPath,
        resolvedFolderName,
        shouldDeleteFiles,
        sendOutput
      );
      
    } catch (error) {
      this.logger.error('Error in cancel-project-creation handler:', error);
      throw error;
    }
  }


  /**
   * Get dev server URL from main process
   * @returns {string|null} Dev server URL
   */
  getDevServerUrl() {
    return this.processManager.getGlobalDevServerUrl();
  }

  /**
   * Register all project creation IPC handlers
   */
  registerHandlers() {
    this.logger.info('🚀 Registering project creation IPC handlers');

    /**
     * Start complete project creation
     */
    ipcMain.handle('start-project-creation', async (event, projectId, projectPath, repoUrl, isExistingGitRepo = false, isEmptyFolder = false, shouldForkFirst = false) => {
      try {
        return await this.startProjectCreation(projectId, projectPath, repoUrl, isExistingGitRepo, isEmptyFolder, shouldForkFirst);
      } catch (error) {
        this.logger.error('Error in start-project-creation handler:', error);
        throw error;
      }
    });

    /**
     * Open project with preview branch check and dev server only
     */
    ipcMain.handle('open-project-only-preview-and-server', async (event, projectId, projectPath, repoUrl, repoFolderName) => {
      try {
        return await this.openProjectOnlyPreviewAndServer(projectId, projectPath, repoUrl, repoFolderName);
      } catch (error) {
        this.logger.error('Error in open-project-only-preview-and-server handler:', error);
        throw error;
      }
    });

    /**
     * Reopen existing project
     */
    ipcMain.handle('reopen-project', async (event, projectId, projectPath, repoUrl, repoFolderName) => {
      try {
        return await this.reopenProject(projectId, projectPath, repoUrl, repoFolderName);
      } catch (error) {
        this.logger.error('Error in reopen-project handler:', error);
        throw error;
      }
    });

    /**
     * Cancel project creation
     */
    ipcMain.handle('cancel-project-creation', async (event, projectId, projectPath, repoFolderName, shouldDeleteFiles = false) => {
      try {
        return await this.cancelProjectCreation(projectId, projectPath, repoFolderName, shouldDeleteFiles);
      } catch (error) {
        this.logger.error('Error in cancel-project-creation handler:', error);
        throw error;
      }
    });




    this.logger.info('✅ Project creation IPC handlers registered');
  }

  /**
   * Unregister all project creation IPC handlers
   */
  unregisterHandlers() {
    this.logger.info('🚀 Unregistering project creation IPC handlers');
    
    ipcMain.removeHandler('start-project-creation');
    ipcMain.removeHandler('open-project-only-preview-and-server');
    ipcMain.removeHandler('reopen-project');
    ipcMain.removeHandler('cancel-project-creation');

    
    this.logger.info('✅ Project creation IPC handlers unregistered');
  }
}

module.exports = { ProjectCreationHandler };