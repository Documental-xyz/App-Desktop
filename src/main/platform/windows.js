/**
 * @fileoverview Windows-specific process inspection utilities
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { spawn } = require('child_process');

/**
 * @typedef {Object} ProcessInfo
 * @property {number} pid - Process ID
 * @property {string} name - Process name
 * @property {string} command - Command line
 * @property {string} cwd - Current working directory (if available)
 * @property {number} memory - Memory usage in KB
 * @property {string} status - Process status
 */

/**
 * Windows process inspector
 * @class
 */
class WindowsProcessInspector {
  /**
   * Check if a process exists
   * @param {number} pid - Process ID to check
   * @returns {Promise<boolean>} Whether the process exists
   */
  static async processExists(pid) {
    return new Promise((resolve) => {
      const tasklist = spawn('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv'], { windowsHide: true });
      
      tasklist.stdout.on('data', (data) => {
        if (data.toString().includes('No tasks are running')) {
          resolve(false);
        }
      });
      
      tasklist.on('close', (code) => {
        resolve(code === 0);
      });
      
      tasklist.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Get detailed process information
   * @param {number} pid - Process ID to inspect
   * @returns {Promise<ProcessInfo|null>} Process information or null if not found
   */
  static async getProcessInfo(pid) {
    return new Promise((resolve) => {
      const tasklist = spawn('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/v'], { windowsHide: true });
      let output = '';
      
      tasklist.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      tasklist.on('close', (code) => {
        if (code !== 0 || output.includes('No tasks are running')) {
          resolve(null);
          return;
        }

        try {
          const lines = output.split('\n').filter(line => line.trim());
          if (lines.length < 2) {
            resolve(null);
            return;
          }

          // Parse CSV output (skip header)
          const data = lines[1];
          const fields = this.parseCsvLine(data);
          
          if (fields.length >= 8) {
            const processInfo = {
              pid: parseInt(fields[1], 10),
              name: fields[0].replace(/"/g, ''),
              command: fields[7] ? fields[7].replace(/"/g, '') : 'N/A',
              memory: this.parseMemory(fields[4]),
              status: fields[5] ? fields[5].replace(/"/g, '') : 'Unknown',
              cwd: 'N/A' // Windows doesn't easily provide CWD via tasklist
            };
            
            resolve(processInfo);
          } else {
            resolve(null);
          }
        } catch (error) {
          console.error('Error parsing Windows process info:', error);
          resolve(null);
        }
      });
      
      tasklist.on('error', (error) => {
        console.error('Error executing tasklist:', error);
        resolve(null);
      });
    });
  }

  /**
   * Get all processes matching a name pattern
   * @param {string} namePattern - Process name pattern (supports wildcards)
   * @returns {Promise<ProcessInfo[]>} Array of matching processes
   */
  static async getProcessesByName(namePattern) {
    return new Promise((resolve) => {
      const tasklist = spawn('tasklist', ['/fi', `IMAGENAME eq ${namePattern}`, '/fo', 'csv', '/v'], { windowsHide: true });
      let output = '';
      
      tasklist.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      tasklist.on('close', (code) => {
        if (code !== 0) {
          resolve([]);
          return;
        }

        try {
          const lines = output.split('\n').filter(line => line.trim());
          const processes = [];
          
          // Skip header line
          for (let i = 1; i < lines.length; i++) {
            const fields = this.parseCsvLine(lines[i]);
            if (fields.length >= 8) {
              processes.push({
                pid: parseInt(fields[1], 10),
                name: fields[0].replace(/"/g, ''),
                command: fields[7] ? fields[7].replace(/"/g, '') : 'N/A',
                memory: this.parseMemory(fields[4]),
                status: fields[5] ? fields[5].replace(/"/g, '') : 'Unknown',
                cwd: 'N/A'
              });
            }
          }
          
          resolve(processes);
        } catch (error) {
          console.error('Error parsing process list:', error);
          resolve([]);
        }
      });
      
      tasklist.on('error', () => {
        resolve([]);
      });
    });
  }

  /**
   * Parse a CSV line from tasklist output
   * @private
   * @param {string} line - CSV line to parse
   * @returns {string[]} Array of fields
   */
  static parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    
    fields.push(current);
    return fields;
  }

  /**
   * Parse memory string from tasklist output
   * @private
   * @param {string} memoryStr - Memory string (e.g., "1,234 K")
   * @returns {number} Memory in KB
   */
  static parseMemory(memoryStr) {
    if (!memoryStr) return 0;
    
    const clean = memoryStr.replace(/"/g, '').replace(/[,\sK]/g, '');
    const parsed = parseInt(clean, 10);
    return isNaN(parsed) ? 0 : parsed;
  }

  /**
   * Kill a process
   * @param {number} pid - Process ID to kill
   * @returns {Promise<boolean>} Whether the process was killed successfully
   */
  static async killProcess(pid) {
    return new Promise((resolve) => {
      const taskkill = spawn('taskkill', ['/pid', pid.toString(), '/f'], { windowsHide: true });
      
      taskkill.on('close', (code) => {
        resolve(code === 0);
      });
      
      taskkill.on('error', () => {
        resolve(false);
      });
    });
  }
}

module.exports = {
  WindowsProcessInspector
};