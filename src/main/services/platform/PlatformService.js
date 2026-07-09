/**
 * @fileoverview Platform service for unified cross-platform operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { PlatformAdapterFactory } = require('../../factories/PlatformAdapterFactory.js');
const { spawn } = require('child_process');
const { killProcessTree } = require('../../processes/killProcessTree.js');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

/**
 * Tracks all spawned child processes from executeCommand so they can be
 * killed on reject or reaped wholesale via cleanupAll().
 * @type {Array<import('child_process').ChildProcess>}
 */
const activeCommands = [];

/**
 * Platform Service
 * Provides unified cross-platform operations using platform adapters
 * @class
 */
class PlatformService {
  /**
   * Create an instance of PlatformService
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {PlatformPort} [dependencies.adapter] - Platform adapter instance
   */
  constructor({ logger, adapter = null }) {
    this.logger = logger;
    this.adapter = adapter || PlatformAdapterFactory.createAdapter();
  }

  /**
   * Get current platform adapter
   * @returns {PlatformPort} Current platform adapter
   */
  getAdapter() {
    return this.adapter;
  }

  /**
   * Execute a command with platform-specific configuration
   * @param {string} command - Command to execute
   * @param {Array<string>} [args=[]] - Command arguments
   * @param {Object} [options={}] - Execution options
   * @returns {Promise<Object>} Execution result
   */
  async executeCommand(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
      const shell = this.adapter.getDefaultShell();
      const env = this.adapter.getEnvironmentConfig();
      
      const mergedOptions = {
        shell: true,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
        ...options
      };

      this.logger.info(`🚀 Executing command: ${command} ${args.join(' ')} on ${this.adapter.getPlatform()}`);
      
      const startTime = Date.now();
      const child = spawn(command, args, mergedOptions);
      activeCommands.push(child);
      
      const unregister = () => {
        const idx = activeCommands.indexOf(child);
        if (idx !== -1) activeCommands.splice(idx, 1);
      };
      
      let stdout = '';
      let stderr = '';
      
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      
      child.on('close', (code) => {
        unregister();
        const result = {
          success: code === 0,
          exitCode: code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          command: `${command} ${args.join(' ')}`,
          platform: this.adapter.getPlatform(),
          duration: Date.now() - startTime
        };
        
        if (result.success) {
          this.logger.info(`✅ Command succeeded: ${result.command}`);
          resolve(result);
        } else {
          this.logger.error(`❌ Command failed: ${result.command} (exit code: ${code})`);
          this.logger.error(`stderr: ${stderr}`);
          reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
        }
      });
      
      child.on('error', (error) => {
        unregister();
        // Two-phase kill the still-running child on error path so it can't leak
        killProcessTree(child).catch((killErr) => {
          this.logger.error(`❌ Failed to clean up command on error: ${killErr.message}`);
        });
        this.logger.error(`❌ Command error: ${error.message}`);
        reject(error);
      });
    });
  }

  /**
   * Kill all currently active child processes spawned by executeCommand.
   * Uses two-phase termination (SIGTERM → grace → SIGKILL) via killProcessTree.
   * Safe to call when no commands are active (no-op).
   * @param {number} [gracePeriod=1500] - Milliseconds to wait before SIGKILL escalation
   * @returns {Promise<void>} Resolves when all children have been signalled/exited
   */
  async cleanupAll(gracePeriod = 1500) {
    const snapshot = activeCommands.splice(0);
    if (snapshot.length === 0) {
      return;
    }
    this.logger.info(`🧹 Cleaning up ${snapshot.length} active command(s)`);
    await Promise.all(
      snapshot.map((child) =>
        killProcessTree(child, gracePeriod).catch((err) => {
          this.logger.error(`❌ Cleanup kill failed: ${err.message}`);
        })
      )
    );
  }

  /**
   * Find executable in system PATH and common locations
   * @param {string} executable - Executable name
   * @returns {Promise<string|null>} Executable path or null if not found
   */
  async findExecutable(executable) {
    try {
      // First try platform-specific which/where command
      const whichCommand = await this.adapter.getShellCommand('which');
      const result = await this.executeCommand(whichCommand, [executable], { 
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'] // Only capture stdout
      });
      
      if (result.success && result.stdout) {
        const lines = result.stdout.split('\n').filter(line => line.trim());
        if (lines.length > 0) {
          this.logger.info(`📍 Found ${executable} via ${whichCommand}: ${lines[0]}`);
          return lines[0];
        }
      }
    } catch (error) {
      this.logger.debug(`⚠️ Could not find ${executable} via which/where: ${error.message}`);
    }
    
    // Fallback to checking common paths
    try {
      const commonPaths = await this.adapter.getCommonPaths(executable);
      
      for (const execPath of commonPaths) {
        try {
          await fsPromises.access(execPath);
          this.logger.info(`📍 Found ${executable} in common paths: ${execPath}`);
          return execPath;
        } catch {
          // not found at this path — continue
        }
      }
    } catch (error) {
      this.logger.error(`❌ Error checking common paths for ${executable}: ${error.message}`);
    }
    
    this.logger.warn(`⚠️ Executable not found: ${executable}`);
    return null;
  }

  /**
   * Check if executable exists and is accessible
   * @param {string} executable - Executable name or path
   * @returns {Promise<boolean>} Whether executable exists and is accessible
   */
  async isExecutableAvailable(executable) {
    try {
      const execPath = await this.findExecutable(executable);
      return execPath !== null;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get platform-specific executable name
   * @param {string} baseName - Base executable name
   * @returns {Promise<string>} Platform-specific executable name
   */
  async getExecutableName(baseName) {
    return await this.adapter.getExecutableName(baseName);
  }

  /**
   * Join paths using platform-specific separator
   * @param {...string} segments - Path segments
   * @returns {string} Joined path
   */
  joinPath(...segments) {
    return path.join(...segments);
  }

  /**
   * Normalize path for current platform
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

  /**
   * Get platform information
   * @returns {Object} Platform information object
   */
  getPlatformInfo() {
    return PlatformAdapterFactory.getPlatformInfo();
  }

  /**
   * Check if current platform matches given criteria
   * @param {Object} criteria - Platform criteria
   * @returns {boolean} Whether current platform matches
   */
  matchesPlatform(criteria) {
    const info = this.getPlatformInfo();
    
    return Object.entries(criteria).every(([key, value]) => {
      if (Array.isArray(value)) {
        return value.includes(info[key]);
      }
      return info[key] === value;
    });
  }

  /**
   * Create a directory with platform-specific permissions
   * @param {string} dirPath - Directory path to create
   * @param {Object} [options={}] - Creation options
   * @returns {Promise<Object>} Creation result
   */
  async createDirectory(dirPath, options = {}) {
    try {
      const { recursive = true, mode = 0o755 } = options;
      
      await fsPromises.mkdir(dirPath, { recursive, mode });
      
      // Set platform-specific permissions if needed
      if (options.permissions) {
        await this.adapter.setFilePermissions(dirPath, options.permissions);
      }
      
      this.logger.info(`📁 Created directory: ${dirPath}`);
      
      return {
        success: true,
        path: dirPath,
        platform: this.adapter.getPlatform()
      };
    } catch (error) {
      this.logger.error(`❌ Failed to create directory ${dirPath}: ${error.message}`);
      return {
        success: false,
        error: error.message,
        path: dirPath
      };
    }
  }

  /**
   * Remove a file or directory with platform-specific handling
   * @param {string} targetPath - Path to remove
   * @param {Object} [options={}] - Removal options
   * @returns {Promise<Object>} Removal result
   */
  async removePath(targetPath, options = {}) {
    try {
      const { recursive = false, force = false } = options;
      
      try {
        await fsPromises.access(targetPath);
      } catch {
        return {
          success: true,
          path: targetPath,
          existed: false
        };
      }
      
      const stats = await fsPromises.stat(targetPath);
      
      if (stats.isDirectory()) {
        if (recursive) {
          await fsPromises.rm(targetPath, { recursive: true, force });
        } else {
          await fsPromises.rmdir(targetPath);
        }
      } else {
        await fsPromises.unlink(targetPath);
      }
      
      this.logger.info(`🗑️ Removed ${stats.isDirectory() ? 'directory' : 'file'}: ${targetPath}`);
      
      return {
        success: true,
        path: targetPath,
        existed: true,
        wasDirectory: stats.isDirectory()
      };
    } catch (error) {
      this.logger.error(`❌ Failed to remove ${targetPath}: ${error.message}`);
      return {
        success: false,
        error: error.message,
        path: targetPath
      };
    }
  }

  /**
   * Copy a file or directory with platform-specific handling
   * @param {string} sourcePath - Source path
   * @param {string} targetPath - Target path
   * @param {Object} [options={}] - Copy options
   * @returns {Promise<Object>} Copy result
   */
  async copyPath(sourcePath, targetPath, options = {}) {
    try {
      try {
        await fsPromises.access(sourcePath);
      } catch {
        throw new Error(`Source path does not exist: ${sourcePath}`);
      }
      
      const stats = await fsPromises.stat(sourcePath);
      
      if (stats.isDirectory()) {
        // Copy directory recursively
        await this.copyDirectory(sourcePath, targetPath, options);
      } else {
        // Copy file
        await fsPromises.copyFile(sourcePath, targetPath);
      }
      
      // Set platform-specific permissions if needed
      if (options.preservePermissions) {
        const permissions = await this.adapter.getFilePermissions(sourcePath);
        await this.adapter.setFilePermissions(targetPath, permissions);
      }
      
      this.logger.info(`📋 Copied ${stats.isDirectory() ? 'directory' : 'file'}: ${sourcePath} → ${targetPath}`);
      
      return {
        success: true,
        sourcePath,
        targetPath,
        wasDirectory: stats.isDirectory()
      };
    } catch (error) {
      this.logger.error(`❌ Failed to copy ${sourcePath} to ${targetPath}: ${error.message}`);
      return {
        success: false,
        error: error.message,
        sourcePath,
        targetPath
      };
    }
  }

  /**
   * Copy directory recursively
   * @private
   * @param {string} sourceDir - Source directory
   * @param {string} targetDir - Target directory
   * @param {Object} options - Copy options
   */
  async copyDirectory(sourceDir, targetDir, options = {}) {
    try {
      await fsPromises.access(targetDir);
    } catch {
      await fsPromises.mkdir(targetDir, { recursive: true });
    }
    
    const entries = await fsPromises.readdir(sourceDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      
      if (entry.isDirectory()) {
        await this.copyDirectory(sourcePath, targetPath, options);
      } else {
        await fsPromises.copyFile(sourcePath, targetPath);
        
        if (options.preservePermissions) {
          const permissions = await this.adapter.getFilePermissions(sourcePath);
          await this.adapter.setFilePermissions(targetPath, permissions);
        }
      }
    }
  }

  /**
   * Get environment variable with platform-specific fallbacks
   * @param {string} varName - Environment variable name
   * @param {string} [defaultValue] - Default value if not found
   * @returns {string|undefined} Environment variable value
   */
  getEnvironmentVariable(varName, defaultValue) {
    return this.adapter.getEnvironmentVariable(varName) || defaultValue;
  }

  /**
   * Set environment variable
   * @param {string} varName - Environment variable name
   * @param {string} value - Environment variable value
   * @returns {boolean} Success status
   */
  setEnvironmentVariable(varName, value) {
    return this.adapter.setEnvironmentVariable(varName, value);
  }

  /**
   * Get platform-specific temporary directory
   * @returns {string} Temporary directory path
   */
  getTempDirectory() {
    return this.adapter.getTempDirectory();
  }

  /**
   * Get platform-specific home directory
   * @returns {string} Home directory path
   */
  getHomeDirectory() {
    return this.adapter.getHomeDirectory();
  }

  /**
   * Get platform-specific app data directory
   * @returns {string} App data directory path
   */
  getAppDataDirectory() {
    return this.adapter.getAppDataDirectory();
  }

  /**
   * Validate platform adapter implementation
   * @returns {Object} Validation result
   */
  validateAdapter() {
    return PlatformAdapterFactory.validateAdapter(this.adapter);
  }
}

module.exports = {
  PlatformService
};