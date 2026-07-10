/**
 * @fileoverview Process management for project operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { spawn } = require('child_process');
const { execa } = require('execa');
const fs = require('fs');
const path = require('path');
const { rimraf } = require('rimraf');
const { PlatformService } = require('../main/services/platform/PlatformService');

const fsp = fs.promises;


// Global state
let globalDevServerUrl = null;
let activeProcesses = {};
let activeDocumentalProcesses = {};
let processManagerLock = false;

/**
 * Acquire the process manager lock to prevent concurrent killAll races
 * @param {string} operation - Name of the operation requesting the lock (used in error message)
 * @throws {Error} If another operation is already holding the lock (message: "Process manager busy: <operation>")
 */
function acquireProcessManagerLock(operation) {
  if (processManagerLock) {
    throw new Error('Process manager busy: ' + operation);
  }
  processManagerLock = true;
}

/**
 * Release the process manager lock
 */
function releaseProcessManagerLock() {
  processManagerLock = false;
}

/**
 * Process Manager Class
 */
class ProcessManager {
  /**
   * Create an instance of ProcessManager
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.nodeDetectionService - Node.js detection service
   */
  constructor({ logger, nodeDetectionService, killProcessTree }) {
    this.logger = logger;
    this.nodeDetectionService = nodeDetectionService;
    this.platformService = new PlatformService({ logger });
    /** @type {Function|undefined} Optional injection for tests — defaults to killProcessTree from require */
    this._killProcessTree = killProcessTree;
    this.processesFile = this.platformService.joinPath(this.platformService.getHomeDirectory(), '.documental-processes.json');
    (async () => {
      await this.loadDocumentalProcesses();
    })();
  }

  /**
   * Load Documental processes from file
   * @returns {Object} Processes object
   */
  async loadDocumentalProcesses() {
    // DEPRECATED: PID persistence replaced by PIDRegistryFile in
    // perf-zombie-refactor. No-op — stale PIDs accumulate in the old
    // file and are never acted upon (killProcessTree returns early for
    // plain objects that lack execa's .kill()).
    return {};
  }

  /**
   * Save Documental processes to file
   */
  async saveDocumentalProcesses() {
    try {
      await fsp.writeFile(this.processesFile, JSON.stringify(activeDocumentalProcesses, null, 2));
      this.logger.info('Saved Documental processes to file');
    } catch (error) {
      this.logger.error('Error saving Documental processes:', error);
    }
  }

  /**
   * Add Documental process to tracking
   * @param {number} pid - Process ID
   * @param {Object} processInfo - Process information
   */
  async addDocumentalProcess(pid, processInfo) {
    activeDocumentalProcesses[pid] = {
      pid,
      port: processInfo.port,
      projectId: processInfo.projectId,
      startTime: Date.now(),
      command: processInfo.command,
      cwd: processInfo.cwd
    };
    await this.saveDocumentalProcesses();
    this.logger.info(`Added Documental process to tracking: PID ${pid}, Port ${processInfo.port}`);
  }

  /**
   * Remove Documental process from tracking
   * @param {number} pid - Process ID
   */
  async removeDocumentalProcess(pid) {
    if (activeDocumentalProcesses[pid]) {
      delete activeDocumentalProcesses[pid];
      await this.saveDocumentalProcesses();
      this.logger.info(`Removed Documental process from tracking: PID ${pid}`);
    }
  }

  /**
   * Get npm path
   * @returns {Promise<string>} npm executable path
   */
  async getNpmPath() {
    try {
      // Always prefer custom npm path if available
      if (process.env.CUSTOM_NPM_PATH) {
        this.logger.info(`Using custom npm path: ${process.env.CUSTOM_NPM_PATH}`);
        return process.env.CUSTOM_NPM_PATH;
      }
      
      // Use Node.js detection service to get preferred npm
      if (this.nodeDetectionService) {
        const npmPath = await this.nodeDetectionService.getPreferredNpmExecutable();
        this.logger.info(`Using detected npm path: ${npmPath}`);
        return npmPath;
      }
      
      this.logger.info('Using system npm');
      return 'npm';
    } catch (error) {
      this.logger.warn('Failed to get npm path from detection service, falling back to system npm:', error.message);
      return 'npm';
    }
  }

  /**
   * Get Node.js path
   * @returns {Promise<string>} Node.js executable path
   */
  async getNodePath() {
    try {
      // Always prefer custom node path if available
      if (process.env.CUSTOM_NODE_PATH) {
        this.logger.info(`Using custom node path: ${process.env.CUSTOM_NODE_PATH}`);
        return process.env.CUSTOM_NODE_PATH;
      }
      
      // Use Node.js detection service to get preferred node
      if (this.nodeDetectionService) {
        const nodePath = await this.nodeDetectionService.getPreferredNodeExecutable();
        this.logger.info(`Using detected node path: ${nodePath}`);
        return nodePath;
      }
      
      this.logger.info('Using system node');
      return 'node';
    } catch (error) {
      this.logger.warn('Failed to get node path from detection service, falling back to system node:', error.message);
      return 'node';
    }
  }

  /**
   * Extract port from URL
   * @param {string} url - URL string
   * @returns {number|null} Port number or null
   */
  extractPortFromUrl(url) {
    const match = url.match(/http:\/\/localhost:(\d+)\//);
    return match ? parseInt(match[1]) : null;
  }

  /**
   * Create delay function
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise} Promise that resolves after delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute a command in a directory
   * @param {string} command - Command to execute
   * @param {Array<string>} args - Command arguments
   * @param {string} cwd - Working directory
   * @param {string} processId - Process ID for tracking
   * @param {Function} sendOutput - Output callback
   * @returns {Promise<void>}
   */
  executeCommand(command, args, cwd, processId, sendOutput) {
    return new Promise(async (resolve, reject) => {
      let actualCommand = command;
      let env = { ...process.env };

      // Prefer managed Node.js runtime when available
      if (command === 'node' || command === 'npm' || command === 'npx') {
        try {
          const detection = await this.nodeDetectionService.detectNodeInstallation();
          const runtime = detection.runtime;

          if (runtime?.installed && runtime.isValid) {
            this.logger.info(`📦 Using managed ${command} for process ${processId}`);

            if (command === 'node' && runtime.nodePath) {
              actualCommand = runtime.nodePath;
            } else if (command === 'npm') {
              actualCommand = runtime.npmPath || await this.nodeDetectionService.getPreferredNpmExecutable();
            } else if (command === 'npx') {
              actualCommand = runtime.npxPath || await this.nodeDetectionService.getPreferredNpxExecutable();
            }

            env = this.nodeDetectionService.getManagedRuntimeEnv(env);
          }
        } catch (error) {
          this.logger.warn(`⚠️ Could not activate managed Node.js for ${command}, falling back to system: ${error.message}`);
        }
      }


      this.logger.info(`🚀 Executing: ${actualCommand} ${args.join(' ')} in ${cwd}`);

      try {
        const subprocess = execa(actualCommand, args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          killDescendants: true,
          forceKillAfterDelay: 1500,
          killSignal: 'SIGTERM',
          cleanup: true
        });
        
        activeProcesses[processId] = subprocess;

        // Handle stdout
        subprocess.stdout?.on('data', (data) => {
          sendOutput(data.toString());
        });

        // Handle stderr
        subprocess.stderr?.on('data', (data) => {
          sendOutput(data.toString());
        });

        // Handle process completion
        subprocess.on('exit', (code, signal) => {
          delete activeProcesses[processId];
          if (code === 0) {
            resolve();
          } else if (signal) {
            reject(`Command killed with signal: ${signal}`);
          } else {
            reject(`Command failed with code ${code}`);
          }
        });

        // Handle process errors
        subprocess.on('error', (err) => {
          delete activeProcesses[processId];
          reject(`Failed to start command: ${err.message}`);
        });

      } catch (error) {
        delete activeProcesses[processId];
        reject(`Failed to execute command: ${error.message}`);
      }
    });
  }

  /**
   * Start development server with URL detection
   * @param {string} repoDirPath - Repository directory path
   * @param {number} projectId - Project ID
   * @param {Function} sendServerOutput - Server output callback
   * @param {Function} sendStatus - Status callback
   * @returns {Promise<Object>} Process information
   */
  async startDevServer(repoDirPath, projectId, sendServerOutput, sendStatus) {
    let serverReady = false;
    const checkServerReady = (data) => {
      if (!serverReady && (data.includes('ready') || data.includes('compiled successfully') || data.includes('listening on'))) {
        serverReady = true;
        sendServerOutput('Development server is ready.\n');
        sendStatus('success'); // Mark as success only when server is truly ready
      }
    };

    let devServerUrl = null;
    const urlRegex = /http:\/\/localhost:\d+\//;

    const processOutput = (data) => {
      const output = data.toString();
      sendServerOutput(output);
      checkServerReady(output);

      if (!devServerUrl) {
        const match = output.match(urlRegex);
        if (match) {
          devServerUrl = match[0];
          globalDevServerUrl = devServerUrl; // Store globally
          
          // Extract port and update tracked Documental process
          const port = this.extractPortFromUrl(devServerUrl);
          if (port && devProcess.pid) {
            // Update process with port information
            if (activeDocumentalProcesses[devProcess.pid]) {
              activeDocumentalProcesses[devProcess.pid].port = port;
              this.saveDocumentalProcesses();
              this.logger.info(`Updated Documental process ${devProcess.pid} with port ${port}`);
            }
          }
          
          this.logger.info(`Development server URL: ${devServerUrl}`);
          // Send to all windows for synchronization
          const { BrowserWindow } = require('electron');
          const allWindows = BrowserWindow.getAllWindows();
          this.logger.info(`Sending dev-server-url to ${allWindows.length} windows`);
          BrowserWindow.getAllWindows().forEach(window => {
            if (!window.isDestroyed()) {
              this.logger.info(`Sending to window: ${window.id}`);
              window.webContents.send('dev-server-url', devServerUrl);
            }
          });
        }
      }
    };

    // Use executeCommand to ensure managed Node.js/NPM is used

    let devProcess;
    let processStarted = false;
    
    try {
      // Create a custom spawn to handle the dev server process
      const { spawn } = require('child_process');
      
      // Get the proper npm path using the same logic as executeCommand
      let actualNpmPath = 'npm';
      let env = { ...process.env };

      // Prefer managed runtime for dev server as well
      try {
        const detection = await this.nodeDetectionService.detectNodeInstallation();
        const runtime = detection.runtime;
        
        if (runtime?.installed && runtime.isValid) {
          this.logger.info(`📦 Using managed npm for dev server ${projectId}`);
          actualNpmPath = runtime.npmPath || await this.nodeDetectionService.getPreferredNpmExecutable();
          env = this.nodeDetectionService.getManagedRuntimeEnv(env);
        }
      } catch (error) {
        this.logger.warn(`⚠️ Could not activate managed Node.js for dev server, falling back to system: ${error.message}`);
      }


      this.logger.info(`🚀 Starting dev server: ${actualNpmPath} run dev in ${repoDirPath}`);

      let spawnFailedEarly = false;

      try {
        devProcess = execa(actualNpmPath, ['run', 'dev'], {
          cwd: repoDirPath,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          killDescendants: true,
          forceKillAfterDelay: 1500,
          killSignal: 'SIGTERM',
          cleanup: true
        });

        // Race 1 fix: execa's pid is undefined until 'spawn'. Wait for it so
        // pid reads below are safe; reject on early 'error' (e.g. ENOENT).
        if (!devProcess.pid) {
          await new Promise((resolve, reject) => {
            devProcess.once('spawn', resolve);
            devProcess.once('error', (err) => {
              spawnFailedEarly = true;
              reject(err);
            });
          });
        }

        processStarted = true;
        const processId = `dev-${projectId}`;
        activeProcesses[processId] = devProcess;

        await this.addDocumentalProcess(devProcess.pid, {
          port: null, // Will be updated when URL is detected
          projectId: projectId,
          command: 'npm run dev',
          cwd: repoDirPath
        });

        // Race 3 fix: any error between spawn and listener attach must kill
        // the child and clean up tracking, else devServerReady stays false
        // forever with a leaked process.
        try {
          devProcess.stdout?.on('data', processOutput);
          devProcess.stderr?.on('data', processOutput);

          devProcess.on('exit', async (code, signal) => {
            delete activeProcesses[processId];
            if (devProcess.pid) {
              await this.removeDocumentalProcess(devProcess.pid);
            }
            if (signal) {
              sendServerOutput(`Development server killed with signal: ${signal}\n`);
              sendStatus('failure');
            } else if (code !== 0) {
              sendServerOutput(`Development server exited with code ${code}\n`);
              sendStatus('failure');
            }
          });

          // Handle process errors
          devProcess.on('error', async (err) => {
            delete activeProcesses[processId];
            if (devProcess.pid) {
              await this.removeDocumentalProcess(devProcess.pid);
            }
            sendServerOutput(`Failed to start development server: ${err.message}\n`);
            sendStatus('failure');
          });
        } catch (attachError) {
          this.logger.error(`Failed to attach dev server listeners: ${attachError.message}`);
          try {
            devProcess.kill('SIGTERM');
          } catch (killErr) {
            // already exited
          }
          delete activeProcesses[processId];
          if (devProcess.pid) {
            await this.removeDocumentalProcess(devProcess.pid);
          }
          sendServerOutput(`Failed to start development server: ${attachError.message}\n`);
          sendStatus('failure');
          throw attachError;
        }

      } catch (error) {
        // Race 3 fix: kill any spawned child on a later failure; skip when
        // spawn itself rejected (no process to kill).
        if (!spawnFailedEarly && devProcess && devProcess.pid && devProcess.exitCode === null) {
          try {
            devProcess.kill('SIGTERM');
          } catch (killErr) {
            // best-effort
          }
        }
        if (processStarted) {
          delete activeProcesses[`dev-${projectId}`];
          if (devProcess && devProcess.pid) {
            await this.removeDocumentalProcess(devProcess.pid);
          }
        }
        sendServerOutput(`Failed to start development server: ${error.message}\n`);
        sendStatus('failure');
      }

    } catch (error) {
      sendServerOutput(`Failed to start development server: ${error.message}\n`);
      sendStatus('failure');
    }

    // Race 2 fix: success is now signalled only from checkServerReady() once
    // the server is truly ready. The old unconditional sendStatus('success')
    // that fired right after spawn (before URL detection) is intentionally gone.

    sendServerOutput('Development server started in background. Waiting for readiness signal...\n');

    return {
      process: devProcess,
      url: devServerUrl
    };
  }

  /**
   * Get global dev server URL
   * @returns {string|null} Global dev server URL
   */
  getGlobalDevServerUrl() {
    this.logger.info('get-dev-server-url-from-main called, returning:', globalDevServerUrl);
    return globalDevServerUrl;
  }

  /**
   * Set global dev server URL
   * @param {string} url - Dev server URL
   */
  setGlobalDevServerUrl(url) {
    globalDevServerUrl = url;
    this.logger.info('Global dev server URL set to:', url);
  }

  /**
   * Get active processes
   * @returns {Object} Active processes object
   */
  getActiveProcesses() {
    return activeProcesses;
  }

  /**
   * Get active Documental processes
   * @returns {Object} Active Documental processes object
   */
  getActiveDocumentalProcesses() {
    return activeDocumentalProcesses;
  }

  /**
   * Kill ALL tracked processes (both regular and Documental) under a lock-guard.
   *
   * Contract:
   *   - acquires the process manager lock before iterating (throws "Process
   *     manager busy: killAll" if another op holds it)
   *   - delegates to killProcessTree for each subprocess (SIGTERM -> grace -> SIGKILL)
   *   - uses Promise.allSettled so one failure doesn't short-circuit the rest
   *   - releases the lock in a `finally` block (even on error)
   *   - idempotent: safe to call repeatedly; empty state is a no-op
   *   - swallows ESRCH/EPERM (already-dead processes) so callers don't see them
   *
   * @param {number} [gracePeriod=1500] - Grace period in ms forwarded to killProcessTree
   * @returns {Promise<void>}
   */
  async killAll(gracePeriod = 1500) {
    acquireProcessManagerLock('killAll');
    try {
      // Snapshot via instance getters (tests override them); read under the lock.
      const regular = this.getActiveProcesses() || {};
      const documental = this.getActiveDocumentalProcesses() || {};

      const targets = [
        ...Object.values(regular),
        ...Object.values(documental)
      ].filter((proc) => proc && (proc.pid !== undefined || typeof proc.kill === 'function'));

      if (targets.length > 0) {
        // Prefer injected killProcessTree (for testability); fall back to lazy
        // require which bypasses vi.mock in CJS context (see learnings Task 11).
        const killFn = this._killProcessTree || require('../main/processes/killProcessTree').killProcessTree;
        const results = await Promise.allSettled(
          targets.map((proc) =>
            killFn(proc, gracePeriod).catch((err) => {
              // ESRCH = already dead, EPERM = not ours; both are safe to ignore.
              const code = err && err.code;
              if (code !== 'ESRCH' && code !== 'EPERM') {
                this.logger?.warn?.('killAll: error killing process', err?.message || err);
              }
            })
          )
        );
        const rejected = results.filter((r) => r.status === 'rejected');
        if (rejected.length > 0) {
          this.logger?.warn?.(`killAll: ${rejected.length} process kill(s) rejected`);
        }
      }

      // Clear both maps so repeated calls are idempotent no-ops.
      activeProcesses = {};
      activeDocumentalProcesses = {};
    } finally {
      releaseProcessManagerLock();
    }
  }

  /**
   * Kill process by ID
   * @param {string} processId - Process ID
   * @returns {Promise<boolean>} Success status
   */
  async killProcess(processId) {
    try {
      const process = activeProcesses[processId];
      if (process && !process.killed) {
        // Use platform-specific signals
        const signal = this.platformService.getTerminationSignal();
        process.kill(signal);
        process.killed = true;
        
        // Wait a bit and force kill if still running
        setTimeout(() => {
          if (!process.killed) {
            const forceSignal = this.platformService.getForceTerminationSignal();
            process.kill(forceSignal);
          }
        }, 5000);
        
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error(`Error killing process ${processId}:`, error);
      return false;
    }
  }

  /**
   * Terminate all processes associated with a project
   * @param {number} projectId - Project ID
   */
  async terminateProcessesForProject(projectId) {
    const normalizedId = String(projectId);
    const keysToTerminate = Object.keys(activeProcesses).filter((key) => {
      return (
        key === normalizedId ||
        key === `build-${normalizedId}` ||
        key === `dev-${normalizedId}` ||
        key.startsWith(`${normalizedId}-`)
      );
    });

    for (const key of keysToTerminate) {
      await this.terminateProcessByKey(key);
    }
  }

  /**
   * Terminate a specific tracked process
   * @param {string} processKey - Process key identifier
   */
  async terminateProcessByKey(processKey) {
    const processRef = activeProcesses[processKey];
    if (!processRef) {
      return;
    }

    await new Promise((resolve) => {
      const exitHandler = () => finalize();
      const errorHandler = () => finalize();
      const detachListeners = () => {
        if (typeof processRef.off === 'function') {
          processRef.off('exit', exitHandler);
          processRef.off('error', errorHandler);
        } else if (typeof processRef.removeListener === 'function') {
          processRef.removeListener('exit', exitHandler);
          processRef.removeListener('error', errorHandler);
        }
      };

      const finalize = async () => {
        detachListeners();
        if (processRef.pid) {
          await this.removeDocumentalProcess(processRef.pid);
        }
        delete activeProcesses[processKey];
        resolve();
      };

      if (typeof processRef.once === 'function') {
        processRef.once('exit', exitHandler);
        processRef.once('error', errorHandler);
      }

      // If the process already exited, finalize immediately
      if (typeof processRef.exitCode === 'number' || processRef.killed) {
        finalize();
        return;
      }

      try {
        const signal = this.platformService.getTerminationSignal();
        processRef.kill(signal);
      } catch (error) {
        this.logger.warn(`Error terminating process ${processKey}:`, error);
        finalize();
        return;
      }

      setTimeout(() => {
        if (activeProcesses[processKey]) {
          try {
            const forceSignal = this.platformService.getForceTerminationSignal();
            processRef.kill(forceSignal);
          } catch (forceError) {
            this.logger.error(`Failed to force kill process ${processKey}:`, forceError);
          }
        }
      }, 3000);
    });
  }

  /**
   * Resolve repository path considering nested folders
   * @param {string} projectPath - Base project path
   * @param {string} repoFolderName - Repository folder name
   * @returns {string|null} Resolved repository path
   */
  async resolveRepoPath(projectPath, repoFolderName) {
    if (repoFolderName) {
      if (path.basename(projectPath) === repoFolderName) {
        try {
          await fsp.access(projectPath);
          return projectPath;
        } catch {
          // doesn't exist
        }
      }

      const nestedPath = path.join(projectPath, repoFolderName);
      try {
        await fsp.access(nestedPath);
        return nestedPath;
      } catch {
        // doesn't exist
      }

      try {
        await fsp.access(projectPath);
        await fsp.access(path.join(projectPath, '.git'));
        return projectPath;
      } catch {
        // doesn't exist
      }
    }

    // Security: never return a bare workspace parent folder when repoFolderName
    // is null — cancelProjectCreation would rimraf ALL projects.
    return null;
  }

  /**
   * Cancel project creation and clean up

   * @param {number} projectId - Project ID
   * @param {string} projectPath - Project path
   * @param {string} repoFolderName - Repository folder name
   * @param {Function} sendOutput - Output callback
   * @returns {Promise<void>}
   */
  async cancelProjectCreation(projectId, projectPath, repoFolderName, shouldDeleteFiles, sendOutput) {
    try {
      await this.terminateProcessesForProject(projectId);

      if (!shouldDeleteFiles) {
        if (sendOutput) {
          sendOutput('ℹ️ Project creation canceled. Files preserved as requested.\n');
        }
        return;
      }

      const repoPath = await this.resolveRepoPath(projectPath, repoFolderName);
      let repoPathExists = false;
      try {
        await fsp.access(repoPath);
        repoPathExists = true;
      } catch {
        repoPathExists = false;
      }
      if (repoPath && repoPathExists) {
        // Safety: refuse to delete the workspace root folder itself.
        if (!repoFolderName && repoPath === projectPath) {
          this.logger.warn(`Refusing to delete workspace root: ${repoPath}`);
          if (sendOutput) sendOutput('⚠️ Refusing to delete workspace root folder.\n');
          return;
        }
        if (sendOutput) {
          sendOutput(`🗑️ Removing repository folder: ${repoPath}\n`);
        }
        await rimraf(repoPath);
        if (sendOutput) {
          sendOutput('✅ Repository folder removed successfully\n');
        }
      } else {
        this.logger.warn(`Repository path not found for project ${projectId}, skipping removal`);
        if (sendOutput) {
          sendOutput('⚠️ Repository folder not found, nothing to remove.\n');
        }
      }
    } catch (error) {
      this.logger.error('Error canceling project creation:', error);
      throw error;
    }
  }

}

module.exports = { ProcessManager, acquireProcessManagerLock, releaseProcessManagerLock };