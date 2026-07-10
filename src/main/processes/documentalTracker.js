/**
 * @fileoverview Process tracking and persistence for Documental processes
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ProcessInspectorFactory } = require('../platform/index.js');
const { killPidTree } = require('./killPidTree.js');
const { PIDRegistryFile } = require('./PIDRegistryFile.js');

/**
 * @typedef {Object} ProcessInfo
 * @property {number} pid - Process ID
 * @property {number} port - Port number the process is running on
 * @property {string} projectId - Associated project ID
 * @property {number} startTime - Process start timestamp
 * @property {string} command - Command that started the process
 * @property {string} cwd - Current working directory
 */

/**
 * @typedef {Object} DocumentalTrackerConfig
 * @property {string} processesFile - Path to the processes persistence file
 * @property {boolean} enablePersistence - Whether to persist processes to disk
 */

/**
 * Process tracker for Documental applications
 * @class
 */
class DocumentalTracker {
  /**
   * Creates an instance of DocumentalTracker
   * @param {DocumentalTrackerConfig} config - Tracker configuration
   * @example
   * const tracker = new DocumentalTracker({
   *   processesFile: '/path/to/processes.json',
   *   enablePersistence: true
   * });
   */
  constructor(config = {}) {
    this.config = {
      processesFile: path.join(process.cwd(), 'documental-processes.json'),
      enablePersistence: true,
      ...config
    };
    
    this.activeProcesses = {};
    /** @type {PIDRegistryFile} */
    this.pidRegistry = config.pidRegistry || new PIDRegistryFile();
    /** @type {Function|undefined} Optional injection for tests — defaults to killPidTree from require */
    this._killPidTree = config.killPidTree;
    this.loadProcesses();
  }

  /**
   * Load processes from persistence file
   * @returns {Object} Loaded processes
   */
  loadProcesses() {
    // DEPRECATED: replaced by PIDRegistryFile in perf-zombie-refactor.
    // No-op — stale PIDs from old sessions are handled by reapOrphans().
    this.activeProcesses = {};
    return {};
  }

  /**
   * Save processes to persistence file.
   * @returns {boolean} Success status
   */
  saveProcesses() {
    // DEPRECATED: replaced by killAllProcesses in perf-zombie-refactor.
    // Persistence removed to prevent zombie survival across sessions.
    return true;
  }

  /**
   * Add a process to tracking
   * @param {number} pid - Process ID
   * @param {ProcessInfo} processInfo - Process information
   * @returns {boolean} Success status
   * @example
   * tracker.addProcess(12345, {
   *   port: 3000,
   *   projectId: 'my-project',
   *   command: 'npm start',
   *   cwd: '/path/to/project'
   * });
   */
  addProcess(pid, processInfo) {
    if (!pid || !processInfo) {
      throw new Error('PID and processInfo are required');
    }

    this.activeProcesses[pid] = {
      pid,
      port: processInfo.port,
      projectId: processInfo.projectId,
      startTime: Date.now(),
      command: processInfo.command,
      cwd: processInfo.cwd
    };

    // Register in the async PID registry (orphan reaping on next boot).
    // Fire-and-forget: registration must not block the caller; failures are
    // swallowed inside PIDRegistryFile.
    this.pidRegistry.register(pid, {
      command: processInfo.command,
      cwd: processInfo.cwd,
      startedAt: this.activeProcesses[pid].startTime
    }).catch(() => { /* registry write best-effort */ });

    console.log(`➕ Added Documental process to tracking: PID ${pid}, Port ${processInfo.port}`);
    return true;
  }

  /**
   * Remove a process from tracking
   * @param {number} pid - Process ID to remove
   * @returns {boolean} Whether the process was found and removed
   */
  removeProcess(pid) {
    if (!this.activeProcesses[pid]) {
      return false;
    }

    delete this.activeProcesses[pid];

    // Remove from the async PID registry. Fire-and-forget — unregister is
    // best-effort and silently no-ops if the PID isn't present.
    this.pidRegistry.unregister(pid).catch(() => { /* registry write best-effort */ });

    console.log(`➖ Removed Documental process from tracking: PID ${pid}`);
    return true;
  }

  /**
   * Get process information by PID
   * @param {number} pid - Process ID
   * @returns {ProcessInfo|null} Process information or null if not found
   */
  getProcess(pid) {
    return this.activeProcesses[pid] || null;
  }

  /**
   * Get all active processes
   * @returns {Object} All active processes keyed by PID
   */
  getAllProcesses() {
    return { ...this.activeProcesses };
  }

  /**
   * Get processes by project ID
   * @param {string} projectId - Project ID to filter by
   * @returns {Object} Processes for the specified project
   */
  getProcessesByProject(projectId) {
    const projectProcesses = {};
    
    Object.entries(this.activeProcesses).forEach(([pid, process]) => {
      if (process.projectId === projectId) {
        projectProcesses[pid] = process;
      }
    });
    
    return projectProcesses;
  }

  /**
   * Get processes by port
   * @param {number} port - Port number to filter by
   * @returns {Object} Processes running on the specified port
   */
  getProcessesByPort(port) {
    const portProcesses = {};
    
    Object.entries(this.activeProcesses).forEach(([pid, process]) => {
      if (process.port === port) {
        portProcesses[pid] = process;
      }
    });
    
    return portProcesses;
  }

  /**
   * Check if a process is being tracked
   * @param {number} pid - Process ID to check
   * @returns {boolean} Whether the process is being tracked
   */
  hasProcess(pid) {
    return pid in this.activeProcesses;
  }

  /**
   * Get the count of active processes
   * @returns {number} Number of active processes
   */
  getProcessCount() {
    return Object.keys(this.activeProcesses).length;
  }

  /**
   * Clear all processes from tracking
   * @returns {boolean} Success status
   */
  clearAllProcesses() {
    this.activeProcesses = {};
    return this.saveProcesses();
  }

  /**
   * Clean up old processes (older than specified time)
   * @param {number} maxAge - Maximum age in milliseconds
   * @returns {number} Number of processes cleaned up
   */
  cleanupOldProcesses(maxAge = 24 * 60 * 60 * 1000) { // Default: 24 hours
    const now = Date.now();
    const toRemove = [];
    
    Object.entries(this.activeProcesses).forEach(([pid, process]) => {
      if (now - process.startTime > maxAge) {
        toRemove.push(pid);
      }
    });
    
    toRemove.forEach(pid => this.removeProcess(pid));
    
    return toRemove.length;
  }

  /**
   * Get tracker configuration
   * @returns {DocumentalTrackerConfig} Current configuration
   */
  getConfig() {
    return { ...this.config };
  }

  /**
   * Update tracker configuration
   * @param {Partial<DocumentalTrackerConfig>} newConfig - New configuration values
   * @returns {void}
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Validate if a tracked process is actually running
   * @param {number} pid - Process ID to validate
   * @returns {Promise<boolean>} Whether the process is actually running
   */
  async validateProcess(pid) {
    if (!this.hasProcess(pid)) {
      return false;
    }

    try {
      const inspector = ProcessInspectorFactory.getInspector();
      return await inspector.processExists(pid);
    } catch (error) {
      console.error(`Error validating process ${pid}:`, error);
      return false;
    }
  }

  /**
   * Get detailed information about a tracked process
   * @param {number} pid - Process ID to inspect
   * @returns {Promise<Object|null>} Combined tracked and system process info
   */
  async getProcessDetails(pid) {
    const trackedInfo = this.getProcess(pid);
    if (!trackedInfo) {
      return null;
    }

    try {
      const inspector = ProcessInspectorFactory.getInspector();
      const systemInfo = await inspector.getProcessInfo(pid);
      
      return {
        ...trackedInfo,
        systemInfo,
        isValid: systemInfo !== null
      };
    } catch (error) {
      console.error(`Error getting details for process ${pid}:`, error);
      return {
        ...trackedInfo,
        systemInfo: null,
        isValid: false
      };
    }
  }

  /**
   * Validate all tracked processes and remove dead ones
   * @returns {Promise<Object>} Validation results
   */
  async validateAllProcesses() {
    const results = {
      valid: [],
      invalid: [],
      errors: []
    };

    const pids = Object.keys(this.activeProcesses).map(pid => parseInt(pid, 10));
    
    for (const pid of pids) {
      try {
        const isValid = await this.validateProcess(pid);
        if (isValid) {
          results.valid.push(pid);
        } else {
          results.invalid.push(pid);
          // Remove dead process from tracking
          this.removeProcess(pid);
        }
      } catch (error) {
        results.errors.push({ pid, error: error.message });
      }
    }

    console.log(`🔍 Process validation: ${results.valid.length} valid, ${results.invalid.length} removed, ${results.errors.length} errors`);
    return results;
  }

  /**
   * Kill a tracked process
   * @param {number} pid - Process ID to kill
   * @returns {Promise<boolean>} Whether the process was killed successfully
   */
  async killProcess(pid) {
    if (!this.hasProcess(pid)) {
      return false;
    }

    try {
      const inspector = ProcessInspectorFactory.getInspector();
      const killed = await inspector.killProcess(pid);
      
      if (killed) {
        this.removeProcess(pid);
        console.log(`🔪 Killed Documental process: PID ${pid}`);
      }
      
      return killed;
    } catch (error) {
      console.error(`Error killing process ${pid}:`, error);
      return false;
    }
  }

  /**
   * Kill all tracked processes by sending SIGTERM (then SIGKILL) to each
   * process tree, then clear the in-memory registry. Errors per PID are
   * isolated so one unkillable PID doesn't prevent killing the others.
   * @param {Object} [inspector] - Optional platform inspector (unused; kept
   *   for API compatibility with future callers). killPidTree handles
   *   platform dispatch internally.
   * @returns {Promise<{killed: number[], failed: number[]}>}
   */
  async killAllProcesses(inspector) {
    const pids = Object.keys(this.activeProcesses).map((pid) => parseInt(pid, 10));
    const killed = [];
    const failed = [];

    // Use injected killPidTree (for testability) or fall back to the required one.
    const killFn = this._killPidTree || killPidTree;

    for (const pid of pids) {
      try {
        await killFn(pid, 1500);
        killed.push(pid);
      } catch (error) {
        console.error(`killAllProcesses: failed to kill PID ${pid}:`, error);
        failed.push(pid);
      }
    }

    this.activeProcesses = {};
    return { killed, failed };
  }

  /**
   * Get platform information
   * @returns {Object} Platform details
   */
  getPlatformInfo() {
    return {
      platform: ProcessInspectorFactory.getPlatformName(),
      isWindows: ProcessInspectorFactory.isWindows(),
      isUnix: ProcessInspectorFactory.isUnix(),
      isMacOS: ProcessInspectorFactory.isMacOS(),
      isLinux: ProcessInspectorFactory.isLinux()
    };
  }
}

// Create and export singleton instance
const appTracker = new DocumentalTracker();

module.exports = {
  DocumentalTracker,
  appTracker
};