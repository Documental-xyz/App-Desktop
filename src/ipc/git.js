/**
 * @fileoverview IPC handlers for Git operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const { GitOperations } = require('./gitOperations.js');

// Resilient import: fallback to 120s if gitFlowTypes.js is unavailable yet.
const { LOCK_TIMEOUT_MS: _IMPORTED_LOCK_TIMEOUT_MS } = (() => {
  try {
    return require('./gitFlowTypes.js');
  } catch (_e) {
    return { LOCK_TIMEOUT_MS: 120000 };
  }
})();

/**
 * @typedef {Object} GitOperationResult
 * @property {boolean} success - Whether the operation succeeded
 * @property {string} [error] - Error message if operation failed
 * @property {*} [data] - Operation result data
 */

/**
 * @typedef {Object} BranchInfo
 * @property {string} name - Branch name
 * @property {boolean} isCurrent - Whether this is the current branch
 * @property {boolean} isRemote - Whether this is a remote branch
 */

/**
 * @typedef {Object} RepositoryInfo
 * @property {string} currentBranch - Current branch name
 * @property {Array<string>} branches - List of local branches
 * @property {Array<string>} remoteBranches - List of remote branches
 * @property {string|null} remoteUrl - Remote repository URL
 * @property {boolean} isClean - Whether working directory is clean
 * @property {string|null} status - Git status information
 */

/**
 * Git Operations IPC Handlers
 */
class GitHandlers {
  /**
   * Create an instance of GitHandlers
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.databaseManager - Database manager instance
   */
  constructor({ logger, databaseManager }) {
    this.logger = logger;
    this.databaseManager = databaseManager;
    this.gitOps = new GitOperations({ logger, databaseManager });
    this.gitOperationInProgress = false;
    this.LOCK_TIMEOUT_MS = _IMPORTED_LOCK_TIMEOUT_MS;
    this._lockTimeout = null;
    this._abortController = null;
    this._gitCache = {};
    this._sendOutputBuffer = [];
    this._sendOutputTimer = null;
    this._gitModuleCache = null;
    this.cancelRequested = false;
  }

  async _getGit() {
    if (!this._gitModuleCache) {
      this._gitModuleCache = await import('isomorphic-git');
    }
    return this._gitModuleCache;
  }

  /**
   * Acquire the git operation lock
   * @returns {boolean} True if lock was acquired, false if already in progress
   */
  acquireGitLock() {
    if (this.gitOperationInProgress) {
      this.logger.warn('Git operation already in progress');
      return false;
    }
    this.gitOperationInProgress = true;
    this.cancelRequested = false;
    this._abortController = new AbortController();
    this._lockTimeout = setTimeout(() => {
      this.logger.warn('Git operation auto-aborted after timeout');
      this._abortController.abort(new Error('Operation timeout'));
    }, this.LOCK_TIMEOUT_MS);
    this.logger.info('Git operation lock acquired');
    return true;
  }

  /**
   * Release the git operation lock
   */
  releaseGitLock() {
    this._flushSendOutput();
    this.gitOperationInProgress = false;
    if (this._lockTimeout) {
      clearTimeout(this._lockTimeout);
      this._lockTimeout = null;
    }
    // Note: do NOT call _abortController.abort() here — the operation has
    // already completed (success or error). We only clear the reference.
    this._abortController = null;
    this.logger.info('Git operation lock released');
  }

  /**
   * Returns the AbortSignal for the current operation. Pass this to isomorphic-git
   * fetch/pull/push calls so they can be cancelled by timeout or user request.
   * @returns {AbortSignal|null}
   */
  getAbortSignal() {
    return this._abortController ? this._abortController.signal : null;
  }

  /**
   * Request cancellation of the current Git operation
   * Sets the cancel flag that operations should check between steps
   */
  requestCancel() {
    this.cancelRequested = true;
    if (this._abortController) {
      this._abortController.abort(new Error('User requested cancel'));
    }
    this.logger.info('Git operation cancellation requested');
  }

  /**
   * Reset the cancellation flag
   * Should be called at the start of new operations
   */
  resetCancel() {
    this.cancelRequested = false;
    this.logger.debug('Git operation cancellation flag reset');
  }

  /**
   * Check if cancellation has been requested
   * @returns {boolean} True if cancellation was requested
   */
  isCancelRequested() {
    return this.cancelRequested;
  }

  /**
   * Broadcast a message to all renderer windows
   * @param {string} channel - IPC channel name
   * @param {*} payload - Payload to send
   */
  broadcastToWindows(channel, payload) {
    try {
      const normalizedPayload = typeof payload === 'object' && payload !== null
        ? payload
        : { message: String(payload) };
      const { BrowserWindow } = require('electron');
      if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send(channel, normalizedPayload);
          }
        });
      }
    } catch (error) {
      this.logger.debug('broadcastToWindows failed (expected in tests):', error.message);
    }
  }

  /**
   * Send output to the commands console (debounced for performance)
   * Error messages (❌) are delivered immediately, others are batched
   * @param {string} message - Message to send
   */
  sendOutput(message) {
    // Error messages bypass debounce — deliver immediately
    if (typeof message === 'string' && message.includes('❌')) {
      this._flushSendOutput();
      this.broadcastToWindows('command-output', { message });
      return;
    }
    // Buffer non-error messages and batch them with 100ms debounce
    this._sendOutputBuffer.push(message);
    if (this._sendOutputTimer) {
      clearTimeout(this._sendOutputTimer);
    }
    this._sendOutputTimer = setTimeout(() => {
      this._sendOutputTimer = null;
      this._flushSendOutput();
    }, 100);
  }

  /**
   * Flush the sendOutput buffer — deliver all pending messages immediately
   * @private
   */
  _flushSendOutput() {
    if (this._sendOutputTimer) {
      clearTimeout(this._sendOutputTimer);
      this._sendOutputTimer = null;
    }
    if (this._sendOutputBuffer.length > 0) {
      const messages = this._sendOutputBuffer.splice(0);
      this.broadcastToWindows('command-output', { message: messages.join('\n') });
    }
  }

  /**
   * Send structured progress update to all renderer windows
   * @param {Object} progress - Progress data
   * @param {string} progress.stage - Current stage (checking, staging, committing, fetching, pulling, pushing, complete)
   * @param {number} progress.current - Current item number
   * @param {number} progress.total - Total items
   * @param {string} progress.message - Status message
   */
  sendProgress(progress) {
    const percentage = progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

    this.broadcastToWindows('git:progress', {
      ...progress,
      percentage
    });
  }

  /**
   * Get project path by ID
   * @param {number} projectId - Project ID
   * @returns {Promise<string>} Full project path
   */
  async getProjectPath(projectId) {
    const db = await this.databaseManager.getDatabase();
    
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM projects WHERE id = ?', [projectId], (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        
        if (!row) {
          reject(new Error('Project not found'));
          return;
        }

        this.logger.info(`📂 Project data: ID=${row.id}, projectPath=${row.projectPath}, repoFolderName=${row.repoFolderName}`);

        // Validate required fields
        if (!row.projectPath) {
          reject(new Error(`Invalid project data: projectPath is missing`));
          return;
        }

        // Handle different path scenarios
        let projectPath;
        if (row.repoFolderName) {
          // Check if projectPath already includes repoFolderName
          if (row.projectPath.endsWith(row.repoFolderName)) {
            projectPath = row.projectPath;
            this.logger.info(`📂 Project path already includes repo folder: ${projectPath}`);
          } else {
            projectPath = path.join(row.projectPath, row.repoFolderName);
            this.logger.info(`📂 Constructed project path: ${projectPath}`);
          }
        } else {
          projectPath = row.projectPath;
          this.logger.info(`📂 Using project path directly: ${projectPath}`);
        }

        this.logger.info(`✅ Final project path: ${projectPath}`);
        resolve(projectPath);
      });
    });
  }

  /**
   * Check if repository has uncommitted changes
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<{success: boolean, isDirty: boolean, fileCount: number, files: string[]}>}
   */
  async gitCheckStatus(projectPath) {
    try {
      const fs = require('fs');
      const gitMod = await this._getGit();

      const matrix = await gitMod.statusMatrix({ fs, dir: projectPath, cache: this._gitCache });
      const dirtyFiles = matrix.filter(([, head, workdir, stage]) =>
        !(head === 1 && workdir === 1 && stage === 1)
      );

      return {
        success: true,
        isDirty: dirtyFiles.length > 0,
        fileCount: dirtyFiles.length,
        files: dirtyFiles.map(([filepath]) => filepath)
      };
    } catch (error) {
      this.logger.error('Error checking git status:', error);
      return { success: false, isDirty: false, fileCount: 0, files: [], error: error.message };
    }
  }

  /**
   * Stage all dirty files and create a commit
   * @param {Object} gitMod - isomorphic-git module
   * @param {Object} fs - filesystem module
   * @param {string} projectPath - Path to the git repository
   * @param {string} commitMessage - Commit message
   * @param {Object} author - Author object with name and email
   * @returns {Promise<string|null>} Commit SHA or null if nothing to commit
   * @private
   */
  async _commitAll(gitMod, fs, projectPath, commitMessage, author) {
    try {
      const matrix = await gitMod.statusMatrix({ fs, dir: projectPath, cache: this._gitCache });
      const dirty = matrix.filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));

      if (dirty.length === 0) {
        this.sendOutput('ℹ️ Nenhuma alteração para commitar.');
        return null;
      }

      this.sendOutput(`📝 Preparando ${dirty.length} arquivo(s) para commit...`);

      // Stage files em batches com tratamento de erro individual
      const stageErrors = [];
      const BATCH_SIZE = 10;
      for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
        const batch = dirty.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async ([filepath, , worktreeStatus]) => {
            try {
              if (worktreeStatus) {
                await gitMod.add({ fs, dir: projectPath, filepath });
              } else {
                await gitMod.remove({ fs, dir: projectPath, filepath });
              }
            } catch (fileError) {
              stageErrors.push({ filepath, error: fileError.message });
            }
          })
        );

        // Reportar progresso após cada batch
        const progress = Math.round(((i + batch.length) / dirty.length) * 100);
        this.sendOutput(`📊 Progresso: ${progress}% (${i + batch.length}/${dirty.length} arquivos)`);
      }

      if (stageErrors.length > 0) {
        const errorMsg = `Erro ao preparar arquivo(s): ${stageErrors.map(e => e.filepath).join(', ')}`;
        this.sendOutput(`❌ ${errorMsg}`);
        throw new Error(errorMsg);
      }

      this._gitCache = {};

      this.sendOutput(`💾 Commitando: "${commitMessage}"`);
      const sha = await gitMod.commit({ fs, dir: projectPath, message: commitMessage, author });
      this.sendOutput(`✅ Commit criado: ${sha.substring(0, 7)}`);
      return sha;
    } catch (error) {
      this.sendOutput(`❌ Erro durante commit: ${error.message}`);
      throw error;
    }
  }

  /**
   * List all branches in the repository
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<{branches: Array<BranchInfo>, current: string}>}
   */
  async gitListBranches(projectPath) {
    try {
      this.logger.info(`🔍 Listing branches for repository: ${projectPath}`);
      
      // Check if directory exists and is a git repository
      const fs = require('fs');
      try {
        await fs.promises.access(projectPath);
      } catch {
        throw new Error(`Repository path does not exist: ${projectPath}`);
      }
      
      const gitDir = require('path').join(projectPath, '.git');
      try {
        await fs.promises.access(gitDir);
      } catch {
        throw new Error(`Not a git repository: ${projectPath}`);
      }
      
      // Get current branch with fallback
      let currentBranch = 'master'; // Default fallback
      try {
        currentBranch = await git.currentBranch({ fs, dir: projectPath, cache: this._gitCache });
        this.logger.info(`✅ Current branch detected: ${currentBranch}`);
      } catch (error) {
        this.logger.warn(`⚠️ Could not determine current branch, using fallback: ${error.message}`);
        // Try to get branches directly as fallback
        try {
          const refs = await git.listRefs({ fs, dir: projectPath, cache: this._gitCache });
          const headRef = refs.find(ref => ref === 'HEAD');
           if (headRef) {
             // Try to resolve HEAD manually
             const headFile = require('path').join(gitDir, 'HEAD');
             try {
               const headContent = await fs.promises.readFile(headFile, 'utf8');
               const match = headContent.match(/ref: refs\/heads\/(.+)/);
               if (match) {
                 currentBranch = match[1].trim();
                 this.logger.info(`✅ Current branch resolved from HEAD file: ${currentBranch}`);
               }
             } catch {
               // HEAD file doesn't exist or can't be read, continue with fallback
             }
           }
        } catch (fallbackError) {
          this.logger.warn(`⚠️ Could not resolve current branch from HEAD: ${fallbackError.message}`);
        }
      }
      
    // Use the simple and reliable git.listBranches() approach (same as working GitOperations.js)
    let branches = [];
    let remoteBranches = [];
    
    try {
      // Get all branches (local and remote) using isomorphic-git's built-in method
      const allBranches = await git.listBranches({ fs, dir: projectPath, cache: this._gitCache });
      
      // Separate local and remote branches (same logic as GitOperations.js)
      const localBranches = allBranches.filter(branch => !branch.includes('origin/'));
      const remoteBranchNames = allBranches.filter(branch => branch.includes('origin/'))
        .map(branch => branch.replace('origin/', ''));
      
      // Create branch objects for local branches
      for (const branchName of localBranches) {
        branches.push({
          name: branchName,
          isCurrent: branchName === currentBranch,
          isRemote: false
        });
      }
      
      // Create branch objects for remote branches
      for (const branchName of remoteBranchNames) {
        if (branchName !== 'HEAD') {
          remoteBranches.push({
            name: branchName,
            isCurrent: false,
            isRemote: true
          });
        }
      }
      
    } catch (error) {
      this.logger.error(`Failed to list branches via git.listBranches(): ${error.message}`);
      
       // Fallback to filesystem method if git.listBranches() fails
       this.logger.warn('Falling back to filesystem method...');
       try {
         const headsDir = require('path').join(gitDir, 'refs', 'heads');
         try {
           const branchFiles = await fs.promises.readdir(headsDir);
           for (const branchName of branchFiles) {
             branches.push({
               name: branchName,
               isCurrent: branchName === currentBranch,
               isRemote: false
             });
           }
           this.logger.info(`Fallback: Found ${branchFiles.length} local branches via filesystem`);
         } catch {
           // headsDir doesn't exist or can't be read
         }
       } catch (fallbackError) {
         this.logger.error(`Filesystem fallback also failed: ${fallbackError.message}`);
       }
    }
      
      const result = {
        branches: branches.concat(remoteBranches),
        current: currentBranch
      };
      
      this.logger.info(`✅ Branch listing complete: ${result.branches.length} branches, current: ${result.current}`);
      return result;
    } catch (error) {
      this.logger.error('❌ Error listing branches:', error);
      throw error;
    }
  }

  /**
   * Create a new branch
   * @param {string} projectPath - Path to the git repository
   * @param {string} branchName - Name of the branch to create
   * @returns {Promise<void>}
   */
  async gitCreateBranch(projectPath, branchName) {
    try {
      await git.branch({
        fs: require('fs'),
        dir: projectPath,
        ref: branchName
      });
      this._gitCache = {};
      
      this.logger.info(`Created branch: ${branchName}`);
    } catch (error) {
      this.logger.error('Error creating branch:', error);
      throw error;
    }
  }

  /**
   * Checkout to a specific branch
   * @param {string} projectPath - Path to the git repository
   * @param {string} branchName - Name of the branch to checkout
   * @returns {Promise<void>}
   */
  async gitCheckoutBranch(projectPath, branchName) {
    try {
      this.logger.info(`🔄 Checking out branch '${branchName}' in ${projectPath}`);
      
      const fs = require('fs');
      
      // Start branch list fetch in parallel with checkout attempt (avoids redundant call on failure)
      const branchListPromise = this.gitListBranches(projectPath).catch(() => null);
      
      // First, try to checkout directly (for local branches)
      try {
        await git.checkout({
          fs,
          dir: projectPath,
          ref: branchName
        });
        this._gitCache = {};
        
        this.logger.info(`✅ Successfully checked out branch: ${branchName}`);
        return;
      } catch (directError) {
        this.logger.warn(`⚠️ Direct checkout failed: ${directError.message}`);
        
        // Use the already-fetched (parallel) branch list
        try {
          const branchResult = await branchListPromise;
          if (!branchResult) {
            throw new Error(`Branch '${branchName}' not found locally or remotely`);
          }
          const localBranch = branchResult.branches.find(b => b.name === branchName && !b.isRemote);
          const remoteBranch = branchResult.branches.find(b => b.name === branchName && b.isRemote);
          
          if (localBranch) {
            // Local branch exists but checkout failed, try again with force
            this.logger.info(`📂 Local branch exists, trying checkout again...`);
            await git.checkout({
              fs,
              dir: projectPath,
              ref: branchName
            });
            this._gitCache = {};
            this.logger.info(`✅ Successfully checked out local branch: ${branchName}`);
          } else if (remoteBranch) {
            // Remote branch exists, create local tracking branch
            this.logger.info(`📥 Remote branch exists, creating local tracking branch...`);
            await git.branch({
              fs,
              dir: projectPath,
              ref: branchName,
              checkout: true
            });
            this._gitCache = {};
            this.logger.info(`✅ Created and checked out local branch: ${branchName}`);
          } else {
            throw new Error(`Branch '${branchName}' not found locally or remotely`);
          }
        } catch (branchError) {
          this.logger.error(`❌ Branch checkout failed: ${branchError.message}`);
          throw branchError;
        }
      }
    } catch (error) {
      this.logger.error('❌ Error checking out branch:', error);
      throw error;
    }
  }

  /**
   * Get current branch name
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<string>} Current branch name
   */
  async gitGetCurrentBranch(projectPath) {
    try {
      const currentBranch = await git.currentBranch({ fs: require('fs'), dir: projectPath, cache: this._gitCache });
      return currentBranch;
    } catch (error) {
      this.logger.error('Error getting current branch:', error);
      throw error;
    }
  }

  /**
   * Get repository information
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<RepositoryInfo>} Repository information
   */
  async gitGetRepositoryInfo(projectPath) {
    try {
      this.logger.info(`📋 Getting repository information from ${projectPath}`);
      
      const fs = require('fs');
      
      // Get current branch with fallback
      let currentBranch = 'master';
      try {
        currentBranch = await git.currentBranch({ fs, dir: projectPath, cache: this._gitCache });
        this.logger.info(`✅ Current branch: ${currentBranch}`);
      } catch (error) {
        this.logger.warn(`⚠️ Could not get current branch: ${error.message}`);
        // Use gitListBranches to get current branch
        try {
          const branchResult = await this.gitListBranches(projectPath);
          currentBranch = branchResult.current || 'master';
          this.logger.info(`✅ Using fallback current branch: ${currentBranch}`);
        } catch (fallbackError) {
          this.logger.warn(`⚠️ Could not get branches for fallback: ${fallbackError.message}`);
        }
      }
      
      // Get branches
      const branchResult = await this.gitListBranches(projectPath);
      const allBranches = branchResult.branches || [];
      const localBranches = allBranches.filter(b => !b.isRemote);
      const remoteBranches = allBranches.filter(b => b.isRemote);
      
      // Get remote URL
      let remoteUrl = null;
      try {
        remoteUrl = await git.getConfig({
          fs,
          dir: projectPath,
          path: 'remote.origin.url',
          cache: this._gitCache
        });
      } catch (error) {
        this.logger.debug('Could not get remote URL:', error.message);
      }
      
      // Get last commit information
      let lastCommit = {
        hash: '',
        message: '',
        date: null
      };
      
      try {
        // Try to get commit OID for the current branch HEAD
        const commitOid = await git.resolveRef({
          fs,
          dir: projectPath,
          ref: currentBranch,
          cache: this._gitCache
        });
        
        if (commitOid) {
          // Get commit details
          const commit = await git.readCommit({
            fs,
            dir: projectPath,
            oid: commitOid,
            cache: this._gitCache
          });
          
          if (commit && commit.commit) {
            lastCommit.hash = commitOid.substring(0, 7); // Short hash (7 characters)
            lastCommit.message = commit.commit.message.split('\n')[0]; // First line only
            lastCommit.date = new Date(commit.commit.author.timestamp * 1000);
          }
        }
      } catch (error) {
        this.logger.warn('Could not get last commit info:', error.message);
        // Try fallback to get commit from HEAD directly
        try {
          const headOid = await git.resolveRef({
            fs,
            dir: projectPath,
            ref: 'HEAD',
            cache: this._gitCache
          });
          
          if (headOid) {
            const commit = await git.readCommit({
              fs,
              dir: projectPath,
              oid: headOid,
              cache: this._gitCache
            });
            
            if (commit && commit.commit) {
              lastCommit.hash = headOid.substring(0, 7);
              lastCommit.message = commit.commit.message.split('\n')[0];
              lastCommit.date = new Date(commit.commit.author.timestamp * 1000);
              this.logger.info(`✅ Got commit info from HEAD: ${lastCommit.hash}`);
            }
          }
        } catch (headError) {
          this.logger.warn('Could not get commit from HEAD either:', headError.message);
        }
      }
      
      // Get status
      let isClean = true;
      let status = null;
      try {
        const statusResult = await git.statusMatrix({
          fs,
          dir: projectPath,
          cache: this._gitCache
        });
        
        // Check if there are any unstaged changes
        isClean = statusResult.every(row => row[1] === row[2]);
        status = isClean ? 'clean' : 'dirty';
      } catch (error) {
        this.logger.debug('Could not get status:', error.message);
      }
      
      const result = {
        workingDirectory: projectPath,
        remoteUrl: remoteUrl || '',
        lastCommit: lastCommit,
        currentBranch,
        branches: localBranches.map(b => b.name),
        remoteBranches: remoteBranches.map(b => b.name),
        isClean,
        status
      };
      
      this.logger.info(`✅ Repository info retrieved:`, result);
      return result;
    } catch (error) {
      this.logger.error('Error getting repository info:', error);
      throw error;
    }
  }

  /**
   * Pull changes from remote for current branch
   * @param {string} projectPath - Path to the git repository
   * @param {string|null} [commitMessage=null] - If provided, commit all changes before pulling
   * @returns {Promise<{success: boolean, pulled?: boolean, branch?: string, error?: string}>}
   */
  async gitPullFromPreview(projectPath, commitMessage = null) {
    if (!this.acquireGitLock()) {
      this.sendOutput('⚠️ Operação Git já em andamento. Aguarde...');
      return { success: false, error: 'Git operation already in progress. Please wait.' };
    }

    const fs = require('fs');

    try {
      const gitMod = await this._getGit();

      // 1. Início - verificando
      this.sendProgress({
        stage: 'checking',
        current: 0,
        total: commitMessage ? 5 : 3,
        message: 'Verificando status do repositório...'
      });

      const [token, currentBranch] = await Promise.all([
        this.gitOps.getGitHubToken(),
        gitMod.currentBranch({ fs, dir: projectPath, cache: this._gitCache })
      ]);

      if (!token) {
        this.sendOutput('❌ Autenticação GitHub necessária. Faça login novamente.');
        return { success: false, error: 'Autenticação GitHub necessária. Faça login novamente.' };
      }

      if (!currentBranch) {
        this.sendOutput('❌ Nenhuma branch selecionada (detached HEAD). Selecione uma branch para atualizar.');
        return { success: false, error: 'Nenhuma branch selecionada (detached HEAD). Selecione uma branch primeiro.' };
      }

      const auth = { username: token, password: 'x-oauth-basic' };

      // Commit local changes before pulling if commitMessage provided
      if (commitMessage) {
        // 2. Staging
        this.sendProgress({
          stage: 'staging',
          current: 1,
          total: 5,
          message: 'Preparando arquivos para commit...'
        });

        this.sendOutput('⚙️ Configurando usuário git para commit...');
        try {
          await this.gitOps.configureGitForUser(projectPath);
        } catch (configError) {
          this.logger.warn('Could not configure git user:', configError);
          this.sendOutput('⚠️ Não foi possível configurar usuário git. Continuando com configuração existente...');
        }
        const [authorName, authorEmail] = await Promise.all([
          gitMod.getConfig({ fs, dir: projectPath, path: 'user.name', cache: this._gitCache }).then(v => v || 'documental'),
          gitMod.getConfig({ fs, dir: projectPath, path: 'user.email', cache: this._gitCache }).then(v => v || 'documental@app')
        ]);
        const author = { name: authorName, email: authorEmail };

        // 3. Committing
        this.sendProgress({
          stage: 'committing',
          current: 2,
          total: 5,
          message: 'Criando commit...'
        });

        await this._commitAll(gitMod, fs, projectPath, commitMessage, author);

        // Check for cancellation after auto-commit
        if (this.isCancelRequested()) {
          this.logger.info('Pull operation cancelled after commit');
          this.releaseGitLock();
          return { success: false, cancelled: true, message: 'Operation cancelled by user' };
        }
      }

      // 4. Fetching (or step 2 if no commitMessage)
      this.sendProgress({
        stage: 'fetching',
        current: commitMessage ? 3 : 1,
        total: commitMessage ? 5 : 3,
        message: `Buscando alterações da branch remota '${currentBranch}'...`
      });

      this.sendOutput(`📥 Buscando alterações da branch remota '${currentBranch}'...`);

      await gitMod.fetch({
        fs,
        http,
        dir: projectPath,
        remote: 'origin',
        ref: currentBranch,
        singleBranch: true,
        depth: 1,
        onAuth: () => auth,
        onProgress: (evt) => {
          if (evt.total && evt.loaded) {
            const percent = Math.round((evt.loaded / evt.total) * 100);
            this.sendProgress({
              stage: 'fetching',
              current: percent,
              total: 100,
              message: `Baixando: ${percent}%`
            });
          }
        }
      });
      this._gitCache = {};

      // Check for cancellation after fetch
      if (this.isCancelRequested()) {
        this.logger.info('Pull operation cancelled after fetch');
        this.releaseGitLock();
        return { success: false, cancelled: true, message: 'Operation cancelled by user' };
      }

      // 5. Pulling - Check if fast-forward is possible (faster than pull)
      this.sendProgress({
        stage: 'pulling',
        current: commitMessage ? 4 : 2,
        total: commitMessage ? 5 : 3,
        message: 'Mesclando alterações...'
      });

      this.sendOutput('🔄 Verificando atualização...');

      // Check for cancellation
      if (this.isCancelRequested()) {
        this.logger.info('Pull operation cancelled before merge');
        this.releaseGitLock();
        return { success: false, cancelled: true, message: 'Operation cancelled by user' };
      }

      // Try fast-forward first (faster than pull)
      try {
        const canFastForward = await gitMod.canFastForward({
          fs,
          dir: projectPath,
          ref: `origin/${currentBranch}`,
          target: currentBranch
        });

        if (canFastForward) {
          this.sendOutput('⚡ Fast-forward possível, atualizando...');
          await gitMod.fastForward({
            fs,
            dir: projectPath,
            ref: currentBranch,
            onAuth: () => auth,
          });
        } else {
          this.sendOutput('🔄 Mesclando alterações...');
          await gitMod.pull({
            fs,
            http,
            dir: projectPath,
            ref: currentBranch,
            singleBranch: true,
            author: { name: 'documental', email: 'documental@app' },
            onAuth: () => auth,
          });
        }
      } catch (ffError) {
        // Fallback to regular pull if fast-forward check fails
        this.logger.warn('Fast-forward check failed, using regular pull:', ffError);
        await gitMod.pull({
          fs,
          http,
          dir: projectPath,
          ref: currentBranch,
          singleBranch: true,
          author: { name: 'documental', email: 'documental@app' },
          onAuth: () => auth,
        });
      }
      this._gitCache = {};

      // 6. Complete
      this.sendProgress({
        stage: 'complete',
        current: commitMessage ? 5 : 3,
        total: commitMessage ? 5 : 3,
        message: 'Pull concluído com sucesso!'
      });

      this.sendOutput(`✅ Pull concluído com sucesso na branch: ${currentBranch}`);
      this.logger.info(`Successfully pulled from branch: ${currentBranch}`);
      return { success: true, pulled: true, branch: currentBranch };

    } catch (error) {
      this.logger.error('Error pulling from branch:', error);

      let errorMessage = error.message || 'Erro desconhecido ao atualizar';

      if (error.message && (error.message.includes('merge') || error.message.includes('conflict'))) {
        errorMessage = 'Conflito de merge detectado. Resolva manualmente.';
      } else if (error.message && (error.message.includes('network') || error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT'))) {
        errorMessage = 'Erro de rede. Verifique sua conexão.';
      } else if (error.message && (error.message.includes('401') || error.message.includes('403') || error.message.includes('authentication'))) {
        errorMessage = 'Erro de autenticação. Faça login novamente.';
      }

      this.sendOutput(`❌ Erro ao atualizar: ${errorMessage}`);
      return { success: false, error: errorMessage };

    } finally {
      this.releaseGitLock();
    }
  }

  /**
   * Push changes to a specific branch with optional commit-before-push and first-push-wins strategy
   * @param {string} projectPath - Path to the git repository
   * @param {string} targetBranch - Target branch name
   * @param {string|null} [commitMessage=null] - If provided, commit all changes before pushing
   * @returns {Promise<{success: boolean, pushed?: boolean, branch?: string, error?: string}>}
   */
  async gitPushToBranch(projectPath, targetBranch, commitMessage = null) {
    if (!this.acquireGitLock()) {
      this.sendOutput('⚠️ Operação Git já em andamento. Aguarde...');
      return { success: false, error: 'Git operation already in progress. Please wait.' };
    }

    const fs = require('fs');

    try {
      const gitMod = await this._getGit();

      // 1. Início - verificando
      this.sendProgress({
        stage: 'checking',
        current: 0,
        total: commitMessage ? 6 : 2,
        message: 'Verificando status do repositório...'
      });

      const [token, userConfigured] = await Promise.all([
        this.gitOps.getGitHubToken(),
        this.gitOps.configureGitForUser(projectPath)
      ]);

      if (!token) {
        this.sendOutput('❌ Autenticação GitHub necessária. Faça login novamente.');
        return { success: false, error: 'Autenticação GitHub necessária. Faça login novamente.' };
      }

      if (!userConfigured) {
        this.sendOutput('⚠️ Não foi possível configurar usuário git. Continuando com configuração existente...');
        this.logger.warn('Could not configure git user, proceeding with existing config');
      }

      const auth = { username: token, password: 'x-oauth-basic' };

      // Commit local changes before pushing if commitMessage provided
      if (commitMessage) {
        // 2. Staging
        this.sendProgress({
          stage: 'staging',
          current: 1,
          total: 6,
          message: 'Preparando arquivos para commit...'
        });

        const [authorName, authorEmail] = await Promise.all([
          gitMod.getConfig({ fs, dir: projectPath, path: 'user.name', cache: this._gitCache }).then(v => v || 'documental'),
          gitMod.getConfig({ fs, dir: projectPath, path: 'user.email', cache: this._gitCache }).then(v => v || 'documental@app')
        ]);
        const author = { name: authorName, email: authorEmail };

        // 3. Committing
        this.sendProgress({
          stage: 'committing',
          current: 2,
          total: 6,
          message: 'Criando commit...'
        });

        await this._commitAll(gitMod, fs, projectPath, commitMessage, author);

        // Check for cancellation after auto-commit
        if (this.isCancelRequested()) {
          this.logger.info('Push operation cancelled after commit');
          this.releaseGitLock();
          return { success: false, cancelled: true, message: 'Operation cancelled by user' };
        }

        // First-push-wins: fetch + pull to integrate remote changes before pushing
        try {
          // 4. Fetching
          this.sendProgress({
            stage: 'fetching',
            current: 3,
            total: 6,
            message: `Buscando alterações remotas de '${targetBranch}'...`
          });

          this.sendOutput(`📥 Integrando alterações remotas de '${targetBranch}'...`);
          await gitMod.fetch({
            fs,
            http,
            dir: projectPath,
            remote: 'origin',
            ref: targetBranch,
            singleBranch: true,
            onAuth: () => auth,
          });
          this._gitCache = {};

          // Check for cancellation after fetch
          if (this.isCancelRequested()) {
            this.logger.info('Push operation cancelled after fetch');
            this.releaseGitLock();
            return { success: false, cancelled: true, message: 'Operation cancelled by user' };
          }

          // 5. Pulling
          this.sendProgress({
            stage: 'pulling',
            current: 4,
            total: 6,
            message: 'Mesclando alterações remotas...'
          });

          await gitMod.pull({
            fs,
            http,
            dir: projectPath,
            ref: targetBranch,
            singleBranch: true,
            author: { name: authorName, email: authorEmail },
            onAuth: () => auth,
          });
          this._gitCache = {};

          // Check for cancellation after pull
          if (this.isCancelRequested()) {
            this.logger.info('Push operation cancelled after pull');
            this.releaseGitLock();
            return { success: false, cancelled: true, message: 'Operation cancelled by user' };
          }
        } catch (fetchPullError) {
          // Branch doesn't exist on remote yet — OK for first push
          if (!fetchPullError.message.includes('Could not find') &&
              !fetchPullError.message.includes('not found') &&
              !fetchPullError.message.includes('404')) {
            if (fetchPullError.message.includes('merge') || fetchPullError.message.includes('MERGE_HEAD')) {
              this.sendOutput('❌ Conflito de merge detectado. Resolva manualmente.');
              return { success: false, error: 'Conflito de merge. Resolva as diferenças manualmente antes de publicar.' };
            }
            this.logger.warn('Fetch/pull before push warning:', fetchPullError.message);
          }
        }
      }

      // Check for cancellation before push
      if (this.isCancelRequested()) {
        this.logger.info('Push operation cancelled before push');
        this.releaseGitLock();
        return { success: false, cancelled: true, message: 'Operation cancelled by user' };
      }

      // 6. Pushing (or step 2 if no commitMessage)
      this.sendProgress({
        stage: 'pushing',
        current: commitMessage ? 5 : 1,
        total: commitMessage ? 6 : 2,
        message: `Publicando na branch '${targetBranch}'...`
      });

      this.sendOutput(`🚀 Publicando alterações na branch: ${targetBranch}...`);

      await gitMod.push({
        fs,
        http,
        dir: projectPath,
        remote: 'origin',
        ref: targetBranch,
        onAuth: () => auth,
      });
      this._gitCache = {};

      // 7. Complete (or step 3 if no commitMessage)
      this.sendProgress({
        stage: 'complete',
        current: commitMessage ? 6 : 2,
        total: commitMessage ? 6 : 2,
        message: 'Push concluído com sucesso!'
      });

      this.sendOutput(`✅ Push concluído com sucesso na branch: ${targetBranch}`);
      this.logger.info(`Successfully pushed to branch: ${targetBranch}`);
      return { success: true, pushed: true, branch: targetBranch };

    } catch (error) {
      this.logger.error('Error pushing to branch:', error);

      let errorMessage = error.message || 'Erro desconhecido ao publicar';

      if (error.message && error.message.includes('non-fast-forward')) {
        errorMessage = 'Push rejeitado. Faça pull antes de publicar (non-fast-forward).';
      } else if (error.message && (error.message.includes('401') || error.message.includes('403') || error.message.includes('authentication'))) {
        errorMessage = 'Erro de autenticação. Faça login novamente.';
      } else if (error.message && (error.message.includes('network') || error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT'))) {
        errorMessage = 'Erro de rede. Verifique sua conexão.';
      }

      this.sendOutput(`❌ Erro ao publicar: ${errorMessage}`);
      return { success: false, error: errorMessage };

    } finally {
      this.releaseGitLock();
    }
  }

  /**
   * List remote branches
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<Array<string>>} List of remote branch names
   */
  async gitListRemoteBranches(projectPath) {
    try {
      this.sendOutput('🔍 Buscando branches remotas...');

      // Get auth token for private repo support
      const token = await this.gitOps.getGitHubToken();
      const auth = token ? { username: token, password: 'x-oauth-basic' } : undefined;

      const gitMod = await this._getGit();

      const url = await gitMod.getConfig({
        fs: require('fs'),
        dir: projectPath,
        path: 'remote.origin.url',
        cache: this._gitCache
      });

      const listServerRefsConfig = {
        http,
        url,
        cache: this._gitCache,
      };

      if (auth) {
        listServerRefsConfig.onAuth = () => auth;
      }

      const refs = await gitMod.listServerRefs(listServerRefsConfig);

      const branches = refs
        .filter(ref => ref.ref.startsWith('refs/heads/'))
        .map(ref => ref.ref.replace('refs/heads/', ''))
        .filter(name => name !== 'HEAD');

      // Determine default branch from HEAD symref or fallback
      const headRef = refs.find(r => r.ref === 'HEAD');
      const defaultBranch = headRef?.target
        ? headRef.target.replace('refs/heads/', '')
        : branches.find(b => ['main', 'master'].includes(b)) || branches[0] || 'main';

      return { success: true, branches, defaultBranch };
    } catch (error) {
      this.logger.error('Error listing remote branches:', error);
      if (!error.message?.includes('auth') && !(await this.gitOps.getGitHubToken())) {
        throw new Error('Autenticação necessária para repositórios privados');
      }
      throw error;
    }
  }

  /**
   * Register all Git operations IPC handlers
   */
  registerHandlers() {
    this.logger.info('🔧 Registering Git operations IPC handlers');

    /**
     * List branches
     */
    ipcMain.handle('git:list-branches', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const result = await this.gitListBranches(projectPath);
        return { success: true, branches: result.branches, currentBranch: result.current };
      } catch (error) {
        this.logger.error('Error in git:list-branches handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Create branch
     */
    ipcMain.handle('git:create-branch', async (event, projectId, branchName) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        await this.gitCreateBranch(projectPath, branchName);
        return { success: true, branchName };
      } catch (error) {
        this.logger.error('Error in git:create-branch handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Checkout branch
     */
    ipcMain.handle('git:checkout-branch', async (event, projectId, branchName) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        await this.gitCheckoutBranch(projectPath, branchName);
        return { success: true, branchName };
      } catch (error) {
        this.logger.error('Error in git:checkout-branch handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Get current branch
     */
    ipcMain.handle('git:get-current-branch', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const currentBranch = await this.gitGetCurrentBranch(projectPath);
        return { success: true, currentBranch };
      } catch (error) {
        this.logger.error('Error in git:get-current-branch handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Get repository info
     */
    ipcMain.handle('git:get-repository-info', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const repoInfo = await this.gitGetRepositoryInfo(projectPath);
        return { success: true, ...repoInfo };
      } catch (error) {
        this.logger.error('Error in git:get-repository-info handler:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('git:check-status', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        return await this.gitCheckStatus(projectPath);
      } catch (error) {
        this.logger.error('Error in git:check-status handler:', error);
        return { success: false, isDirty: false, fileCount: 0, files: [], error: error.message };
      }
    });

    ipcMain.handle('git:pull-from-preview', async (event, projectId, commitMessage) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const result = await this.gitPullFromPreview(projectPath, commitMessage || null);
        return result;
      } catch (error) {
        this.logger.error('Error in git:pull-from-preview handler:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('git:push-to-branch', async (event, projectId, targetBranch, commitMessage) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const result = await this.gitPushToBranch(projectPath, targetBranch, commitMessage || null);
        return result;
      } catch (error) {
        this.logger.error('Error in git:push-to-branch handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * List remote branches
     */
    ipcMain.handle('git:list-remote-branches', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        return await this.gitListRemoteBranches(projectPath);
      } catch (error) {
        this.logger.error('Error in git:list-remote-branches handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Cancel current Git operation
     */
    ipcMain.handle('git:cancel-operation', async () => {
      this.logger.info('Cancel operation requested via IPC');
      this.requestCancel();
      return { success: true, message: 'Cancellation requested' };
    });

    this.logger.info('✅ Git operations IPC handlers registered');
  }

  /**
   * Unregister all Git operations IPC handlers
   */
  unregisterHandlers() {
    this.logger.info('🔧 Unregistering Git operations IPC handlers');
    
    ipcMain.removeHandler('git:list-branches');
    ipcMain.removeHandler('git:create-branch');
    ipcMain.removeHandler('git:checkout-branch');
    ipcMain.removeHandler('git:get-current-branch');
    ipcMain.removeHandler('git:get-repository-info');
    ipcMain.removeHandler('git:check-status');
    ipcMain.removeHandler('git:pull-from-preview');
    ipcMain.removeHandler('git:push-to-branch');
    ipcMain.removeHandler('git:list-remote-branches');
    ipcMain.removeHandler('git:cancel-operation');
    
    this.logger.info('✅ Git operations IPC handlers unregistered');
  }
}

module.exports = { GitHandlers };