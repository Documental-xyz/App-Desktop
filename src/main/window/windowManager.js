/**
 * @fileoverview Window management module for Electron main process
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { BrowserWindow, Menu } = require('electron');

/** @type {string} Background color for BrowserWindow (shown before CSS loads) */
const WINDOW_BG_COLOR = '#111827';
const path = require('path');
const fs = require('fs');
const { getLogger } = require('../logging/logger.js');
const { getAppIcon } = require('../platform/icons');

/**
 * @typedef {Object} WindowConfig
 * @property {number} width - Window width
 * @property {number} height - Window height
 * @property {boolean} show - Whether to show window initially
 * @property {boolean} maximize - Whether to maximize window
 * @property {Object} webPreferences - Web preferences
 */

/**
 * @typedef {Object} WindowManagerConfig
 * @property {string} basePath - Base path for renderer files
 * @property {string} userDataPath - User data path
 * @property {WindowConfig} windowConfig - Window configuration
 */

/**
 * Window manager class for Electron applications
 */
class WindowManager {
  /**
   * Create a new WindowManager instance
   * @param {WindowManagerConfig} config - Window manager configuration
   */
  constructor(config = {}) {
    this.logger = getLogger('WindowManager');
    this.mainWindow = null;
    this.config = {
      basePath: config.basePath || __dirname,
      userDataPath: config.userDataPath,
      windowConfig: {
        width: 900,
        height: 600,
        show: false,
        maximize: true,
        webPreferences: {
          preload: path.resolve(__dirname, '..', '..', '..', 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
          ...config.windowConfig?.webPreferences
        },
        ...config.windowConfig
      }
    };
  }

  /**
   * Create a custom window with specified HTML file
   * @param {string} htmlFile - HTML file to load
   * @param {Object} windowConfig - Window configuration overrides
   * @returns {Promise<BrowserWindow>} The created window
   */
  async createWindow(htmlFile, windowConfig = {}) {
    this.logger.info(`🪟 Creating custom window: ${htmlFile}`);
    
    const window = new BrowserWindow({
      width: windowConfig.width || this.config.windowConfig.width,
      height: windowConfig.height || this.config.windowConfig.height,
      show: false,
      backgroundColor: WINDOW_BG_COLOR,
      icon: getAppIcon(),
      resizable: windowConfig.resizable !== false,
      maximizable: windowConfig.maximizable !== false,
      minimizable: windowConfig.minimizable !== false,
      webPreferences: {
        ...this.config.windowConfig.webPreferences,
        ...windowConfig.webPreferences
      }
    });

    // Load the specified HTML file
    const filePath = path.join(this.config.basePath, 'renderer', htmlFile);
    this.logger.info(`📄 Loading file: ${filePath}`);
    
    await window.loadFile(filePath);

    // Maximize window if configured
    if (windowConfig.maximize) {
      window.maximize();
    }

    // Show window
    window.show();

    // Hide menu bar for custom windows
    Menu.setApplicationMenu(null);

    this.logger.info(`✅ Custom window '${htmlFile}' created and shown successfully`);
    
    return window;
  }

  /**
   * Create and show the main application window
   * @returns {Promise<BrowserWindow>} The created window
   */
  async createMainWindow() {
    this.logger.info('🪟 Creating main window with modular architecture');
    
    this.mainWindow = new BrowserWindow({
      width: this.config.windowConfig.width,
      height: this.config.windowConfig.height,
      show: false,
      backgroundColor: WINDOW_BG_COLOR,
      icon: getAppIcon(),
      webPreferences: this.config.windowConfig.webPreferences
    });

    // Maximize window if configured
    if (this.config.windowConfig.maximize) {
      this.mainWindow.maximize();
    }

    // Load appropriate content based on first-time user status
    const isFirstTime = await this.checkFirstTimeUser();
    
    if (isFirstTime) {
      this.logger.info('👋 First time user detected - showing welcome screen');
      await this.mainWindow.loadFile(path.join(this.config.basePath, 'renderer', 'language.html'));
    } else {
      this.logger.info('🏠 Returning user detected - showing main screen');
      await this.mainWindow.loadFile(path.join(this.config.basePath, 'renderer', 'index.html'));
    }

    // Show window after content + theme are loaded
    this.mainWindow.show();

    // Hide menu bar
    Menu.setApplicationMenu(null);

    this.logger.info('✅ Main window created and shown successfully');
    
    return this.mainWindow;
  }

  /**
   * Check if it's the first time the user is running the app
   * @returns {Promise<boolean>} True if first time user
   */
  checkFirstTimeUser() {
    return new Promise((resolve) => {
      if (!this.config.userDataPath) {
        this.logger.warn('⚠️ userDataPath not configured, assuming returning user');
        resolve(false);
        return;
      }

      const firstTimeFile = path.join(this.config.userDataPath, '.first-time');
      this.logger.info(`🔍 Checking first-time user status at: ${firstTimeFile}`);
      
      if (fs.existsSync(firstTimeFile)) {
        try {
          const content = fs.readFileSync(firstTimeFile, 'utf8').trim();
          const isCompleted = content === 'completed';
          this.logger.info(`📋 First-time file exists with content: "${content}", completed: ${isCompleted}, isFirstTime: ${!isCompleted}`);
          
          // Additional verification: ensure content is exactly "completed"
          if (isCompleted) {
            this.logger.info('✅ Setup completion verified - user is returning');
          } else {
            this.logger.warn('⚠️ File exists but content is not "completed" - treating as first time');
          }
          
          resolve(!isCompleted); // Return true if NOT completed
        } catch (error) {
          this.logger.error('❌ Error reading first-time file:', error);
          resolve(true); // Assume first time if file is corrupted
        }
      } else {
        this.logger.info(`📝 No first-time file found at ${firstTimeFile}, user is first time`);
        resolve(true);
      }
    });
  }

  /**
   * Get the main window instance
   * @returns {BrowserWindow|null} The main window or null if not created
   */
  getMainWindow() {
    return this.mainWindow;
  }

  /**
   * Check if main window exists and is not destroyed
   * @returns {boolean} True if window is valid
   */
  hasValidMainWindow() {
    return this.mainWindow && !this.mainWindow.isDestroyed();
  }

  /**
   * Close the main window
   */
  closeMainWindow() {
    if (this.hasValidMainWindow()) {
      this.logger.info('🔒 Closing main window');
      this.mainWindow.close();
      this.mainWindow = null;
    }
  }

  /**
   * Create a new window with custom configuration
   * @param {WindowConfig} windowConfig - Custom window configuration
   * @returns {BrowserWindow} The created window
   */
  createCustomWindow(windowConfig = {}) {
    const config = {
      icon: getAppIcon(),
      ...this.config.windowConfig,
      ...windowConfig,
      webPreferences: {
        ...this.config.windowConfig.webPreferences,
        ...windowConfig.webPreferences
      }
    };

    this.logger.info('🪟 Creating custom window with config:', config);
    
    const window = new BrowserWindow(config);
    
    if (config.maximize) {
      window.maximize();
    }
    
    if (config.show !== false) {
      window.show();
    }

    return window;
  }

  /**
   * Get all open windows
   * @returns {Array<BrowserWindow>} Array of open windows
   */
  getAllWindows() {
    return BrowserWindow.getAllWindows();
  }

  /**
   * Send a message to the main window
   * @param {string} channel - IPC channel
   * @param {...any} args - Arguments to send
   * @returns {boolean} True if message was sent
   */
  sendToMainWindow(channel, ...args) {
    if (this.hasValidMainWindow()) {
      this.mainWindow.webContents.send(channel, ...args);
      return true;
    }
    return false;
  }

  /**
   * Focus the main window
   * @returns {boolean} True if window was focused
   */
  focusMainWindow() {
    if (this.hasValidMainWindow()) {
      this.mainWindow.focus();
      return true;
    }
    return false;
  }

  /**
   * Minimize the main window
   * @returns {boolean} True if window was minimized
   */
  minimizeMainWindow() {
    if (this.hasValidMainWindow()) {
      this.mainWindow.minimize();
      return true;
    }
    return false;
  }

  /**
   * Toggle maximize state of main window
   * @returns {boolean} True if operation was successful
   */
  toggleMaximizeMainWindow() {
    if (this.hasValidMainWindow()) {
      if (this.mainWindow.isMaximized()) {
        this.mainWindow.unmaximize();
      } else {
        this.mainWindow.maximize();
      }
      return true;
    }
    return false;
  }
  /**
   * Close all open windows
   */
  closeAllWindows() {
    const windows = BrowserWindow.getAllWindows();
    this.logger.info(`Closing all windows (${windows.length} found)`);
    windows.forEach(window => {
      if (!window.isDestroyed()) {
        window.close();
      }
    });
    this.mainWindow = null;
    this.logger.info('All windows closed');
  }
}

module.exports = {
  WindowManager
};