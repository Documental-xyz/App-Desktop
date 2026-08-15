/**
 * @fileoverview IPC handlers for system operations (dialogs, Node.js, file explorer)
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain, app, dialog, shell, BrowserWindow } = require('electron');

/** @type {string} Background color for BrowserWindow (shown before CSS loads) */
const WINDOW_BG_COLOR = '#111827';
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const os = require('os');
const { PlatformService } = require('../main/services/platform/PlatformService.js');
const { getAppIcon } = require('../main/platform/icons');

/**
 * @type {import('child_process').ChildProcess[]} Currently active exec() child processes
 * spawned by SystemHandlers. Tracked so killAllActiveExecs() (called from will-quit,
 * Task 20) can terminate them during app shutdown and prevent perf-zombie children.
 */
const activeExecs = [];

/**
 * Lazily-loaded killPidTree (avoids loading tree-kill at module init time).
 * @returns {Promise<(pid: number, gracePeriod?: number) => Promise<void>>}
 */
async function getKillPidTree() {
  const { killPidTree } = require('../main/processes/killPidTree.js');
  return killPidTree;
}

/**
 * Get a snapshot of currently active exec() child processes.
 * Used by Task 12 (killAll) via the will-quit handler (Task 20).
 * @returns {import('child_process').ChildProcess[]}
 */
function getActiveExecs() {
  return [...activeExecs];
}

/**
 * Kill all currently active exec() child processes tracked by SystemHandlers.
 * Two-phase: SIGTERM → grace period → SIGKILL via killPidTree (which also
 * kills the descendant process group on Unix / taskkill /T on Windows).
 *
 * Safe to call during shutdown: never throws, logs errors, and removes
 * killed entries from activeExecs.
 * @param {number} [gracePeriod=1500] - SIGTERM→SIGKILL grace window in ms
 * @returns {Promise<void>}
 */
async function killAllActiveExecs(gracePeriod = 1500) {
  // Snapshot before iterating to avoid concurrent mutation from 'close' handlers.
  const snapshot = [...activeExecs];
  if (snapshot.length === 0) return;

  let killPidTree;
  try {
    killPidTree = await getKillPidTree();
  } catch (err) {
    // Fall back to direct child.kill if killPidTree cannot be loaded
    killPidTree = null;
  }

  await Promise.all(snapshot.map(async (child) => {
    try {
      // Already gone — nothing to do (the 'close' handler will splice it).
      if (child.exitCode !== null || child.signalCode !== null) return;

      if (killPidTree && typeof child.pid === 'number' && child.pid > 0) {
        await killPidTree(child.pid, gracePeriod);
      } else if (typeof child.kill === 'function') {
        // Best-effort graceful kill, escalate to SIGKILL after gracePeriod
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) { /* already dead */ }
            resolve();
          }, gracePeriod);
          child.once('close', () => { clearTimeout(timer); resolve(); });
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
    } catch (_) {
      // Swallow — never throw during shutdown.
    }
  }));
}

/**
 * Track an exec() child process: push to activeExecs and auto-remove on 'close'.
 * @param {import('child_process').ChildProcess} child
 * @returns {import('child_process').ChildProcess} The same child (passthrough)
 */
function trackExec(child) {
  if (!child) return child;
  activeExecs.push(child);
  const cleanup = () => {
    const idx = activeExecs.indexOf(child);
    if (idx >= 0) activeExecs.splice(idx, 1);
  };
  // 'close' fires after all stdio streams are closed (later than 'exit').
  // Listen once so removal happens exactly once even if both fire.
  child.once('close', cleanup);
  child.once('error', cleanup);
  return child;
}

/**
 * @typedef {Object} NodeDetectionResult
 * @property {string} status - Detection status ('installed', 'not_found', 'error')
 * @property {string} version - Node.js version if found
 * @property {string} path - Node.js executable path
 * @property {string} npmVersion - npm version if found
 * @property {string} npmPath - npm executable path
 * @property {boolean} needsInstallation - Whether Node.js needs to be installed
 * @property {string} [message] - Status message
 * @property {string} [error] - Error message if status is 'error'
 */

/**
 * @typedef {Object} InstallationProgress
 * @property {string} stage - Current installation stage
 * @property {number} progress - Progress percentage (0-100)
 * @property {string} message - Progress message
 */

/**
 * System Operations IPC Handlers
 */
let lastExitCancelTime = 0;

class SystemHandlers {
  /**
   * Create an instance of SystemHandlers
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.windowManager - Window manager instance
   * @param {Object} [dependencies.processManager] - Process manager instance
   * @param {Object} [dependencies.themeService] - Theme service instance
   */
  constructor({ logger, windowManager, processManager, themeService }) {
    this.logger = logger;
    this.windowManager = windowManager;
    this.processManager = processManager;
    this.themeService = themeService || null;
    this.platformService = new PlatformService({ logger });

    this.installationProgress = {
      stage: 'idle',
      progress: 0,
      message: 'Ready to start installation'
    };

    /** @type {Function|null} Saved reference for cleanup in unregisterHandlers */
    this._themeChangeHandler = null;
  }

  /**
   * Create a new window with the given state
   * @param {Object} windowState - Window state to replicate
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async createNewWindowWithState(windowState) {
    try {
      this.logger.info('🪟 Creating new window with state');
      const { BrowserWindow } = require('electron');
      const path = require('path');
      const currentWindow = BrowserWindow.getFocusedWindow();
      const bounds = currentWindow ? currentWindow.getBounds() : { width: 1400, height: 900 };
      const newWindow = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        show: false,
        backgroundColor: WINDOW_BG_COLOR,
        icon: getAppIcon(),
        title: 'Documental',
        webPreferences: {
          preload: path.resolve(__dirname, '..', '..', 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false
        }
      });
      
      // Track this window to prevent issues when it's closed
      const windowId = newWindow.id;
      this.logger.info(`🪟 New window created with ID: ${windowId}`);
      
      // Handle window closed event
      newWindow.on('closed', () => {
        this.logger.info(`🪟 Secondary window ${windowId} closed`);
        // Note: We intentionally don't call any app-level cleanup here
        // The window should close independently without affecting other windows
      });
      
      // Handle window close event (before it's closed)
      newWindow.on('close', (event) => {
        this.logger.info(`🪟 Secondary window ${windowId} is closing`);
        // Don't prevent default - let it close normally
      });
      
       const stateEncoded = Buffer.from(JSON.stringify(windowState)).toString('base64');
       const mainHtmlPath = path.join(app.getAppPath(), 'renderer', 'main.html');
      
      // Mark as secondary window so renderer knows not to trigger app exit
      this.logger.info(`🪟 Loading secondary window ${windowId} with isSecondary=true`);
      await newWindow.loadFile(mainHtmlPath, { 
        query: { 
          state: stateEncoded,
          isSecondary: 'true'
        } 
      });
      newWindow.show();
      newWindow.maximize();
      this.logger.info(`✅ New window ${windowId} created and shown successfully`);
      return { success: true };
    } catch (error) {
      this.logger.error('❌ Error creating new window:', error);
      return { success: false, error: error.message };
    }
  }

 

 

  /**
   * Get home directory
   * @returns {Promise<string>} Home directory path
   */
async getHomeDirectory() {
    try {
      // Use platform service for cross-platform home directory
      return this.platformService.getHomeDirectory();
    } catch (error) {
      this.logger.error('Error getting home directory:', error);
      // Fallback to Electron's method
      try {
        return app.getPath('home');
      } catch (fallbackError) {
        return os.homedir();
      }
    }
  }

  /**
   * Open directory dialog
   * @returns {Promise<string|null>} Selected directory path or null
   */
  async openDirectoryDialog() {
    try {
      const window = this.windowManager.getMainWindow();
      
      // Validate window
      if (!window || window.isDestroyed()) {
        this.logger.error('No valid window available for dialog');
        return null;
      }

      // Windows-specific: restore and focus
      if (process.platform === 'win32') {
        if (window.isMinimized()) {
          window.restore();
        }
        window.focus();
      }

      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory'],
        title: 'Select Directory'
      });
      
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      
      return result.filePaths[0];
    } catch (error) {
      this.logger.error('Error opening directory dialog:', error);
      return null;
    }
  }

  /**
   * Detect Node.js installation
   * @returns {Promise<NodeDetectionResult>} Node.js detection result
   */
async detectNodeInstallation() {
    try {
      const { spawn } = require('child_process');
      const path = require('path');
      
      return new Promise(async (resolve) => {
        // Use platform service to get executable names
        const nodeCmd = await this.platformService.adapter.getExecutableName('node');
        const npmCmd = await this.platformService.adapter.getExecutableName('npm');
        
        // Use platform service to get common paths
        const commonPaths = await this.platformService.adapter.getCommonPaths('node');
        const possiblePaths = [
          // System PATH (try executable name directly)
          nodeCmd,
          // Common installation paths from platform service
          ...commonPaths
        ];

        let nodePath = null;
        let npmPath = null;
        let nodeVersion = null;
        let npmVersion = null;

        // Function to test if a command works
        const testCommand = (cmd, args = []) => {
          return new Promise((resolveTest) => {
            const child = spawn(cmd, args, { 
              stdio: ['ignore', 'pipe', 'ignore'],
              timeout: 5000,
              shell: true
            });
            
            let output = '';
            child.stdout.on('data', (data) => {
              output += data.toString();
            });
            
            child.on('close', (code) => {
              resolveTest({ success: code === 0, output: output.trim() });
            });
            
            child.on('error', () => {
              resolveTest({ success: false });
            });
          });
        };

        // Test Node.js
        const testNode = async () => {
          for (const testPath of possiblePaths) {
            const result = await testCommand(testPath, ['--version']);
            if (result.success) {
              nodePath = testPath;
              nodeVersion = result.output;
              return true;
            }
          }
          return false;
        };

        // Test npm
        const testNpm = async () => {
          const npmPaths = nodePath ? 
            [path.join(path.dirname(nodePath), npmCmd), npmCmd] : 
            [npmCmd];
          
          for (const testPath of npmPaths) {
            const result = await testCommand(testPath, ['--version']);
            if (result.success) {
              npmPath = testPath;
              npmVersion = result.output;
              return true;
            }
          }
          return false;
        };

        // Run tests
        (async () => {
          try {
            const nodeFound = await testNode();
            if (nodeFound) {
              await testNpm();
            }

            if (nodeFound && npmVersion) {
              resolve({
                status: 'installed',
                version: nodeVersion,
                path: nodePath,
                npmVersion,
                npmPath,
                needsInstallation: false,
                message: `Node.js ${nodeVersion} e npm ${npmVersion} encontrados`
              });
            } else if (nodeFound) {
              resolve({
                status: 'installed',
                version: nodeVersion,
                path: nodePath,
                npmVersion: 'Não encontrado',
                npmPath: null,
                needsInstallation: false,
                message: `Node.js ${nodeVersion} encontrado, mas npm não foi encontrado`
              });
            } else {
              resolve({
                status: 'not_found',
                version: null,
                path: null,
                npmVersion: null,
                npmPath: null,
                needsInstallation: true,
                message: 'Node.js não encontrado no sistema'
              });
            }
          } catch (error) {
            resolve({
              status: 'error',
              version: null,
              path: null,
              npmVersion: null,
              npmPath: null,
              needsInstallation: true,
              message: `Erro na detecção: ${error.message}`,
              error: error.message
            });
          }
        })();
      });
    } catch (error) {
      this.logger.error('Error detecting Node.js installation:', error);
      return {
        status: 'error',
        version: null,
        path: null,
        npmVersion: null,
        npmPath: null,
        needsInstallation: true,
        message: `Erro na detecção: ${error.message}`,
        error: error.message
      };
    }
  }

  /**
   * Install Node.js dependencies with NVM
   * @param {Object} options - Installation options
   * @returns {Promise<{success: boolean, message?: string, error?: string, nodeVersion?: string, nodePath?: string}>}
   */
  async installNodeDependencies(options = {}) {
    try {
      this.logger.info('🚀 Starting intelligent Node.js installation process...');
      
      // Update progress
      this.installationProgress = {
        stage: 'detecting',
        progress: 10,
        message: 'Detecting existing Node.js installation...'
      };
      
      // Step 1: Check if NVM is already installed
      this.installationProgress = {
        stage: 'checking_nvm',
        progress: 20,
        message: 'Checking for NVM installation...'
      };
      
      const nvmInfo = await this.detectNVM();
      this.logger.info('📋 NVM detection result:', nvmInfo);
      
      if (!nvmInfo.exists) {
        // Step 2: Install NVM
        this.installationProgress = {
          stage: 'installing_nvm',
          progress: 30,
          message: 'Installing NVM...'
        };
        
        await this.installNVM();
      }
      
      // Step 3: Install Node.js v22
      this.installationProgress = {
        stage: 'installing_node',
        progress: 50,
        message: 'Installing Node.js v22...'
      };
      
      const nodeResult = await this.installNodeVersion('22');
      
      // Step 4: Configure environment
      this.installationProgress = {
        stage: 'configuring',
        progress: 80,
        message: 'Configuring environment...'
      };
      
      await this.configureNodeEnvironment();
      
      // Step 5: Verify installation
      this.installationProgress = {
        stage: 'verifying',
        progress: 90,
        message: 'Verifying installation...'
      };
      
      const verification = await this.verifyNodeInstallation();
      
      if (!verification.success) {
        throw new Error(verification.error || 'Installation verification failed');
      }
      
      this.installationProgress = {
        stage: 'completed',
        progress: 100,
        message: 'Installation completed successfully!'
      };
      
      this.logger.info('✅ Node.js installation completed successfully');
      
      return {
        success: true,
        nodeVersion: verification.version,
        nodePath: verification.path
      };
      
    } catch (error) {
      this.logger.error('❌ Error installing Node.js dependencies:', error);
      this.installationProgress = {
        stage: 'error',
        progress: 0,
        message: `Installation failed: ${error.message}`
      };
      return { success: false, error: error.message };
    }
  }

  /**
   * Detect NVM installation
   * @returns {Promise<Object>} NVM detection result
   */
async detectNVM() {
    return new Promise(async (resolve) => {
      const { exec } = require('child_process');
      
      // Use platform service to get home directory and common paths
      const homeDir = this.platformService.getHomeDirectory();
      const nvmPaths = [
        process.env.NVM_DIR,
        this.platformService.joinPath(homeDir, '.nvm'),
        this.platformService.joinPath(homeDir, '.config', 'nvm'),
        this.platformService.adapter.isWindows() ? null : '/usr/local/nvm' // Only on Unix systems
      ].filter(Boolean);
      
      this.logger.info('🔍 Checking NVM paths:', nvmPaths);
      
      // Use platform service to get appropriate which command
      const whichCommand = await this.platformService.adapter.getShellCommand('which');
      
      // Check if NVM command exists
      trackExec(exec(`${whichCommand} nvm`, async (error, stdout, stderr) => {
        if (!error && stdout.trim()) {
          resolve({
            exists: true,
            path: stdout.trim(),
            type: 'command'
          });
          return;
        }
        
        // Check if NVM directory exists
        for (const nvmPath of nvmPaths) {
          try {
            await fsPromises.access(nvmPath);
            resolve({
              exists: true,
              path: nvmPath,
              type: 'directory'
            });
            return;
          } catch (_) { /* path doesn't exist */ }
        }
        
        resolve({
          exists: false,
          path: null,
          type: null
        });
      }));
    });
  }

  /**
   * Install NVM
   * @returns {Promise<void>}
   */
async installNVM() {
    return new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      
      this.logger.info('📦 Installing NVM...');
      
      // Use platform service to get home directory and check platform
      const homeDir = this.platformService.getHomeDirectory();
      const nvmDir = this.platformService.joinPath(homeDir, '.nvm');
      
      // Download and install NVM script (Unix-only)
      if (this.platformService.adapter.isWindows()) {
        reject(new Error('NVM is not supported on Windows. Use NVM for Windows instead.'));
        return;
      }
      
      const installScript = `
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
      `;
      
      trackExec(exec(installScript, {
        env: {
          ...process.env,
          NVM_DIR: nvmDir
        }
      }, (error, stdout, stderr) => {
        if (error) {
          this.logger.error('❌ NVM installation failed:', error);
          reject(new Error(`NVM installation failed: ${error.message}`));
          return;
        }
        
        this.logger.info('✅ NVM installed successfully');
        resolve();
      }));
    });
  }

  /**
   * Install specific Node.js version using NVM
   * @param {string} version - Node.js version to install
   * @returns {Promise<Object>} Installation result
   */
async installNodeVersion(version) {
    return new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      
      this.logger.info(`📦 Installing Node.js v${version}...`);
      
      // Use platform service for cross-platform paths
      const homeDir = this.platformService.getHomeDirectory();
      const nvmDir = this.platformService.joinPath(homeDir, '.nvm');
      const nvmScript = this.platformService.joinPath(nvmDir, 'nvm.sh');
      
      // Check if NVM is available (Unix only)
      if (this.platformService.adapter.isWindows()) {
        reject(new Error('NVM-based Node.js installation is not supported on Windows.'));
        return;
      }
      
      const installCommand = `
        source ${nvmScript} && nvm install ${version} && nvm use ${version} && nvm alias default ${version}
      `;
      
      trackExec(exec(installCommand, {
        env: {
          ...process.env,
          NVM_DIR: nvmDir,
          PATH: `${nvmDir}:${process.env.PATH}`
        },
        shell: '/bin/bash'
      }, (error, stdout, stderr) => {
        if (error) {
          this.logger.error('❌ Node.js installation failed:', error);
          reject(new Error(`Node.js installation failed: ${error.message}`));
          return;
        }
        
        this.logger.info(`✅ Node.js v${version} installed successfully`);
        resolve({ version, success: true });
      }));
    });
  }

  /**
   * Configure Node.js environment
   * @returns {Promise<void>}
   */
async configureNodeEnvironment() {
    return new Promise(async (resolve, reject) => {
      const { exec } = require('child_process');
      
      this.logger.info('⚙️ Configuring Node.js environment...');
      
      // Use platform service for cross-platform paths
      const homeDir = this.platformService.getHomeDirectory();
      
      // Skip NVM configuration on Windows
      if (this.platformService.adapter.isWindows()) {
        this.logger.info('⚠️ NVM configuration skipped on Windows');
        resolve();
        return;
      }
      
      // Update shell profiles
      const bashrcPath = this.platformService.joinPath(homeDir, '.bashrc');
      const zshrcPath = this.platformService.joinPath(homeDir, '.zshrc');
      const profilePath = this.platformService.joinPath(homeDir, '.profile');
      
      const nvmConfig = `
# NVM configuration
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \\. "$NVM_DIR/bash_completion"
`;
      
      try {
        // Add to .bashrc if not already present
        try {
          await fsPromises.access(bashrcPath);
          const bashrcContent = await fsPromises.readFile(bashrcPath, 'utf8');
          if (!bashrcContent.includes('NVM configuration')) {
            await fsPromises.appendFile(bashrcPath, nvmConfig);
          }
        } catch (_) { /* file doesn't exist, skip */ }
        
        // Add to .profile if not already present
        try {
          await fsPromises.access(profilePath);
          const profileContent = await fsPromises.readFile(profilePath, 'utf8');
          if (!profileContent.includes('NVM configuration')) {
            await fsPromises.appendFile(profilePath, nvmConfig);
          }
        } catch (_) { /* file doesn't exist, skip */ }
        
        this.logger.info('✅ Environment configured successfully');
        resolve();
        
      } catch (error) {
        this.logger.error('❌ Environment configuration failed:', error);
        reject(error);
      }
    });
  }

  /**
   * Verify Node.js installation
   * @returns {Promise<Object>} Verification result
   */
async verifyNodeInstallation() {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      
      this.logger.info('🔍 Verifying Node.js installation...');
      
      // Use platform service for cross-platform paths
      const homeDir = this.platformService.getHomeDirectory();
      const nvmDir = this.platformService.joinPath(homeDir, '.nvm');
      const nvmScript = this.platformService.joinPath(nvmDir, 'nvm.sh');
      
      // Skip NVM verification on Windows
      if (this.platformService.adapter.isWindows()) {
        // For Windows, just verify node and npm are available
        const nodeCmd = this.platformService.adapter.getExecutableName('node');
        const npmCmd = this.platformService.adapter.getExecutableName('npm');
        
        trackExec(exec(`${nodeCmd} --version && ${npmCmd} --version`, (error, stdout, stderr) => {
          if (error) {
            resolve({ success: false, error: error.message });
          } else {
            const lines = stdout.trim().split('\n');
            resolve({
              success: true,
              version: lines[0] || 'unknown',
              npmVersion: lines[1] || 'unknown'
            });
          }
        }));
        return;
      }
      
      const verifyCommand = `
        source ${nvmScript} && node --version && npm --version && which node && which npm
      `;
      
      trackExec(exec(verifyCommand, {
        env: {
          ...process.env,
          NVM_DIR: nvmDir,
          PATH: `${nvmDir}:${process.env.PATH}`
        },
        shell: '/bin/bash'
      }, (error, stdout, stderr) => {
        if (error) {
          this.logger.error('❌ Node.js verification failed:', error);
          resolve({
            success: false,
            error: `Verification failed: ${error.message}`
          });
          return;
        }
        
        const lines = stdout.trim().split('\n');
        const nodeVersion = lines[0]?.replace('v', '');
        const npmVersion = lines[1];
        const nodePath = lines[2];
        const npmPath = lines[3];
        
        this.logger.info('✅ Node.js verification successful:', {
          nodeVersion,
          npmVersion,
          nodePath,
          npmPath
        });
        
        resolve({
          success: true,
          version: nodeVersion,
          npmVersion: npmVersion,
          path: nodePath,
          npmPath: npmPath
        });
      }));
    });
  }

  /**
   * Get Node.js installation progress
   * @returns {InstallationProgress} Current installation progress
   */
  getNodeInstallationProgress() {
    return { ...this.installationProgress };
  }

  /**
   * Get app logs
   * @returns {string} App logs
   */
  getAppLogs() {
    // This would get logs from the modular logger
    return this.logger.getLogs ? this.logger.getLogs() : '';
  }

  /**
   * Clear console output
   * @param {Object} event - IPC event object
   * @param {string} type - Type of console output to clear
   */
  clearConsoleOutput(event, type) {
    // Broadcast clear event to all windows
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send('console-cleared', { type });
      }
    });
    
    this.logger.info(`Cleared ${type} console output`);
  }

  /**
   * Navigate to a specific page
   * @param {Object} event - IPC event object
   * @param {string} page - Page name to navigate to
   */
  navigate(event, page) {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window && !window.isDestroyed()) {
       // Use absolute path - handle both development and packaged environments
         const rendererPath = path.join(app.getAppPath(), 'renderer', page);
         
         this.logger.info(`🚀 Navigating to page: ${page}`);
         this.logger.info(`📦 App packaged: ${require('electron').app.isPackaged}`);
         this.logger.info(`📁 Renderer path: ${rendererPath}`);
        
        // Use loadFile() instead of loadURL() - it handles asar files correctly
        // Prevent window from closing during navigation
        const closeHandler = (e) => {
          this.logger.warn(`⚠️ Preventing window close during navigation to: ${page}`);
          e.preventDefault();
        };
        
        window.on('close', closeHandler);
        
        window.loadFile(rendererPath)
          .then(() => {
            this.logger.info(`✅ Page loaded successfully: ${page}`);
            // Remove the close prevention handler after successful load
            window.removeListener('close', closeHandler);
          })
          .catch(error => {
            this.logger.error(`❌ Failed to load page: ${error.message}`);
            this.logger.error(`❌ Error details:`, error);
            // Remove the close prevention handler on error
            window.removeListener('close', closeHandler);
          });
      } else {
        this.logger.error(`❌ Window is destroyed or null for navigation to: ${page}`);
      }
    } catch (error) {
      this.logger.error(`❌ Critical error in navigate method:`, error);
    }
  }

  /**
   * Close current window and open new one with index.html
   * @param {Object} event - IPC event object
   * @returns {Promise<{success: boolean, error?: string}>} Result of the operation
   */
  async closeAndReopenToIndex(event) {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window && !window.isDestroyed()) {
        this.logger.info('🔄 Closing window and reopening with index.html');
        
        // Get current window bounds to preserve size
        const { width, height, x, y } = window.getBounds();
        
        // Create new window FIRST (to prevent app from quitting if this is the last window)
        const newWindow = new BrowserWindow({
          width,
          height,
          x,
          y,
          show: false,
          backgroundColor: WINDOW_BG_COLOR,
          icon: getAppIcon(),
          title: 'Documental',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../../preload.js')
          }
        });
        
         // Load index.html
         const indexPath = path.join(app.getAppPath(), 'renderer', 'index.html');
         await newWindow.loadFile(indexPath);
        
        // Show new window
        newWindow.show();
        
        // Now close the old window
        window.close();
        
        this.logger.info('✅ Window closed and new one opened with index.html');
        return { success: true };
      }
      return { success: false, error: 'Window not found or destroyed' };
    } catch (error) {
      this.logger.error('❌ Error in closeAndReopenToIndex:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Complete welcome setup
   * @param {Object} event - IPC event object
   */
  async completeWelcomeSetup(event) {
    try {
      this.logger.info('🎯 Completing welcome setup...');
      
      // Mark setup as completed by creating the first-time file
      const { app } = require('electron');
      const fs = require('fs');
      const path = require('path');
      
      const firstTimeFile = path.join(app.getPath('userData'), '.first-time');
      
      // Write the completion marker
      await fsPromises.writeFile(firstTimeFile, 'completed');
      
      // Verify the file was written correctly
      let firstTimeFileExists = true;
      try { await fsPromises.access(firstTimeFile); } catch (_) { firstTimeFileExists = false; }
      if (firstTimeFileExists) {
        const content = (await fsPromises.readFile(firstTimeFile, 'utf8')).trim();
        const isCorrectlyWritten = content === 'completed';
        
        if (isCorrectlyWritten) {
          this.logger.info(`✅ First-time setup successfully marked as completed: ${firstTimeFile}`);
          return { success: true };
        } else {
          const errorMsg = `File content verification failed. Expected: "completed", Found: "${content}"`;
          this.logger.error(`❌ ${errorMsg}`);
          return { success: false, error: errorMsg };
        }
      } else {
        const errorMsg = `Failed to create completion file: ${firstTimeFile}`;
        this.logger.error(`❌ ${errorMsg}`);
        return { success: false, error: errorMsg };
      }
      
    } catch (error) {
      this.logger.error('❌ Error completing welcome setup:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get dev server URL from main process
   * @returns {string|null} Dev server URL
   */
  getDevServerUrlFromMain() {
    this.logger.info('📡 get-dev-server-url-from-main called');
    
    // Return the real dev server URL if processManager is available
    if (this.processManager && this.processManager.getGlobalDevServerUrl) {
      return this.processManager.getGlobalDevServerUrl();
    }
    
    // Fallback to null if no process manager
    return null;
  }

  /**
   * Confirm app exit
   * @param {Object} event - IPC event object
   * @returns {Promise<boolean>} Whether user confirmed exit
   */
  async confirmExitApp(event) {
    const window = BrowserWindow.fromWebContents(event.sender);

    if (Date.now() - lastExitCancelTime < 2000) {
      this.logger.info('🚪 Exit confirmation blocked: re-entry within 2s guard');
      return false;
    }

    this.logger.info('🚪 Exit confirmation requested from window:', window?.id);
    
    return new Promise((resolve) => {
      if (window && !window.isDestroyed()) {
        // Send request to renderer to show confirmation dialog
        this.logger.info('📤 Sending show-exit-confirmation to renderer');
        window.webContents.send('show-exit-confirmation');
        
        // Listen for response
        const handleResponse = (event, confirmed) => {
          ipcMain.removeListener('exit-confirmation-response', handleResponse);
          this.logger.info('🚪 Exit confirmation response received:', confirmed);
          
          if (confirmed) {
            lastExitCancelTime = 0;
            const windowCount = BrowserWindow.getAllWindows().length;
            this.logger.info(`🚪 User confirmed exit. Total windows: ${windowCount}`);
            
            if (windowCount > 1) {
              // Multiple windows open - close only this window, keep others running
              this.logger.info(`🚪 Closing only window ${window.id}, keeping ${windowCount - 1} other window(s) open`);
              window.close();
            } else {
              // Last window - quit the app
              this.logger.info('🚪 Last window closing - quitting app');
              app.quit();
            }
          } else {
            lastExitCancelTime = Date.now();
          }
          
          resolve(confirmed);
        };
        
        ipcMain.once('exit-confirmation-response', handleResponse);
        
        // Fallback timeout
        setTimeout(() => {
          ipcMain.removeListener('exit-confirmation-response', handleResponse);
          resolve(false);
        }, 30000);
      } else {
        resolve(false);
      }
    });
  }

  /**
   * Open file explorer at specific directory
   * @param {string} dirPath - Directory path to show
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async openFileExplorer(dirPath) {
    try {
      await shell.showItemInFolder(dirPath);
      return { success: true };
    } catch (error) {
      this.logger.error('Error opening file explorer:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Register all system operations IPC handlers
   */
  registerHandlers() {
    this.logger.info('⚙️ Registering system operations IPC handlers');

    

    /**
     * Check Node.js installation
     */
    ipcMain.handle('checkNodeInstallation', async () => {
      try {
        const detectionResult = await this.detectNodeInstallation();
        return detectionResult;
      } catch (error) {
        this.logger.error('Error checking Node.js installation:', error);
        return { 
          status: 'error',
          message: `Erro na detecção: ${error.message}`,
          needsInstallation: true,
          error: error.message
        };
      }
    });

    /**
     * Install Node.js dependencies
     */
    ipcMain.handle('installNodeDependencies', async (event, options = {}) => {
      return await this.installNodeDependencies(options);
    });

    /**
     * Get Node.js installation progress
     */
    ipcMain.handle('getNodeInstallationProgress', async () => {
      return this.getNodeInstallationProgress();
    });

    /**
     * Get app logs
     */
    ipcMain.handle('get-app-logs', async () => {
      return this.getAppLogs();
    });

    /**
     * Clear console output
     */
    ipcMain.on('clear-console-output', (event, type) => {
      this.clearConsoleOutput(event, type);
    });

    /**
     * Navigate to page
     */
    ipcMain.on('navigate', (event, page) => {
      this.navigate(event, page);
    });

    /**
     * Get dev server URL
     */
    ipcMain.handle('get-dev-server-url-from-main', () => {
      return this.getDevServerUrlFromMain();
    });

    /**
     * Confirm app exit
     */
    ipcMain.handle('confirm-exit-app', async (event) => {
      return await this.confirmExitApp(event);
    });

    /**
     * Open file explorer
     */
    ipcMain.handle('open-file-explorer', async (event, dirPath) => {
      return this.openFileExplorer(dirPath);
    });

    ipcMain.handle('completeWelcomeSetup', async (event) => {
      return this.completeWelcomeSetup(event);
    });

    /**
     * Create new window with state
     */
    ipcMain.handle('create-new-window-with-state', async (event, windowState) => {
      return await this.createNewWindowWithState(windowState);
    });

    /**
     * Close and reopen to index
     */
    ipcMain.handle('close-and-reopen-to-index', async (event) => {
      return await this.closeAndReopenToIndex(event);
    });

    const { nativeTheme } = require('electron');
    this._lastBroadcastedMode = null;
        this._themeChangeHandler = async () => {
      const osDark = await this.themeService?._detectOsDarkPreference?.() ?? (nativeTheme.shouldUseDarkColors ?? false);
      const resolvedMode = osDark ? 'dark' : 'light';
      if (resolvedMode !== this._lastBroadcastedMode) {
        this._lastBroadcastedMode = resolvedMode;
        const rawMode = this.themeService?.getRawMode?.() || 'auto';
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('theme-changed', { resolvedMode, rawMode });
          }
        });
        this.logger.info(`🎨 OS theme changed → broadcasted resolvedMode=${resolvedMode}`);
      }
    };
    nativeTheme.on('updated', this._themeChangeHandler);

    /**
     * Set theme mode (auto/dark/light) — persists to runtime-env.json and
     * applies the new theme at runtime via webContents.insertCSS() without
     * reloading the window (avoids white flash and state loss).
     */
    ipcMain.handle('set-theme-mode', async (event, mode) => {
      try {
        const validModes = ['auto', 'dark', 'light'];
        if (!validModes.includes(mode)) {
          return { success: false, error: `Invalid mode: ${mode}` };
        }

        // Persist to database (replaces old runtime-env.json approach)
        if (this.themeService) {
          await this.themeService.saveThemeMode(mode);
        }

        let resolvedMode = mode;
        if (mode === 'auto') {
          const osPrefersDark = await this.themeService?._detectOsDarkPreference?.()
            ?? ((require('electron').nativeTheme.shouldUseDarkColors ?? false));
          resolvedMode = osPrefersDark ? 'dark' : 'light';
        }

        // If the active theme doesn't support the resolved mode (e.g. a
        // dark-only theme like tokyo-night when mode is 'light'), fall back
        // to the first available mode so the injected CSS is complete and
        // carries the theme's actual colors instead of just base defaults.
        const availableModes = (this.themeService && this.themeService.manifest?.mode) || ['dark', 'light'];
        if (!availableModes.includes(resolvedMode)) {
          const fallbackMode = availableModes[0];
          this.logger.warn(
            `🎨 Theme "${this.themeService?.themeName}" does not support mode "${resolvedMode}" ` +
            `(available: [${availableModes.join(', ')}]); falling back to "${fallbackMode}"`
          );
          resolvedMode = fallbackMode;
        }

        this.logger.info(
          `🎨 set-theme-mode: themeService=${!!this.themeService}, requestedMode=${mode}, resolvedMode=${resolvedMode}`
        );

        /** @type {string} CSS content for the resolved mode, hoisted so the
         *  return statement (outside the if-block) can send it to the renderer
         *  as a direct-injection fallback. */
        let css = '';
        if (this.themeService) {
          css = await this.themeService.getResolvedCssForMode(resolvedMode);
          this.logger.info(`🎨 Generated CSS: ${css.length} chars for mode ${resolvedMode}`);
          const windows = BrowserWindow.getAllWindows();
          for (const win of windows) {
            // Inject via executeJavaScript to create a <style> element at the end
            // of <head>. This ensures the injected CSS comes AFTER <link> stylesheets
            // in the cascade, overriding theme-override.css and other author-origin
            // stylesheets. insertCSS(css, {cssOrigin: 'author'}) is not used because
            // Blink places injectedAuthorSheets_ BEFORE regular <link> stylesheets,
            // so theme-override.css (same specificity, later in cascade) always wins.
            const script = `(function(css){
              var el=document.getElementById('__theme_injected');
              if(el)el.remove();
              var s=document.createElement('style');
              s.id='__theme_injected';
              s.textContent=css;
              document.head.appendChild(s);
            })(${JSON.stringify(css)})`;
            try {
              await win.webContents.executeJavaScript(script);
            } catch (err) {
              this.logger.warn(`🎨 executeJavaScript fallback to insertCSS: ${err.message}`);
              try { win.webContents.insertCSS(css, { cssOrigin: 'author' }); } catch (e) {
                this.logger.error(`🎨 All CSS injection methods failed: ${e.message}`);
              }
            }
          }
          this.logger.info(`🎨 CSS injected into ${windows.length} windows`);
        } else {
          this.logger.warn('🎨 themeService not available, cannot inject CSS');
        }

        this.logger.info(`🎨 Theme mode applied: ${mode} (resolved: ${resolvedMode})`);

        // Return the CSS so the renderer can inject it directly as a
        // fallback — executeJavaScript can fail on subsequent toggles
        // (CSP, timing, etc.), leaving stale CSS in the page.
        return { success: true, mode, resolvedMode, css };
      } catch (error) {
        this.logger.error('Error setting theme mode:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('get-os-dark-preference', async () => {
      try {
        if (this.themeService && this.themeService._detectOsDarkPreference) {
          return { success: true, prefersDark: await this.themeService._detectOsDarkPreference() };
        }
        const { nativeTheme } = require('electron');
        return { success: true, prefersDark: nativeTheme.shouldUseDarkColors ?? false };
      } catch (error) {
        return { success: false, prefersDark: false, error: error.message };
      }
    });

    /**
     * Get current theme mode (raw + resolved).
     * Delegates to ThemeService.getRawMode() which respects the precedence
     * .env (process.env.THEME_MODE) > runtime-env.json > 'auto'.
     *
     * Also returns a resolvedMode — when raw mode is 'auto', resolves it
     * via _detectOsDarkPreference so the renderer can cache the
     * effective dark/light state without re-querying matchMedia.
     */
    ipcMain.handle('get-theme-mode', async () => {
      try {
        if (this.themeService && this.themeService.getRawMode) {
          const rawMode = this.themeService.getRawMode();
          let resolvedMode = rawMode;
          if (rawMode === 'auto') {
          const osPrefersDark = await this.themeService?._detectOsDarkPreference?.()
            ?? ((require('electron').nativeTheme.shouldUseDarkColors ?? false));
            resolvedMode = osPrefersDark ? 'dark' : 'light';
          }
          return { success: true, mode: rawMode, resolvedMode };
        }
        return { success: true, mode: 'auto', resolvedMode: 'dark' };
      } catch (error) {
        this.logger.error('Error getting theme mode:', error);
        return { success: false, mode: 'auto', resolvedMode: 'dark', error: error.message };
      }
    });

    this.logger.info('✅ System operations IPC handlers registered');
  }

  /**
   * Unregister all system operations IPC handlers
   */
  unregisterHandlers() {
    this.logger.info('⚙️ Unregistering system operations IPC handlers');
    
    // Remove handle-based handlers
    ipcMain.removeHandler('checkNodeInstallation');
    ipcMain.removeHandler('installNodeDependencies');
    ipcMain.removeHandler('getNodeInstallationProgress');
    ipcMain.removeHandler('get-app-logs');
    ipcMain.removeHandler('get-dev-server-url-from-main');
    ipcMain.removeHandler('confirm-exit-app');
    ipcMain.removeHandler('open-file-explorer');
    ipcMain.removeHandler('create-new-window-with-state');
    ipcMain.removeHandler('set-theme-mode');
    ipcMain.removeHandler('get-os-dark-preference');
    ipcMain.removeHandler('get-theme-mode');
    
    // Remove nativeTheme listener (saved reference prevents duplicate registration)
    if (this._themeChangeHandler) {
      const { nativeTheme } = require('electron');
      nativeTheme.removeListener('updated', this._themeChangeHandler);
      this._themeChangeHandler = null;
    }

    // Remove all listeners for event-based handlers
    ipcMain.removeAllListeners('clear-console-output');
    ipcMain.removeAllListeners('navigate');
    
    this.logger.info('✅ System operations IPC handlers unregistered');
  }
}

module.exports = {
  SystemHandlers,
  getActiveExecs,
  killAllActiveExecs
};
