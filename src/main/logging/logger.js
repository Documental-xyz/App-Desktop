/**
 * @fileoverview Application logging system with buffer management and window broadcasting
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

let BrowserWindow;
try {
  const electron = require('electron');
  BrowserWindow = electron.BrowserWindow;
} catch (error) {
  // Fallback for testing environment
  BrowserWindow = {
    getAllWindows: () => []
  };
}

/**
 * @typedef {Object} LoggerConfig
 * @property {number} maxBufferSize - Maximum number of log entries to keep in memory
 * @property {boolean} enableConsoleOverride - Whether to override console methods
 * @property {boolean} enableWindowBroadcast - Whether to broadcast logs to all windows
 */

/**
 * Application logger with buffering and window broadcasting
 * @class
 */
class Logger {
  /**
   * Creates an instance of Logger
   * @param {LoggerConfig} config - Logger configuration
   * @example
   * const logger = new Logger({
   *   maxBufferSize: 10000,
   *   enableConsoleOverride: true,
   *   enableWindowBroadcast: true
   * });
   */
  constructor(config = {}) {
    this.config = {
      maxBufferSize: 10000,
      enableConsoleOverride: true,
      enableWindowBroadcast: true,
      ...config
    };
    
    this.logBuffer = [];
    // Debounce buffer for batched window broadcast
    this._broadcastBuffer = [];
    this._broadcastTimer = null;
    // Store references to the truly original console methods before any overrides
    this.trulyOriginalConsole = {
      log: console.log.bind(console),
      error: console.error.bind(console),
      warn: console.warn.bind(console),
      info: console.info.bind(console)
    };
    
    this.originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info
    };
    
    if (this.config.enableConsoleOverride) {
      this.overrideConsoleMethods();
    }
  }

  /**
   * Add log entry to buffer and optionally broadcast to windows
   * @param {string} level - Log level (info, warn, error, debug)
   * @param {...any} args - Arguments to log
   * @returns {void}
   */
  addToLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    
    const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
    this.logBuffer.push(logEntry);
    
    // Keep buffer size manageable
    if (this.logBuffer.length > this.config.maxBufferSize) {
      this.logBuffer = this.logBuffer.slice(-this.config.maxBufferSize);
    }
    
    // Broadcast to all windows if enabled
    if (this.config.enableWindowBroadcast) {
      this.broadcastToWindows(logEntry);
    }
    
    // Call original console method for info level
    if (level === 'info') {
      this.trulyOriginalConsole.log(...args);
    }
  }

  /**
   * Debounced broadcast: buffer entries and flush as a batch every 100ms.
   * @param {string} logEntry - Log entry to broadcast
   * @returns {void}
   */
  broadcastToWindows(logEntry) {
    this._broadcastBuffer.push(logEntry);
    if (!this._broadcastTimer) {
      this._broadcastTimer = setTimeout(() => this._flushBroadcast(), 100);
    }
  }

  /**
   * Flush the broadcast buffer immediately (sends all pending entries as a
   * single batch array). Used during shutdown to ensure no log is lost.
   * @returns {void}
   */
  flushNow() {
    if (this._broadcastTimer) {
      clearTimeout(this._broadcastTimer);
      this._broadcastTimer = null;
    }
    this._flushBroadcast();
  }

  /**
   * Internal: send the accumulated buffer as a batch array to all windows.
   * @private
   */
  _flushBroadcast() {
    this._broadcastTimer = null;
    const batch = this._broadcastBuffer.slice();
    this._broadcastBuffer = [];
    if (batch.length === 0) return;

    try {
      const allWindows = BrowserWindow.getAllWindows();
      allWindows.forEach(window => {
        if (!window.isDestroyed()) {
          window.webContents.send('app-log-output', batch);
        }
      });
    } catch (error) {
      this.originalConsole.error('Failed to broadcast log batch to windows:', error);
    }
  }

  /**
   * Override console methods to capture all logs
   * @returns {void}
   */
  overrideConsoleMethods() {
    console.log = (...args) => {
      this.addToLog('info', ...args);
      this.trulyOriginalConsole.log(...args);
    };
    console.error = (...args) => {
      this.addToLog('error', ...args);
      this.trulyOriginalConsole.error(...args);
    };
    console.warn = (...args) => {
      this.addToLog('warn', ...args);
      this.trulyOriginalConsole.warn(...args);
    };
    console.info = (...args) => {
      this.addToLog('info', ...args);
      this.trulyOriginalConsole.info(...args);
    };
  }

  /**
   * Restore original console methods
   * @returns {void}
   */
  restoreConsoleMethods() {
    // Flush any pending broadcast and stop the debounce timer
    this.flushNow();
    console.log = this.originalConsole.log;
    console.error = this.originalConsole.error;
    console.warn = this.originalConsole.warn;
    console.info = this.originalConsole.info;
  }

  /**
   * Get all buffered logs as string
   * @returns {string} All logs concatenated
   */
  getLogs() {
    return this.logBuffer.join('');
  }

  /**
   * Get logs filtered by level
   * @param {string} level - Log level to filter by
   * @returns {string} Filtered logs
   */
  getLogsByLevel(level) {
    const levelUpper = level.toUpperCase();
    return this.logBuffer
      .filter(entry => entry.includes(`[${levelUpper}]`))
      .join('');
  }

  /**
   * Clear the log buffer
   * @returns {void}
   */
  clearLogs() {
    this.logBuffer = [];
  }

  /**
   * Get current buffer size
   * @returns {number} Number of log entries in buffer
   */
  getBufferSize() {
    return this.logBuffer.length;
  }

  /**
   * Get logger configuration
   * @returns {LoggerConfig} Current logger configuration
   */
  getConfig() {
    return { ...this.config };
  }

  /**
   * Update logger configuration
   * @param {Partial<LoggerConfig>} newConfig - New configuration values
   * @returns {void}
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Log info message
   * @param {...any} args - Arguments to log
   * @returns {void}
   */
  info(...args) {
    this.addToLog('info', ...args);
    // Don't call console to avoid duplicates - just add to buffer
  }

  /**
   * Log error message
   * @param {...any} args - Arguments to log
   * @returns {void}
   */
  error(...args) {
    this.addToLog('error', ...args);
    // Don't call console to avoid duplicates - just add to buffer
  }

  /**
   * Log warning message
   * @param {...any} args - Arguments to log
   * @returns {void}
   */
  warn(...args) {
    this.addToLog('warn', ...args);
    // Don't call console to avoid duplicates - just add to buffer
  }

  /**
   * Log debug message
   * @param {...any} args - Arguments to log
   * @returns {void}
   */
  debug(...args) {
    this.addToLog('debug', ...args);
    // Don't call console to avoid duplicates - just add to buffer
  }
}

// Create and export singleton instance
const appLogger = new Logger();

/**
 * Get logger instance with specified context
 * @param {string} context - Logger context/name
 * @returns {Logger} Logger instance
 */
function getLogger(context = 'App') {
  return appLogger;
}

module.exports = {
  Logger,
  appLogger,
  getLogger
};