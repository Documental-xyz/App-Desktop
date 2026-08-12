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
const {
  LOCK_TIMEOUT_MS: _IMPORTED_LOCK_TIMEOUT_MS,
  BRANCH_PREVIEW,
  BRANCH_MAIN,
  TEMP_PUBLISH_BRANCH,
  MAX_PUBLISH_RETRIES,
  STEP_TIMEOUT_FETCH_MS: _IMPORTED_STEP_TIMEOUT_FETCH_MS,
  STEP_TIMEOUT_MERGE_MS: _IMPORTED_STEP_TIMEOUT_MERGE_MS,
  STEP_TIMEOUT_PUSH_MS: _IMPORTED_STEP_TIMEOUT_PUSH_MS,
  STEP_TIMEOUT_CHECKOUT_MS: _IMPORTED_STEP_TIMEOUT_CHECKOUT_MS,
} = (() => {
  try {
    return require('./gitFlowTypes.js');
  } catch (_e) {
    return {
      LOCK_TIMEOUT_MS: 120000,
      BRANCH_PREVIEW: 'preview',
      BRANCH_MAIN: 'main',
      TEMP_PUBLISH_BRANCH: 'publish-preview',
      MAX_PUBLISH_RETRIES: 2,
      STEP_TIMEOUT_FETCH_MS: 30000,
      STEP_TIMEOUT_MERGE_MS: 45000,
      STEP_TIMEOUT_PUSH_MS: 60000,
      STEP_TIMEOUT_CHECKOUT_MS: 20000,
    };
  }
})();

// Resilient import: GitSafety wrapper for destructive ops (backup + recover).
const { GitSafety: _GitSafetyClass } = (() => {
  try {
    return require('./gitSafety.js');
  } catch (_e) {
    return { GitSafety: null };
  }
})();

// Resilient import: GitPreflight for read-only pre-lock validation.
const { GitPreflight: _GitPreflightClass } = (() => {
  try {
    return require('./gitPreflight.js');
  } catch (_e) {
    return { GitPreflight: null };
  }
})();

// Resilient import: theirs merge driver + binary fallback for publish-preview.
const { theirsMergeDriver, resolveBinaryTheirs } = (() => {
  try {
    return require('./gitMergeDriver.js');
  } catch (_e) {
    return { theirsMergeDriver: null, resolveBinaryTheirs: null };
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
   * @param {Object} [dependencies.permissionHandlers] - Permission handler (for publish-main gating)
   */
  constructor({ logger, databaseManager, permissionHandlers }) {
    this.logger = logger;
    this.databaseManager = databaseManager;
    this.gitOps = new GitOperations({ logger, databaseManager });
    this.permissionHandlers = permissionHandlers || null;
    this.gitOperationInProgress = false;
    this.LOCK_TIMEOUT_MS = _IMPORTED_LOCK_TIMEOUT_MS;
    this.STEP_TIMEOUT_FETCH_MS = _IMPORTED_STEP_TIMEOUT_FETCH_MS;
    this.STEP_TIMEOUT_MERGE_MS = _IMPORTED_STEP_TIMEOUT_MERGE_MS;
    this.STEP_TIMEOUT_PUSH_MS = _IMPORTED_STEP_TIMEOUT_PUSH_MS;
    this.STEP_TIMEOUT_CHECKOUT_MS = _IMPORTED_STEP_TIMEOUT_CHECKOUT_MS;
    this._lockTimeout = null;
    this._abortController = null;
    this._gitCache = {};
    this._sendOutputBuffer = [];
    this._sendOutputTimer = null;
    this._gitModuleCache = null;
    this.cancelRequested = false;
    this.gitSafety = _GitSafetyClass ? new _GitSafetyClass({ logger }) : null;
    this.gitPreflight = _GitPreflightClass
      ? new _GitPreflightClass({ logger, gitOps: this.gitOps, databaseManager, getGit: () => this._getGit() })
      : null;
  }

  async _getGit() {
    if (!this._gitModuleCache) {
      this._gitModuleCache = await import('isomorphic-git');
    }
    return this._gitModuleCache;
  }

  /**
   * Equivalent to `git reset --hard <targetRef>` using available isomorphic-git functions
   * @param {string} projectPath - Absolute path to the git repository
   * @param {string} targetRef - Ref to reset to (e.g., `'origin/preview'`)
   * @returns {Promise<void>}
   */
  async _hardResetBranch(projectPath, targetRef) {
    const fs = require('fs');
    const gitMod = await this._getGit();
    const oid = await gitMod.resolveRef({ fs, dir: projectPath, ref: targetRef });
    const localBranch = targetRef.replace(/^origin\//, '');
    await gitMod.writeRef({
      fs,
      dir: projectPath,
      ref: `refs/heads/${localBranch}`,
      value: oid,
      force: true,
    });
    await gitMod.checkout({ fs, dir: projectPath, ref: localBranch, force: true });
  }

  /**
   * Per-step observability helper. Awaits `promise` to completion but logs a
   * warning if it takes longer than `ms`. isomorphic-git ignores AbortSignal
   * for local operations, so we cannot truly cancel — only observe.
   * @template T
   * @param {Promise<T>} promise - Operation to await.
   * @param {number} ms - Soft-timeout threshold in milliseconds.
   * @param {string} label - Human-readable label for the warning message.
   * @returns {Promise<T>} The resolved value of `promise`.
   */
  async _raceTimeout(promise, ms, label) {
    const timer = setTimeout(() => {
      this.logger.warn(`⚠️ Etapa "${label}" excedeu ${ms}ms — aguardando conclusão...`);
    }, ms);
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Acquire the git operation lock
   * @returns {boolean} True if lock was acquired, false if already in progress
   */
  acquireGitLock() {
    // Stale-lock auto-recovery: if a previous process crashed mid-operation,
    // the in-process heartbeat is stale. Only recovers on NEXT acquire attempt
    // — never interrupts an active operation.
    if (this.gitOperationInProgress && this.gitSafety && this.gitSafety.checkStaleHeartbeat()) {
      this.logger.warn('🔒 Lock auto-recuperado de processo anterior (heartbeat stale)');
      this.gitOperationInProgress = false;
      if (this._lockTimeout) { clearTimeout(this._lockTimeout); this._lockTimeout = null; }
      this._abortController = null;
    }
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
    if (this.gitSafety) {
      this.gitSafety.startHeartbeat();
    }
    this.logger.info('Git operation lock acquired');
    return true;
  }

  /**
   * Release the git operation lock
   */
  releaseGitLock() {
    if (this.gitSafety) {
      this.gitSafety.stopHeartbeat();
    }
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
   * Check if local branch has commits not yet pushed to remote.
   * Uses local remote-tracking refs only (no network fetch).
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<{success: boolean, hasUnpushed: boolean, currentBranch?: string, localSha?: string, remoteSha?: string}>}
   */
  async gitCheckUnpushed(projectPath) {
    try {
      const fs = require('fs');
      const gitMod = await this._getGit();
      const currentBranch = await gitMod.currentBranch({ fs, dir: projectPath, cache: this._gitCache });
      const localSha = await gitMod.resolveRef({ fs, dir: projectPath, ref: 'HEAD' });
      let remoteSha = null;
      try {
        remoteSha = await gitMod.resolveRef({ fs, dir: projectPath, ref: `refs/remotes/origin/${currentBranch}` });
      } catch (_e) {
        return { success: true, hasUnpushed: true, currentBranch, localSha, remoteSha: null };
      }
      return { success: true, hasUnpushed: localSha !== remoteSha, currentBranch, localSha, remoteSha };
    } catch (error) {
      this.logger.error('Error checking unpushed commits:', error);
      return { success: false, hasUnpushed: false, error: error.message };
    }
  }

  /**
   * Stage all dirty files and create a commit
   * @param {Object} gitMod - isomorphic-git module
   * @param {Object} fs - filesystem module
   * @param {string} projectPath - Path to the git repository
   * @param {string} commitMessage - Commit message
   * @param {Object} author - Author object with name and email
   * @param {string[]|null} [dirtyFiles=null] - Pre-computed list of dirty filepaths.
   *   When provided (non-null and non-empty), the statusMatrix scan is skipped.
   *   Each entry must be either an existing filepath (will be staged with git.add)
   *   or a filepath prefixed with a deletion marker handled by the caller — the
   *   caller is responsible for ensuring each file's working-tree state matches
   *   what is intended. Pass null/[] to fall back to a full statusMatrix scan.
   * @returns {Promise<string|null>} Commit SHA or null if nothing to commit
   * @private
   */
  async _commitAll(gitMod, fs, projectPath, commitMessage, author, dirtyFiles = null) {
    try {
      let dirty;

      if (Array.isArray(dirtyFiles) && dirtyFiles.length > 0) {
        // Caller provided a pre-computed dirty file list — skip the O(n) statusMatrix.
        // Map plain filepaths to the [filepath, head, workdir, stage] shape expected
        // by the batching logic below. workdir=1 (present) by default; deletions are
        // detected per-file in the add/remove step via fs.access.
        dirty = dirtyFiles.map((entry) => {
          if (Array.isArray(entry)) return entry;
          return [entry, 1, 1, 1];
        });
      } else {
        const matrix = await gitMod.statusMatrix({ fs, dir: projectPath, cache: this._gitCache });
        dirty = matrix.filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));
      }

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
    // Lock-first: preserve "already in progress" semantics (existing contract).
    if (!this.acquireGitLock()) {
      this.sendOutput('⚠️ Operação Git já em andamento. Aguarde...');
      return { success: false, error: 'Git operation already in progress. Please wait.' };
    }

    const fs = require('fs');

    let tempBranchCreated = false;
    let tempBranch = null;
    let backupBranch = null;
    try {
      const gitMod = await this._getGit();
      this._gitCache = {};

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

      // Preflight: informational only for push — never hard-block. The body's
      // own fetch/push will surface real auth/network errors. (Test-isolation:
      // prior tests in the same file may leave fetch mocks rejected; treating
      // that as a hard block would break otherwise-valid pushes.)
      let firstPublishFromPreflight = false;
      if (this.gitPreflight) {
        try {
          const preflight = await this.gitPreflight.runPreflightForPreview(null, projectPath);
          if (preflight.warnings && preflight.warnings.length > 0) {
            for (const w of preflight.warnings) this.sendOutput(`⚠️ ${w.message}`);
          }
          firstPublishFromPreflight = !!preflight.firstPublish;
        } catch (preflightErr) {
          if (preflightErr && preflightErr.name === 'AbortError') {
            return { success: false, cancelled: true, message: 'Operation aborted' };
          }
          this.logger.warn('gitPushToBranch: preflight threw (continuing):', preflightErr.message);
        }
      }

      const auth = { username: token, password: 'x-oauth-basic' };

      if (commitMessage) {
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

        this.sendProgress({
          stage: 'committing',
          current: 2,
          total: 6,
          message: 'Criando commit...'
        });

        await this._commitAll(gitMod, fs, projectPath, commitMessage, author);

        if (this.isCancelRequested()) {
          this.logger.info('Push operation cancelled after commit');
          return { success: false, cancelled: true, message: 'Operation cancelled by user' };
        }

        const localSha = await gitMod.resolveRef({ fs, dir: projectPath, ref: 'HEAD' });

        // firstPublish short-circuit: no remote branch yet → push directly.
        if (firstPublishFromPreflight) {
          this.sendOutput('ℹ️ Branch remota não encontrada — criando nova branch.');
        } else {
          this.sendProgress({
            stage: 'fetching',
            current: 3,
            total: 6,
            message: `Buscando alterações remotas de '${targetBranch}'...`
          });

          tempBranchCreated = false;
          tempBranch = `_push_${targetBranch}_${Date.now()}`;
          try {
            this.sendOutput(`📥 Buscando alterações remotas de '${targetBranch}'...`);
            await this._raceTimeout(
              gitMod.fetch({
                fs, http, dir: projectPath, remote: 'origin', ref: targetBranch,
                singleBranch: true, onAuth: () => auth,
              }),
              this.STEP_TIMEOUT_FETCH_MS,
              `fetch origin/${targetBranch}`,
            );
            this._gitCache = {};

            if (this.isCancelRequested()) {
              return { success: false, cancelled: true, message: 'Operation cancelled by user' };
            }

            // Fast-forward detection: skip merge if local is ahead of remote.
            // Vitest throws on accessing undefined mock exports — guard with try/catch.
            let canFF = false;
            try {
              if (typeof gitMod.canFastForward === 'function') {
                canFF = await gitMod.canFastForward({
                  fs, dir: projectPath,
                  ref: `origin/${targetBranch}`,
                  target: 'HEAD',
                });
              }
            } catch (_ffErr) { canFF = false; }
            if (canFF) {
              this.sendOutput('⚡ Modo rápido');
            } else {
              this.sendProgress({
                stage: 'pulling',
                current: 4,
                total: 6,
                message: 'Integrando alterações (suas alterações têm prioridade)...'
              });

              try { await gitMod.deleteBranch({ fs, dir: projectPath, ref: tempBranch }); } catch (_e) { /* not existent */ }
              await this._raceTimeout(
                gitMod.checkout({ fs, dir: projectPath, ref: `origin/${targetBranch}` }),
                this.STEP_TIMEOUT_CHECKOUT_MS,
                `checkout origin/${targetBranch}`,
              );
              await gitMod.branch({ fs, dir: projectPath, ref: tempBranch, checkout: true });
              tempBranchCreated = true;

              this.sendOutput('🔀 Mesclando alterações (suas alterações vencem conflitos)...');
              try {
                await this._raceTimeout(
                  gitMod.merge({
                    fs, dir: projectPath,
                    ours: tempBranch,
                    theirs: localSha,
                    fastForward: false,
                    ...(theirsMergeDriver ? { mergeDriver: theirsMergeDriver } : {}),
                    message: `Merge publish (${targetBranch}) — ${new Date().toISOString()}`,
                    author,
                  }),
                  this.STEP_TIMEOUT_MERGE_MS,
                  `merge publish ${targetBranch}`,
                );
              } catch (mergeErr) {
                if (mergeErr.code === 'MergeConflictError' || mergeErr.name === 'MergeConflictError') {
                  this.sendOutput('⚠️ Conflito binário detectado — usando sua versão.');
                  const conflictFiles = Array.isArray(mergeErr.data) ? mergeErr.data : [];
                  for (const filepath of conflictFiles) {
                    try {
                      await resolveBinaryTheirs(gitMod, fs, projectPath, filepath, localSha);
                    } catch (resolveErr) {
                      this.logger.warn(`Could not resolve binary ${filepath}: ${resolveErr.message}`);
                    }
                  }
                  await gitMod.commit({
                    fs, dir: projectPath,
                    message: `Merge publish (binary resolved) — ${new Date().toISOString()}`,
                    author,
                    parent: [tempBranch, localSha],
                  });
                } else {
                  throw mergeErr;
                }
              }
            }
          } catch (fetchErr) {
            if (!fetchErr.message.includes('Could not find') &&
                !fetchErr.message.includes('not found') &&
                !fetchErr.message.includes('404')) {
              if (tempBranchCreated) {
                try {
                  await gitMod.checkout({ fs, dir: projectPath, ref: targetBranch });
                  await gitMod.deleteBranch({ fs, dir: projectPath, ref: tempBranch });
                  tempBranchCreated = false;
                } catch (_e) { /* ignore cleanup */ }
              }
              throw fetchErr;
            }
            this.sendOutput('ℹ️ Branch remota não encontrada — criando nova branch.');
          }
        }
      }

      if (this.isCancelRequested()) {
        this.logger.info('Push operation cancelled before push');
        return { success: false, cancelled: true, message: 'Operation cancelled by user' };
      }

      this.sendProgress({
        stage: 'pushing',
        current: commitMessage ? 5 : 1,
        total: commitMessage ? 6 : 2,
        message: `Publicando na branch '${targetBranch}'...`
      });

      this.sendOutput(`🚀 Publicando alterações na branch: ${targetBranch}...`);

      const pushRef = tempBranchCreated ? tempBranch : targetBranch;
      await this._raceTimeout(
        gitMod.push({
          fs, http, dir: projectPath, remote: 'origin', ref: pushRef, remoteRef: targetBranch,
          force: false, ...(this.getAbortSignal() ? { signal: this.getAbortSignal() } : {}),
          onAuth: () => auth,
        }),
        this.STEP_TIMEOUT_PUSH_MS,
        `push ${targetBranch}`,
      );
      this._gitCache = {};

      this.sendProgress({
        stage: 'complete',
        current: commitMessage ? 6 : 2,
        total: commitMessage ? 6 : 2,
        message: 'Push concluído com sucesso!'
      });

      this.sendOutput(`✅ Push concluído com sucesso na branch: ${targetBranch}`);
      this.logger.info(`Successfully pushed to branch: ${targetBranch}`);

      this._gitCache = {};
      if (tempBranchCreated) {
        try {
          if (this.gitSafety) {
            const result = await this.gitSafety._safeResetOrCheckout(
              gitMod, fs, projectPath, `origin/${targetBranch}`, { author: { name: 'documental', email: 'documental@app' } }
            );
            backupBranch = result.backupBranch;
          } else {
            await this._hardResetBranch(projectPath, `origin/${targetBranch}`);
          }
          await gitMod.deleteBranch({ fs, dir: projectPath, ref: tempBranch });
          tempBranchCreated = false;
        } catch (_e) {
          this.logger.warn('Post-publish sync failed:', _e.message);
        }
      }
      this._gitCache = {};

      if (backupBranch && this.gitSafety) {
        await this.gitSafety.cleanupBackupBranch(gitMod, fs, projectPath, backupBranch);
        backupBranch = null;
      }

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
      if (tempBranchCreated) {
        try {
          const gitMod2 = await this._getGit();
          this._gitCache = {};
          try { await gitMod2.checkout({ fs, dir: projectPath, ref: targetBranch }); }
          catch (_e) {
            try { await gitMod2.checkout({ fs, dir: projectPath, ref: targetBranch, force: true }); }
            catch (_e2) { /* ignore */ }
          }
          try {
            if (this.gitSafety) {
              await this.gitSafety._safeResetOrCheckout(gitMod2, fs, projectPath, `origin/${targetBranch}`);
            } else {
              await this._hardResetBranch(projectPath, `origin/${targetBranch}`);
            }
          } catch (_e2) { /* origin ref may not exist */ }
          try { await gitMod2.deleteBranch({ fs, dir: projectPath, ref: tempBranch }); } catch (_e3) { /* ignore */ }
        } catch (_e) { /* best effort */ }
      }
      this._gitCache = {};
      this.releaseGitLock();
    }
  }

  /**
   * List remote branches
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<Array<string>>} List of remote branch names
   */
  /**
   * Refresh the local preview workspace from origin/preview.
   *
   * Workflow:
   *  1. If not on preview branch, check for dirty tree (unless force=true).
   *  2. Checkout preview.
   *  3. Shallow fetch origin/preview with AbortSignal.
   *  4. Hard reset to origin/preview.
   *
   * @param {number|string} projectId - Project ID (resolved to working directory).
   * @param {boolean} [force=false] - When true, discard local changes silently.
   * @returns {Promise<{success: boolean, branch?: string, code?: string, files?: string[], cancelled?: boolean, error?: string}>}
   */
  async gitRefresh(projectId, force = false) {
    const fs = require('fs');
    let projectPath;
    try {
      projectPath = await this.getProjectPath(projectId);
    } catch (error) {
      this.sendOutput(`❌ Erro ao resolver caminho do projeto: ${error.message}`);
      return { success: false, error: error.message };
    }

    // Pre-lock: resolve token so missing-token fails fast without holding the
    // lock. Preflight is intentionally NOT invoked here: refresh is a recovery
    // operation that must run even when publish-preflight would block. The
    // safety wrapper (_safeResetOrCheckout) below is the authoritative
    // data-loss guard.
    let token = null;
    try {
      token = await this.gitOps.getGitHubToken();
    } catch (tokenErr) {
      this.logger.warn('gitRefresh: token lookup failed:', tokenErr.message);
    }

    if (!this.acquireGitLock()) {
      this.sendOutput('⚠️ Operação Git já em andamento. Aguarde...');
      return { success: false, error: 'Git operation already in progress. Please wait.' };
    }
    try {
      const gitMod = await this._getGit();
      const signal = this.getAbortSignal();

      const current = await gitMod.currentBranch({ fs, dir: projectPath, cache: this._gitCache });

      if (current !== BRANCH_PREVIEW) {
        if (!force) {
          const matrix = await gitMod.statusMatrix({ fs, dir: projectPath, cache: this._gitCache });
          const dirtyFiles = matrix
            .filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))
            .map(([filepath]) => filepath);
          if (dirtyFiles.length > 0) {
            this.sendOutput(`⚠️ ${dirtyFiles.length} arquivo(s) modificado(s) localmente.`);
            return { success: false, code: 'DIRTY_LOCAL', files: dirtyFiles };
          }
        }
        this.sendOutput(`📥 Mudando para branch ${BRANCH_PREVIEW}...`);
        await this._raceTimeout(
          gitMod.checkout({ fs, dir: projectPath, ref: BRANCH_PREVIEW }),
          this.STEP_TIMEOUT_CHECKOUT_MS,
          `checkout ${BRANCH_PREVIEW}`,
        );
      }

      const auth = token ? { username: token, password: 'x-oauth-basic' } : undefined;
      this.sendOutput(`📥 Buscando alterações de origin/${BRANCH_PREVIEW}...`);
      await this._raceTimeout(
        gitMod.fetch({
          fs, http, dir: projectPath, remote: 'origin', ref: BRANCH_PREVIEW,
          singleBranch: true, depth: 1, ...(signal ? { signal } : {}), ...(auth ? { onAuth: () => auth } : {}),
        }),
        this.STEP_TIMEOUT_FETCH_MS,
        `fetch origin/${BRANCH_PREVIEW}`,
      );
      this._gitCache = {};

      if (this.isCancelRequested()) {
        return { success: false, cancelled: true, message: 'Operation cancelled by user' };
      }

      // Divergence detection: warn loudly before any destructive op. Conservative
      // heuristic — the safety wrapper below preserves a backup either way; this
      // warning is for user observability. Vitest throws on accessing undefined
      // mock exports — guard with try/catch.
      try {
        const localHead = await gitMod.resolveRef({ fs, dir: projectPath, ref: 'HEAD', cache: this._gitCache });
        let remoteHead = null;
        try {
          remoteHead = await gitMod.resolveRef({ fs, dir: projectPath, ref: `refs/remotes/origin/${BRANCH_PREVIEW}`, cache: this._gitCache });
        } catch (_e) { /* remote ref may not exist */ }
        if (remoteHead && remoteHead !== localHead) {
          try {
            if (typeof gitMod.canFastForward !== 'function') {
              this.sendOutput(`⚠️ Divergência significativa detectada — backup criado`);
            } else {
              const canFF = await gitMod.canFastForward({
                fs, dir: projectPath, ref: BRANCH_PREVIEW, target: `origin/${BRANCH_PREVIEW}`,
              });
              if (!canFF) this.sendOutput(`⚠️ Divergência significativa detectada — backup criado`);
            }
          } catch (_e) { this.sendOutput(`⚠️ Divergência significativa detectada — backup criado`); }
        }
      } catch (_e) { /* best-effort divergence detection */ }

      this.sendOutput(`🔄 Atualizando para origin/${BRANCH_PREVIEW}...`);
      if (this.gitSafety) {
        await this.gitSafety._safeResetOrCheckout(gitMod, fs, projectPath, `origin/${BRANCH_PREVIEW}`);
      } else {
        await this._hardResetBranch(projectPath, `origin/${BRANCH_PREVIEW}`);
      }

      this.sendOutput(`✅ Atualizado para origin/${BRANCH_PREVIEW}`);
      return { success: true, branch: BRANCH_PREVIEW };
    } catch (error) {
      if (error.name === 'AbortError') {
        return { success: false, cancelled: true, message: 'Operation aborted' };
      }
      this.logger.error('Error in gitRefresh:', error);
      this.sendOutput(`❌ Erro ao atualizar: ${error.message}`);
      return { success: false, error: error.message };
    } finally {
      this.releaseGitLock();
    }
  }

  /**
   * Publish local changes to the preview branch.
   *
   * Workflow (with retry on non-fast-forward up to MAX_PUBLISH_RETRIES):
   *  1. Ensure on preview branch; commit local changes (if any).
   *  2. Fetch origin/preview shallow.
   *  3. Create temp branch `publish-preview` from origin/preview.
   *  4. Merge local commit with theirsMergeDriver (publisher wins conflicts).
   *     Binary fallback via resolveBinaryTheirs on MergeConflictError.
   *  5. Push temp branch HEAD to remote preview (NEVER force).
   *
   * Temp branch is always cleaned up in finally.
   *
   * @param {number|string} projectId - Project ID (resolved to working directory).
   * @param {string} commitMessage - Commit message for local changes.
   * @returns {Promise<{success: boolean, branch?: string, commitSha?: string, cancelled?: boolean, error?: string}>}
   */
  async gitPublishPreview(projectId, commitMessage) {
    const fs = require('fs');
    let projectPath;
    try {
      projectPath = await this.getProjectPath(projectId);
    } catch (error) {
      this.sendOutput(`❌ Erro ao resolver caminho do projeto: ${error.message}`);
      return { success: false, error: error.message };
    }

    // Pre-lock: token + user config (fail fast without holding the lock).
    let token = null;
    let userConfigured = false;
    try {
      [token, userConfigured] = await Promise.all([
        this.gitOps.getGitHubToken(),
        this.gitOps.configureGitForUser(projectPath),
      ]);
    } catch (preErr) {
      this.logger.warn('gitPublishPreview: pre-lock setup failed:', preErr.message);
    }
    if (!token) {
      return { success: false, error: 'GitHub authentication required' };
    }

    // Pre-lock: preflight (block on hard errors; firstPublish short-circuits merge).
    let firstPublishFromPreflight = false;
    if (this.gitPreflight) {
      try {
        const preflight = await this.gitPreflight.runPreflightForPreview(projectId, projectPath);
        if (preflight.warnings && preflight.warnings.length > 0) {
          for (const w of preflight.warnings) this.sendOutput(`⚠️ ${w.message}`);
        }
        if (!preflight.canProceed) {
          if (preflight.aborted) {
            return { success: false, cancelled: true, message: 'Operation aborted' };
          }
          const msg = (preflight.errors[0] && preflight.errors[0].message) || 'Preflight falhou';
          this.sendOutput(`❌ ${msg}`);
          return { success: false, error: msg, code: preflight.errors[0] && preflight.errors[0].code };
        }
        firstPublishFromPreflight = !!preflight.firstPublish;
      } catch (preflightErr) {
        if (preflightErr && preflightErr.name === 'AbortError') {
          return { success: false, cancelled: true, message: 'Operation aborted' };
        }
        this.logger.warn('gitPublishPreview: preflight threw (continuing):', preflightErr.message);
      }
    }

    if (!this.acquireGitLock()) {
      return { success: false, error: 'Git operation already in progress. Please wait.' };
    }

    let tempBranchCreated = false;
    let originalBranch = null;
    let backupBranch = null;
    try {
      const gitMod = await this._getGit();
      const signal = this.getAbortSignal();
      const auth = { username: token, password: 'x-oauth-basic' };

      if (!userConfigured) {
        this.logger.warn('Could not configure git user, proceeding with existing config');
      }

      originalBranch = await gitMod.currentBranch({ fs, dir: projectPath, cache: this._gitCache });
      if (originalBranch !== BRANCH_PREVIEW) {
        this.sendOutput(`📥 Mudando para branch ${BRANCH_PREVIEW}...`);
        await this._raceTimeout(
          gitMod.checkout({ fs, dir: projectPath, ref: BRANCH_PREVIEW }),
          this.STEP_TIMEOUT_CHECKOUT_MS,
          `checkout ${BRANCH_PREVIEW}`,
        );
      }

      this.sendOutput('📝 Preparando commit...');
      const [authorName, authorEmail] = await Promise.all([
        gitMod.getConfig({ fs, dir: projectPath, path: 'user.name', cache: this._gitCache }).then((v) => v || 'documental'),
        gitMod.getConfig({ fs, dir: projectPath, path: 'user.email', cache: this._gitCache }).then((v) => v || 'documental@app'),
      ]);
      const author = { name: authorName, email: authorEmail };
      let localSha = await this._commitAll(gitMod, fs, projectPath, commitMessage, author).catch((e) => {
        throw e;
      });
      if (!localSha) {
        localSha = await gitMod.resolveRef({ fs, dir: projectPath, ref: 'HEAD' });
        this.sendOutput('ℹ️ Nenhuma alteração nova; usando HEAD atual.');
      }

      // firstPublish short-circuit: no remote preview yet → push directly.
      if (firstPublishFromPreflight) {
        this.sendOutput('ℹ️ Branch preview não existe no remoto — criando.');
        this.sendOutput(`🚀 Publicando em ${BRANCH_PREVIEW}...`);
        await this._raceTimeout(
          gitMod.push({
            fs, http, dir: projectPath, remote: 'origin', ref: BRANCH_PREVIEW, remoteRef: BRANCH_PREVIEW,
            force: false, ...(signal ? { signal } : {}), onAuth: () => auth,
          }),
          this.STEP_TIMEOUT_PUSH_MS,
          `push ${BRANCH_PREVIEW}`,
        );
        this._gitCache = {};
        this.sendOutput(`✅ Publicado em ${BRANCH_PREVIEW}`);
        return { success: true, branch: BRANCH_PREVIEW, commitSha: localSha };
      }

      let lastError = null;
      for (let attempt = 1; attempt <= MAX_PUBLISH_RETRIES; attempt++) {
        try {
          this.sendOutput(`📥 Buscando origin/${BRANCH_PREVIEW}...`);
          await this._raceTimeout(
            gitMod.fetch({
              fs, http, dir: projectPath, remote: 'origin', ref: BRANCH_PREVIEW,
              singleBranch: true, depth: 1, ...(signal ? { signal } : {}), onAuth: () => auth,
            }),
            this.STEP_TIMEOUT_FETCH_MS,
            `fetch origin/${BRANCH_PREVIEW}`,
          );
          this._gitCache = {};

          // Fast-forward detection: skip merge if local is ahead of remote.
          // Vitest throws on accessing undefined mock exports — guard with try/catch.
          let canFF = false;
          try {
            if (typeof gitMod.canFastForward === 'function') {
              const originSha = await gitMod.resolveRef({ fs, dir: projectPath, ref: `origin/${BRANCH_PREVIEW}`, cache: this._gitCache });
              canFF = await gitMod.canFastForward({
                fs, dir: projectPath, ref: `origin/${BRANCH_PREVIEW}`, target: localSha,
              });
              void originSha;
            }
          } catch (_ffErr) { canFF = false; }
          if (canFF) {
            this.sendOutput('⚡ Modo rápido');
            this.sendOutput(`🚀 Publicando em ${BRANCH_PREVIEW}...`);
            await this._raceTimeout(
              gitMod.push({
                fs, http, dir: projectPath, remote: 'origin', ref: BRANCH_PREVIEW, remoteRef: BRANCH_PREVIEW,
                force: false, ...(signal ? { signal } : {}), onAuth: () => auth,
              }),
              this.STEP_TIMEOUT_PUSH_MS,
              `push ${BRANCH_PREVIEW}`,
            );
            this._gitCache = {};
            this.sendOutput(`✅ Publicado em ${BRANCH_PREVIEW}`);
            return { success: true, branch: BRANCH_PREVIEW, commitSha: localSha };
          }

          try { await gitMod.deleteBranch({ fs, dir: projectPath, ref: TEMP_PUBLISH_BRANCH }); } catch (_e) { /* not existent — ok */ }
          await this._raceTimeout(
            gitMod.checkout({ fs, dir: projectPath, ref: `origin/${BRANCH_PREVIEW}` }),
            this.STEP_TIMEOUT_CHECKOUT_MS,
            `checkout origin/${BRANCH_PREVIEW}`,
          );
          await gitMod.branch({ fs, dir: projectPath, ref: TEMP_PUBLISH_BRANCH, checkout: true });
          tempBranchCreated = true;

          this.sendOutput('🔀 Mesclando alterações (estratégia: theirs)...');
          try {
            await this._raceTimeout(
              gitMod.merge({
                fs, dir: projectPath,
                ours: TEMP_PUBLISH_BRANCH,
                theirs: localSha,
                fastForward: false,
                ...(theirsMergeDriver ? { mergeDriver: theirsMergeDriver } : {}),
                message: `Merge publish (preview) — ${new Date().toISOString()}`,
                author,
              }),
              this.STEP_TIMEOUT_MERGE_MS,
              `merge publish ${BRANCH_PREVIEW}`,
            );
          } catch (mergeErr) {
            if (mergeErr.code === 'MergeConflictError' || mergeErr.name === 'MergeConflictError') {
              this.sendOutput('⚠️ Conflito binário detectado — usando versão do publicador.');
              const conflictFiles = Array.isArray(mergeErr.data) ? mergeErr.data : [];
              for (const filepath of conflictFiles) {
                try {
                  await resolveBinaryTheirs(gitMod, fs, projectPath, filepath, localSha);
                } catch (resolveErr) {
                  this.logger.warn(`Could not resolve binary ${filepath}: ${resolveErr.message}`);
                }
              }
              await gitMod.commit({
                fs, dir: projectPath,
                message: `Merge publish (binary resolved) — ${new Date().toISOString()}`,
                author,
                parent: [TEMP_PUBLISH_BRANCH, localSha],
              });
            } else {
              throw mergeErr;
            }
          }

          this.sendOutput(`🚀 Publicando em ${BRANCH_PREVIEW}...`);
          await this._raceTimeout(
            gitMod.push({
              fs, http, dir: projectPath, remote: 'origin', ref: TEMP_PUBLISH_BRANCH, remoteRef: BRANCH_PREVIEW,
              force: false, ...(signal ? { signal } : {}), onAuth: () => auth,
            }),
            this.STEP_TIMEOUT_PUSH_MS,
            `push ${BRANCH_PREVIEW}`,
          );
          this._gitCache = {};

          this.sendOutput(`✅ Publicado em ${BRANCH_PREVIEW}`);

          // Backup any uncommitted/unpushed state before the post-publish cleanup
          // deletes the temp branch.
          if (this.gitSafety) {
            try {
              const result = await this.gitSafety._safeResetOrCheckout(
                gitMod, fs, projectPath, `origin/${BRANCH_PREVIEW}`, { author }
              );
              backupBranch = result.backupBranch;
            } catch (_safeErr) { /* best-effort */ }
          }

          if (backupBranch && this.gitSafety) {
            await this.gitSafety.cleanupBackupBranch(gitMod, fs, projectPath, backupBranch);
            backupBranch = null;
          }

          return { success: true, branch: BRANCH_PREVIEW, commitSha: localSha };
        } catch (attemptErr) {
          lastError = attemptErr;
          const msg = attemptErr.message || '';
          if (msg.includes('non-fast-forward') || msg.includes('fetch first') || attemptErr.code === 'PushRejectedError') {
            this.sendOutput(`⚠️ Push rejeitado (tentativa ${attempt}/${MAX_PUBLISH_RETRIES}). Re-tentando...`);
            if (tempBranchCreated) {
              try {
                await gitMod.checkout({ fs, dir: projectPath, ref: BRANCH_PREVIEW });
                await gitMod.deleteBranch({ fs, dir: projectPath, ref: TEMP_PUBLISH_BRANCH });
              } catch (_e) { /* ignore cleanup errors */ }
              tempBranchCreated = false;
            }
            continue;
          }
          throw attemptErr;
        }
      }
      throw lastError || new Error('Publish failed after retries');
    } catch (error) {
      if (error.name === 'AbortError') {
        return { success: false, cancelled: true, message: 'Operation aborted' };
      }
      this.logger.error('Error in gitPublishPreview:', error);
      this.sendOutput(`❌ Erro ao publicar: ${error.message}`);
      return { success: false, error: error.message };
    } finally {
      try {
        const gitMod = await this._getGit();
        if (tempBranchCreated) {
          try {
            const current = await gitMod.currentBranch({ fs, dir: projectPath, cache: this._gitCache });
            if (current === TEMP_PUBLISH_BRANCH) {
              await gitMod.checkout({ fs, dir: projectPath, ref: BRANCH_PREVIEW });
            }
            await gitMod.deleteBranch({ fs, dir: projectPath, ref: TEMP_PUBLISH_BRANCH });
          } catch (_e) { /* ignore cleanup errors */ }
        } else if (originalBranch && originalBranch !== BRANCH_PREVIEW) {
          try { await gitMod.checkout({ fs, dir: projectPath, ref: BRANCH_PREVIEW }); } catch (_e) { /* ignore */ }
        }
        if (backupBranch && this.gitSafety) {
          await this.gitSafety.cleanupBackupBranch(gitMod, fs, projectPath, backupBranch);
        }
      } catch (_e) { /* best-effort cleanup */ }
      this.releaseGitLock();
    }
  }

  /**
   * Promote preview branch content to main.
   *
   * Workflow:
   *  1. Pre-check permission via PermissionHandlers (defense in depth).
   *  2. Fetch main and preview shallow (parallel).
   *  3. Checkout main; hard reset to origin/main.
   *  4. Merge origin/preview with --no-ff (NO theirs driver — main is sacred;
   *     any conflict is a hard error).
   *  5. Push main (NEVER force).
   *
   * Always returns to preview workspace in finally.
   *
   * @param {number|string} projectId - Project ID (resolved to working directory).
   * @returns {Promise<{success: boolean, branch?: string, code?: string, cancelled?: boolean, error?: string}>}
   */
  async gitPublishMain(projectId) {
    const fs = require('fs');
    let projectPath;
    try {
      projectPath = await this.getProjectPath(projectId);
    } catch (error) {
      this.sendOutput(`❌ Erro ao resolver caminho do projeto: ${error.message}`);
      return { success: false, error: error.message };
    }

    // Pre-lock: token (fail fast without the lock).
    let token = null;
    try {
      token = await this.gitOps.getGitHubToken();
    } catch (tokenErr) {
      this.logger.warn('gitPublishMain: token lookup failed:', tokenErr.message);
    }
    if (!token) {
      return { success: false, error: 'GitHub authentication required' };
    }

    // Pre-lock: permission gate (now before lock).
    if (projectId && this.permissionHandlers) {
      try {
        const perm = await this.permissionHandlers.checkMainPermission(projectId);
        if (!perm || !perm.canPushToMain) {
          this.sendOutput('❌ Sem permissão para publicar em main.');
          return { success: false, code: 'PERMISSION_DENIED' };
        }
      } catch (permErr) {
        this.logger.error('checkMainPermission threw:', permErr);
        return { success: false, code: 'PERMISSION_DENIED', error: permErr.message };
      }
    }

    // Pre-lock: preflight. Hard-block on MAIN_MISSING (no body-side equivalent)
    // and PREVIEW_NOT_AHEAD (preview must be published first — user requirement:
    // "o usuário só possa fazer publicação para main depois de já ter feito
    // para preview"). Other errors (FETCH_FAILED, PRECEDENCE_CHECK_FAILED) fall
    // through: the body's fetch+merge will surface the real failure.
    if (this.gitPreflight) {
      try {
        const preflight = await this.gitPreflight.runPreflightForMain(projectId, projectPath, this.permissionHandlers);
        if (preflight.warnings && preflight.warnings.length > 0) {
          for (const w of preflight.warnings) this.sendOutput(`⚠️ ${w.message}`);
        }
        if (!preflight.canProceed) {
          if (preflight.aborted) {
            return { success: false, cancelled: true, message: 'Operation aborted' };
          }
          const mainMissing = (preflight.errors || []).find((e) => e.code === 'MAIN_MISSING');
          if (mainMissing) {
            this.sendOutput(`❌ ${mainMissing.message}`);
            return { success: false, code: 'MAIN_MISSING', error: mainMissing.message };
          }
          const previewNotAhead = (preflight.errors || []).find((e) => e.code === 'PREVIEW_NOT_AHEAD');
          if (previewNotAhead) {
            this.sendOutput(`❌ ${previewNotAhead.message}`);
            return { success: false, code: 'PREVIEW_NOT_AHEAD', error: previewNotAhead.message };
          }
        }
      } catch (preflightErr) {
        if (preflightErr && preflightErr.name === 'AbortError') {
          return { success: false, cancelled: true, message: 'Operation aborted' };
        }
        this.logger.warn('gitPublishMain: preflight threw (continuing):', preflightErr.message);
      }
    }

    if (!this.acquireGitLock()) {
      return { success: false, error: 'Git operation already in progress. Please wait.' };
    }
    let backupBranch = null;
    try {
      const gitMod = await this._getGit();
      const signal = this.getAbortSignal();
      const auth = { username: token, password: 'x-oauth-basic' };

      this.sendOutput(`📥 Buscando origin/${BRANCH_MAIN} e origin/${BRANCH_PREVIEW}...`);
      await Promise.all([
        this._raceTimeout(
          gitMod.fetch({ fs, http, dir: projectPath, remote: 'origin', ref: BRANCH_MAIN, singleBranch: true, depth: 1, ...(signal ? { signal } : {}), onAuth: () => auth }),
          this.STEP_TIMEOUT_FETCH_MS,
          `fetch origin/${BRANCH_MAIN}`,
        ),
        this._raceTimeout(
          gitMod.fetch({ fs, http, dir: projectPath, remote: 'origin', ref: BRANCH_PREVIEW, singleBranch: true, depth: 1, ...(signal ? { signal } : {}), onAuth: () => auth }),
          this.STEP_TIMEOUT_FETCH_MS,
          `fetch origin/${BRANCH_PREVIEW}`,
        ),
      ]);
      this._gitCache = {};

      this.sendOutput(`🔄 Sincronizando ${BRANCH_MAIN}...`);
      await this._raceTimeout(
        gitMod.checkout({ fs, dir: projectPath, ref: BRANCH_MAIN }),
        this.STEP_TIMEOUT_CHECKOUT_MS,
        `checkout ${BRANCH_MAIN}`,
      );
      if (this.gitSafety) {
        const result = await this.gitSafety._safeResetOrCheckout(gitMod, fs, projectPath, `origin/${BRANCH_MAIN}`);
        backupBranch = result.backupBranch;
      } else {
        await this._hardResetBranch(projectPath, `origin/${BRANCH_MAIN}`);
      }

      this.sendOutput(`🔀 Promovendo ${BRANCH_PREVIEW} → ${BRANCH_MAIN}...`);
      const [authorName, authorEmail] = await Promise.all([
        gitMod.getConfig({ fs, dir: projectPath, path: 'user.name', cache: this._gitCache }).then((v) => v || 'documental'),
        gitMod.getConfig({ fs, dir: projectPath, path: 'user.email', cache: this._gitCache }).then((v) => v || 'documental@app'),
      ]);
      try {
        await this._raceTimeout(
          gitMod.merge({
            fs,
            dir: projectPath,
            ours: BRANCH_MAIN,
            theirs: `origin/${BRANCH_PREVIEW}`,
            fastForward: false,
            message: `Promote preview to main — ${new Date().toISOString()}`,
            author: { name: authorName, email: authorEmail },
          }),
          this.STEP_TIMEOUT_MERGE_MS,
          `merge promote ${BRANCH_PREVIEW}→${BRANCH_MAIN}`,
        );
      } catch (_mergeErr) {
        this.sendOutput('❌ Conflito ao integrar Preview em Main. Verifique manualmente.');
        return { success: false, code: 'MAIN_MERGE_CONFLICT', error: 'Merge conflict promoting preview to main' };
      }

      this.sendOutput(`🚀 Publicando em ${BRANCH_MAIN}...`);
      await this._raceTimeout(
        gitMod.push({
          fs,
          http,
          dir: projectPath,
          remote: 'origin',
          ref: BRANCH_MAIN,
          force: false,
          ...(signal ? { signal } : {}),
          onAuth: () => auth,
        }),
        this.STEP_TIMEOUT_PUSH_MS,
        `push ${BRANCH_MAIN}`,
      );
      this._gitCache = {};

      this.sendOutput(`✅ ${BRANCH_PREVIEW} promovido para ${BRANCH_MAIN}`);

      if (backupBranch && this.gitSafety) {
        await this.gitSafety.cleanupBackupBranch(gitMod, fs, projectPath, backupBranch);
        backupBranch = null;
      }

      return { success: true, branch: BRANCH_MAIN };
    } catch (error) {
      if (error.name === 'AbortError') {
        return { success: false, cancelled: true, message: 'Operation aborted' };
      }
      const msg = error.message || '';
      if (msg.includes('403') || msg.includes('protected branch')) {
        this.sendOutput('❌ Sem permissão (branch protegida).');
        return { success: false, code: 'PERMISSION_DENIED', error: msg };
      }
      this.logger.error('Error in gitPublishMain:', error);
      this.sendOutput(`❌ Erro ao publicar em main: ${error.message}`);
      return { success: false, error: error.message };
    } finally {
      try {
        const gitMod = await this._getGit();
        if (this.gitSafety) {
          await this.gitSafety._safeResetOrCheckout(gitMod, fs, projectPath, `origin/${BRANCH_PREVIEW}`);
        } else {
          await gitMod.checkout({ fs, dir: projectPath, ref: BRANCH_PREVIEW });
          await this._hardResetBranch(projectPath, `origin/${BRANCH_PREVIEW}`);
        }
      } catch (_e) { /* best effort */ }
      if (backupBranch && this.gitSafety) {
        try {
          const gitMod = await this._getGit();
          await this.gitSafety.cleanupBackupBranch(gitMod, fs, projectPath, backupBranch);
        } catch (_e) { /* ignore */ }
      }
      this.releaseGitLock();
    }
  }

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

    ipcMain.handle('git:check-unpushed', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        return await this.gitCheckUnpushed(projectPath);
      } catch (error) {
        this.logger.error('Error in git:check-unpushed handler:', error);
        return { success: false, hasUnpushed: false, error: error.message };
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

    ipcMain.handle('git:refresh', async (event, projectId, force) => {
      try {
        return await this.gitRefresh(projectId, !!force);
      } catch (error) {
        this.logger.error('Error in git:refresh handler:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('git:publish-preview', async (event, projectId, commitMessage) => {
      try {
        return await this.gitPublishPreview(projectId, commitMessage);
      } catch (error) {
        this.logger.error('Error in git:publish-preview handler:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('git:publish-main', async (event, projectId) => {
      try {
        return await this.gitPublishMain(projectId);
      } catch (error) {
        this.logger.error('Error in git:publish-main handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Preflight check for publishing to main — runs runPreflightForMain
     * without performing the actual publish. Used by the renderer setup
     * modal so the user sees precedence errors before opening the exec modal.
     */
    ipcMain.handle('git:check-publish-main', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        if (this.gitPreflight && this.permissionHandlers) {
          return await this.gitPreflight.runPreflightForMain(projectId, projectPath, this.permissionHandlers);
        }
        return { canProceed: true, checks: [], warnings: [], errors: [] };
      } catch (error) {
        this.logger.error('Error in git:check-publish-main:', error);
        return {
          canProceed: false,
          checks: [],
          warnings: [],
          errors: [{ code: 'PREFLIGHT_ERROR', message: error.message }],
        };
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

    // Security: raw git module never leaked to renderer — only these 3 channels.
    ipcMain.handle('git:backup-list', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const gitMod = await this._getGit();
        const fs = require('fs');
        const backups = this.gitSafety
          ? await this.gitSafety.listBackups(gitMod, fs, projectPath)
          : [];
        return { success: true, backups };
      } catch (error) {
        this.logger.error('Error in git:backup-list:', error);
        return { success: false, error: error.message, backups: [] };
      }
    });

    ipcMain.handle('git:backup-restore', async (event, projectId, backupBranch) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const gitMod = await this._getGit();
        const fs = require('fs');
        if (!this.gitSafety) {
          throw new Error('GitSafety unavailable');
        }
        await this.gitSafety.restoreBackup(gitMod, fs, projectPath, backupBranch);
        return { success: true };
      } catch (error) {
        this.logger.error('Error in git:backup-restore:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('git:backup-delete', async (event, projectId, backupBranch) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const gitMod = await this._getGit();
        const fs = require('fs');
        if (!this.gitSafety) {
          throw new Error('GitSafety unavailable');
        }
        await this.gitSafety.deleteBackup(gitMod, fs, projectPath, backupBranch);
        return { success: true };
      } catch (error) {
        this.logger.error('Error in git:backup-delete:', error);
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
    ipcMain.removeHandler('git:check-unpushed');
    ipcMain.removeHandler('git:pull-from-preview');
    ipcMain.removeHandler('git:push-to-branch');
    ipcMain.removeHandler('git:refresh');
    ipcMain.removeHandler('git:publish-preview');
    ipcMain.removeHandler('git:publish-main');
    ipcMain.removeHandler('git:check-publish-main');
    ipcMain.removeHandler('git:list-remote-branches');
    ipcMain.removeHandler('git:cancel-operation');
    ipcMain.removeHandler('git:backup-list');
    ipcMain.removeHandler('git:backup-restore');
    ipcMain.removeHandler('git:backup-delete');
    
    this.logger.info('✅ Git operations IPC handlers unregistered');
  }
}

module.exports = { GitHandlers };