/**
 * @fileoverview IPC handlers for file operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain, BrowserWindow } = require('electron');

/**
 * File Operations IPC Handlers
 */
class FileHandlers {
  /**
   * Create an instance of FileHandlers
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.fileService - File service instance
   */
  constructor({ logger, fileService }) {
    this.logger = logger;
    this.fileService = fileService;
  }

  /**
   * Handle get home directory
   * @returns {string} Home directory path
   */
  getHomeDirectory() {
    return this.fileService.getHomeDirectory();
  }

  /**
   * Handle open directory dialog
   * @param {Object} event - IPC event object
   * @returns {Promise<string|null>} Selected directory path or null
   */
  async openDirectoryDialog(event) {
    try {
      const senderWindow = event ? BrowserWindow.fromWebContents(event.sender) : null;
      const selectedPath = await this.fileService.showOpenDirectoryDialog(senderWindow);
      return selectedPath;
    } catch (error) {
      this.logger.error('Error in open directory dialog handler:', error);
      throw error;
    }
  }

  /**
   * Handle open file dialog
   * @param {Object} event - IPC event object
   * @param {Object} options - Dialog options
   * @returns {Promise<Object>} Dialog result
   */
  async openFileDialog(event, options = {}) {
    try {
      const result = await this.fileService.showOpenFileDialog(options);
      return result;
    } catch (error) {
      this.logger.error('Error in open file dialog handler:', error);
      throw error;
    }
  }

  /**
   * Handle save file dialog
   * @param {Object} event - IPC event object
   * @param {Object} options - Dialog options
   * @returns {Promise<string|null>} Selected file path or null
   */
  async saveFileDialog(event, options = {}) {
    try {
      const selectedPath = await this.fileService.showSaveFileDialog(options);
      return selectedPath;
    } catch (error) {
      this.logger.error('Error in save file dialog handler:', error);
      throw error;
    }
  }

  /**
   * Handle show item in folder
   * @param {Object} event - IPC event object
   * @param {string} itemPath - Path to show
   * @returns {Promise<Object>} Operation result
   */
  async showItemInFolder(event, itemPath) {
    try {
      const result = await this.fileService.showItemInFolder(itemPath);
      return result;
    } catch (error) {
      this.logger.error('Error in show item in folder handler:', error);
      throw error;
    }
  }

  /**
   * Handle open external
   * @param {Object} event - IPC event object
   * @param {string} path - Path to open
   * @returns {Promise<Object>} Operation result
   */
  async openExternal(event, path) {
    try {
      const result = await this.fileService.openExternal(path);
      return result;
    } catch (error) {
      this.logger.error('Error in open external handler:', error);
      throw error;
    }
  }

  /**
   * Handle check if path exists
   * @param {Object} event - IPC event object
   * @param {string} filePath - Path to check
   * @returns {boolean} Whether path exists
   */
  async pathExists(event, filePath) {
    try {
      return await this.fileService.exists(filePath);
    } catch (error) {
      this.logger.error('Error in path exists handler:', error);
      return false;
    }
  }

  /**
   * Handle get file stats
   * @param {Object} event - IPC event object
   * @param {string} filePath - Path to check
   * @returns {Object|null} File stats or null
   */
  async getFileStats(event, filePath) {
    try {
      return await this.fileService.getStats(filePath);
    } catch (error) {
      this.logger.error('Error in get file stats handler:', error);
      return null;
    }
  }

  /**
   * Handle check if path is directory
   * @param {Object} event - IPC event object
   * @param {string} dirPath - Path to check
   * @returns {boolean} Whether path is directory
   */
  async isDirectory(event, dirPath) {
    try {
      return await this.fileService.isDirectory(dirPath);
    } catch (error) {
      this.logger.error('Error in is directory handler:', error);
      return false;
    }
  }

  /**
   * Handle check if path is file
   * @param {Object} event - IPC event object
   * @param {string} filePath - Path to check
   * @returns {boolean} Whether path is file
   */
  async isFile(event, filePath) {
    try {
      return await this.fileService.isFile(filePath);
    } catch (error) {
      this.logger.error('Error in is file handler:', error);
      return false;
    }
  }

  /**
   * Handle read directory
   * @param {Object} event - IPC event object
   * @param {string} dirPath - Directory path
   * @returns {string[]} Directory contents
   */
  async readDirectory(event, dirPath) {
    try {
      return await this.fileService.readDirectory(dirPath);
    } catch (error) {
      this.logger.error('Error in read directory handler:', error);
      return [];
    }
  }

  /**
   * Handle create directory
   * @param {Object} event - IPC event object
   * @param {string} dirPath - Directory path to create
   * @returns {Object} Operation result
   */
  async createDirectory(event, dirPath) {
    try {
      return await this.fileService.createDirectory(dirPath);
    } catch (error) {
      this.logger.error('Error in create directory handler:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle remove path
   * @param {Object} event - IPC event object
   * @param {string} targetPath - Path to remove
   * @returns {Object} Operation result
   */
  async removePath(event, targetPath) {
    try {
      return await this.fileService.remove(targetPath);
    } catch (error) {
      this.logger.error('Error in remove path handler:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle join path
   * @param {Object} event - IPC event object
   * @param {...string} segments - Path segments
   * @returns {string} Joined path
   */
  joinPath(event, ...segments) {
    try {
      return this.fileService.joinPath(...segments);
    } catch (error) {
      this.logger.error('Error in join path handler:', error);
      return '';
    }
  }

  /**
   * Handle get directory name
   * @param {Object} event - IPC event object
   * @param {string} filePath - File path
   * @returns {string} Directory name
   */
  getDirName(event, filePath) {
    try {
      return this.fileService.getDirName(filePath);
    } catch (error) {
      this.logger.error('Error in get dir name handler:', error);
      return '';
    }
  }

  /**
   * Handle get base name
   * @param {Object} event - IPC event object
   * @param {string} filePath - File path
   * @returns {string} Base name
   */
  getBaseName(event, filePath) {
    try {
      return this.fileService.getBaseName(filePath);
    } catch (error) {
      this.logger.error('Error in get base name handler:', error);
      return '';
    }
  }

  /**
   * Handle normalize path
   * @param {Object} event - IPC event object
   * @param {string} filePath - File path
   * @returns {string} Normalized path
   */
  normalizePath(event, filePath) {
    try {
      return this.fileService.normalizePath(filePath);
    } catch (error) {
      this.logger.error('Error in normalize path handler:', error);
      return '';
    }
  }

  /**
   * Handle get extension
   * @param {Object} event - IPC event object
   * @param {string} filePath - File path
   * @returns {string} File extension
   */
  getExtension(event, filePath) {
    try {
      return this.fileService.getExtension(filePath);
    } catch (error) {
      this.logger.error('Error in get extension handler:', error);
      return '';
    }
  }

  /**
   * Register all file operations IPC handlers
   */
  registerHandlers() {
    this.logger.info('📂 Registering file operations IPC handlers');

    /**
     * Get home directory
     */
    ipcMain.handle('get-home-directory', () => {
      return this.getHomeDirectory();
    });

    /**
     * Open directory dialog
     */
    ipcMain.handle('open-directory-dialog', async (event) => {
      return await this.openDirectoryDialog(event);
    });

    /**
     * Open file dialog
     */
    ipcMain.handle('open-file-dialog', async (event, options) => {
      return await this.openFileDialog(event, options);
    });

    /**
     * Save file dialog
     */
    ipcMain.handle('save-file-dialog', async (event, options) => {
      return await this.saveFileDialog(event, options);
    });

    /**
     * Show item in folder
     */
    ipcMain.handle('show-item-in-folder', async (event, itemPath) => {
      return await this.showItemInFolder(event, itemPath);
    });

    /**
     * Open external
     */
    ipcMain.handle('open-external', async (event, path) => {
      return await this.openExternal(event, path);
    });

    /**
     * Path exists
     */
    ipcMain.handle('path-exists', (event, filePath) => {
      return this.pathExists(event, filePath);
    });

    /**
     * Get file stats
     */
    ipcMain.handle('get-file-stats', (event, filePath) => {
      return this.getFileStats(event, filePath);
    });

    /**
     * Is directory
     */
    ipcMain.handle('is-directory', (event, dirPath) => {
      return this.isDirectory(event, dirPath);
    });

    /**
     * Is file
     */
    ipcMain.handle('is-file', (event, filePath) => {
      return this.isFile(event, filePath);
    });

    /**
     * Read directory
     */
    ipcMain.handle('read-directory', (event, dirPath) => {
      return this.readDirectory(event, dirPath);
    });

    /**
     * Create directory
     */
    ipcMain.handle('create-directory', (event, dirPath) => {
      return this.createDirectory(event, dirPath);
    });

    /**
     * Remove path
     */
    ipcMain.handle('remove-path', (event, targetPath) => {
      return this.removePath(event, targetPath);
    });

    /**
     * Join path
     */
    ipcMain.handle('join-path', (event, ...segments) => {
      return this.joinPath(event, ...segments);
    });

    /**
     * Get directory name
     */
    ipcMain.handle('get-dir-name', (event, filePath) => {
      return this.getDirName(event, filePath);
    });

    /**
     * Get base name
     */
    ipcMain.handle('get-base-name', (event, filePath) => {
      return this.getBaseName(event, filePath);
    });

    /**
     * Normalize path
     */
    ipcMain.handle('normalizePath', (event, filePath) => {
      return this.normalizePath(event, filePath);
    });

    /**
     * Get extension
     */
    ipcMain.handle('get-extension', (event, filePath) => {
      return this.getExtension(event, filePath);
    });

    this.logger.info('✅ File operations IPC handlers registered');
  }

  /**
   * Unregister all file operations IPC handlers
   */
  unregisterHandlers() {
    this.logger.info('📂 Unregistering file operations IPC handlers');
    
    ipcMain.removeHandler('get-home-directory');
    ipcMain.removeHandler('open-directory-dialog');
    ipcMain.removeHandler('open-file-dialog');
    ipcMain.removeHandler('save-file-dialog');
    ipcMain.removeHandler('show-item-in-folder');
    ipcMain.removeHandler('open-external');
    ipcMain.removeHandler('path-exists');
    ipcMain.removeHandler('get-file-stats');
    ipcMain.removeHandler('is-directory');
    ipcMain.removeHandler('is-file');
    ipcMain.removeHandler('read-directory');
    ipcMain.removeHandler('create-directory');
    ipcMain.removeHandler('remove-path');
    ipcMain.removeHandler('join-path');
    ipcMain.removeHandler('get-dir-name');
    ipcMain.removeHandler('get-base-name');
    ipcMain.removeHandler('get-extension');
    
    this.logger.info('✅ File operations IPC handlers unregistered');
  }
}

module.exports = { FileHandlers };