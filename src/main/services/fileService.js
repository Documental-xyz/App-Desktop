/**
 * @fileoverview File operations service for dialogs and shell operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;

/**
 * @typedef {Object} DialogResult
 * @property {boolean} canceled - Whether dialog was canceled
 * @property {string[]} [filePaths] - Selected file paths
 * @property {string} [filePath] - Selected file path (single selection)
 */

/**
 * @typedef {Object} FileOperationResult
 * @property {boolean} success - Whether operation succeeded
 * @property {string} [error] - Error message if operation failed
 * @property {*} [data] - Operation result data
 */

/**
 * File Service - Handles file dialogs, shell operations, and file system utilities
 */
class FileService {
  /**
   * Create an instance of FileService
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.windowManager - Window manager instance
   */
  constructor({ logger, windowManager }) {
    this.logger = logger;
    this.windowManager = windowManager;
  }

  /**
   * Show open directory dialog
   * @param {BrowserWindow} [parentWindow] - Parent window for dialog
   * @returns {Promise<string|null>} Selected directory path or null if canceled
   */
  async showOpenDirectoryDialog(parentWindow = null) {
    try {
      const window = parentWindow || this.windowManager.getMainWindow();
      
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

      if (result.canceled) {
        this.logger.debug('Directory dialog canceled');
        return null;
      }

      const selectedPath = result.filePaths[0];
      this.logger.info(`Directory selected: ${selectedPath}`);
      return selectedPath;
    } catch (error) {
      this.logger.error('Error showing open directory dialog:', error);
      return null;
    }
  }

  /**
   * Show open file dialog
   * @param {Object} options - Dialog options
   * @param {string[]} [options.filters] - File filters
   * @param {boolean} [options.multiSelect=false] - Allow multiple file selection
   * @param {BrowserWindow} [parentWindow] - Parent window for dialog
   * @returns {Promise<DialogResult>} Dialog result
   */
  async showOpenFileDialog(options = {}, parentWindow = null) {
    try {
      const window = parentWindow || this.windowManager.getMainWindow();
      
      if (!window) {
        throw new Error('No valid window available for dialog');
      }

      const dialogOptions = {
        title: options.title || 'Select File',
        properties: options.multiSelect ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: options.filters || [
          { name: 'All Files', extensions: ['*'] }
        ]
      };

      const result = await dialog.showOpenDialog(window, dialogOptions);
      
      this.logger.info(`File dialog result: canceled=${result.canceled}, files=${result.filePaths.length}`);
      return result;
    } catch (error) {
      this.logger.error('Error showing open file dialog:', error);
      throw error;
    }
  }

  /**
   * Show save file dialog
   * @param {Object} options - Dialog options
   * @param {string} [options.defaultPath] - Default file path
   * @param {string[]} [options.filters] - File filters
   * @param {BrowserWindow} [parentWindow] - Parent window for dialog
   * @returns {Promise<string|null>} Selected file path or null if canceled
   */
  async showSaveFileDialog(options = {}, parentWindow = null) {
    try {
      const window = parentWindow || this.windowManager.getMainWindow();
      
      if (!window) {
        throw new Error('No valid window available for dialog');
      }

      const dialogOptions = {
        title: options.title || 'Save File',
        defaultPath: options.defaultPath,
        filters: options.filters || [
          { name: 'All Files', extensions: ['*'] }
        ]
      };

      const result = await dialog.showSaveDialog(window, dialogOptions);
      
      if (result.canceled) {
        this.logger.debug('Save dialog canceled');
        return null;
      }

      this.logger.info(`File save path selected: ${result.filePath}`);
      return result.filePath;
    } catch (error) {
      this.logger.error('Error showing save file dialog:', error);
      throw error;
    }
  }

  /**
   * Show item in folder using system file manager
   * @param {string} itemPath - Path to file or folder to show
   * @returns {Promise<FileOperationResult>} Operation result
   */
  async showItemInFolder(itemPath) {
    try {
      if (!itemPath) {
        throw new Error('Item path is required');
      }

      await shell.showItemInFolder(itemPath);
      this.logger.info(`Opened item in system file manager: ${itemPath}`);
      
      return { success: true };
    } catch (error) {
      this.logger.error('Error opening item in folder:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Open file or URL with system default application
   * @param {string} path - File path or URL to open
   * @returns {Promise<FileOperationResult>} Operation result
   */
  async openExternal(path) {
    try {
      if (!path) {
        throw new Error('Path is required');
      }

      await shell.openExternal(path);
      this.logger.info(`Opened external path: ${path}`);
      
      return { success: true };
    } catch (error) {
      this.logger.error('Error opening external path:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if file or directory exists
   * @param {string} filePath - Path to check
   * @returns {boolean} Whether path exists
   */
  async exists(filePath) {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      this.logger.error('Error checking file existence:', error);
      return false;
    }
  }

  /**
   * Get file statistics
   * @param {string} filePath - Path to file
   * @returns {Object|null} File stats or null if error
   */
  async getStats(filePath) {
    try {
      return await fsPromises.stat(filePath);
    } catch (error) {
      this.logger.error('Error getting file stats:', error);
      return null;
    }
  }

  /**
   * Check if path is a directory
   * @param {string} dirPath - Path to check
   * @returns {boolean} Whether path is a directory
   */
  async isDirectory(dirPath) {
    try {
      const stats = await fsPromises.stat(dirPath);
      return stats.isDirectory();
    } catch (error) {
      this.logger.error('Error checking if path is directory:', error);
      return false;
    }
  }

  /**
   * Check if path is a file
   * @param {string} filePath - Path to check
   * @returns {boolean} Whether path is a file
   */
  async isFile(filePath) {
    try {
      const stats = await fsPromises.stat(filePath);
      return stats.isFile();
    } catch (error) {
      this.logger.error('Error checking if path is file:', error);
      return false;
    }
  }

  /**
   * Read directory contents
   * @param {string} dirPath - Directory path
   * @returns {string[]} Array of file/directory names
   */
  async readDirectory(dirPath) {
    try {
      return await fsPromises.readdir(dirPath);
    } catch (error) {
      this.logger.error('Error reading directory:', error);
      return [];
    }
  }

  /**
   * Create directory recursively
   * @param {string} dirPath - Directory path to create
   * @returns {FileOperationResult} Operation result
   */
  async createDirectory(dirPath) {
    try {
      await fsPromises.mkdir(dirPath, { recursive: true });
      this.logger.info(`Directory created: ${dirPath}`);
      return { success: true };
    } catch (error) {
      this.logger.error('Error creating directory:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove file or directory recursively
   * @param {string} targetPath - Path to remove
   * @returns {FileOperationResult} Operation result
   */
  async remove(targetPath) {
    try {
      const stats = await fsPromises.stat(targetPath);
      
      if (stats.isDirectory()) {
        await fsPromises.rm(targetPath, { recursive: true, force: true });
        this.logger.info(`Directory removed: ${targetPath}`);
      } else {
        await fsPromises.unlink(targetPath);
        this.logger.info(`File removed: ${targetPath}`);
      }
      
      return { success: true };
    } catch (error) {
      this.logger.error('Error removing path:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get home directory path
   * @returns {string} Home directory path
   */
  getHomeDirectory() {
    // This will be called from IPC handler where app is available
    const { app } = require('electron');
    return app.getPath('home');
  }

  /**
   * Get user data directory path
   * @returns {string} User data directory path
   */
  getUserDataDirectory() {
    const { app } = require('electron');
    return app.getPath('userData');
  }

  /**
   * Get temp directory path
   * @returns {string} Temp directory path
   */
  getTempDirectory() {
    const { app } = require('electron');
    return app.getPath('temp');
  }

  /**
   * Join path segments
   * @param {...string} segments - Path segments
   * @returns {string} Joined path
   */
  joinPath(...segments) {
    return path.join(...segments);
  }

  /**
   * Get directory name from path
   * @param {string} filePath - File path
   * @returns {string} Directory name
   */
  getDirName(filePath) {
    return path.dirname(filePath);
  }

  /**
   * Get base name from path
   * @param {string} filePath - File path
   * @returns {string} Base name
   */
  getBaseName(filePath) {
    return path.basename(filePath);
  }

  /**
   * Get file extension from path
   * @param {string} filePath - File path
   * @returns {string} File extension
   */
  getExtension(filePath) {
    return path.extname(filePath);
  }

  /**
   * Normalize path
   * @param {string} filePath - Path to normalize
   * @returns {string} Normalized path
   */
  normalizePath(filePath) {
    return path.normalize(filePath);
  }

  /**
   * Resolve path to absolute
   * @param {...string} segments - Path segments
   * @returns {string} Absolute path
   */
  resolvePath(...segments) {
    return path.resolve(...segments);
  }
}

module.exports = { FileService };