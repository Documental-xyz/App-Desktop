/**
 * @fileoverview Unix/Linux-specific process inspection utilities
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

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
 * Unix/Linux process inspector
 * @class
 */
class UnixProcessInspector {
  /**
   * Check if a process exists
   * @param {number} pid - Process ID to check
   * @returns {Promise<boolean>} Whether the process exists
   */
  static async processExists(pid) {
    return new Promise((resolve) => {
      // Try to read /proc/[pid]/status first (Linux specific)
      if (process.platform === 'linux') {
        try {
          const statusPath = `/proc/${pid}/status`;
          fs.access(statusPath, fs.constants.F_OK, (err) => {
            resolve(!err);
          });
          return;
        } catch (error) {
          // Fall back to ps command
        }
      }

      // Use ps command for Unix systems
      const ps = spawn('ps', ['-p', pid.toString()]);
      
      ps.on('close', (code) => {
        resolve(code === 0);
      });
      
      ps.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Get the full command line of a process (for PID identity checks).
   * @param {number} pid - Process ID
   * @returns {Promise<string|null>} Command line or null if unavailable
   */
  static async getCommandLine(pid) {
    return new Promise((resolve) => {
      const ps = spawn('ps', ['-p', pid.toString(), '-o', 'command=']);
      let output = '';
      ps.stdout.on('data', (data) => {
        output += data.toString();
      });
      ps.on('close', (code) => {
        resolve(code === 0 ? output.trim() || null : null);
      });
      ps.on('error', () => {
        resolve(null);
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
      // For Linux, try reading from /proc filesystem first
      if (process.platform === 'linux') {
        this.getLinuxProcessInfo(pid).then(resolve).catch(() => {
          this.getUnixProcessInfo(pid).then(resolve);
        });
        return;
      }

      // Use ps command for other Unix systems
      this.getUnixProcessInfo(pid).then(resolve);
    });
  }

  /**
   * Get process info from Linux /proc filesystem
   * @private
   * @param {number} pid - Process ID
   * @returns {Promise<ProcessInfo|null>} Process information
   */
  static async getLinuxProcessInfo(pid) {
    try {
      const procPath = `/proc/${pid}`;
      
      // Read status file
      const statusData = await fs.promises.readFile(`${procPath}/status`, 'utf8');
      const statusLines = statusData.split('\n');
      
      // Read cmdline file
      const cmdlineData = await fs.promises.readFile(`${procPath}/cmdline`, 'utf8');
      const command = cmdlineData.replace(/\0/g, ' ').trim() || 'N/A';
      
      // Read stat file for name
      const statData = await fs.promises.readFile(`${procPath}/stat`, 'utf8');
      const statParts = statData.split(' ');
      const name = statParts[1] ? statParts[1].replace(/[()]/g, '') : 'Unknown';
      
      // Parse status information
      let memory = 0;
      let status = 'Unknown';
      
      for (const line of statusLines) {
        if (line.startsWith('VmRSS:')) {
          const match = line.match(/(\d+)\s+kB/);
          if (match) memory = parseInt(match[1], 10);
        } else if (line.startsWith('State:')) {
          status = line.split('\t')[1] || 'Unknown';
        }
      }
      
      // Try to get working directory
      let cwd = 'N/A';
      try {
        const cwdLink = await fs.promises.readlink(`${procPath}/cwd`);
        cwd = cwdLink;
      } catch (error) {
        // Can't read cwd, keep default
      }
      
      const processInfo = {
        pid,
        name,
        command,
        memory,
        status,
        cwd
      };
      
      return processInfo;
    } catch (error) {
      throw new Error(`Failed to read /proc/${pid}: ${error.message}`);
    }
  }

  /**
   * Get process info using ps command (Unix fallback)
   * @private
   * @param {number} pid - Process ID
   * @returns {Promise<ProcessInfo|null>} Process information
   */
  static async getUnixProcessInfo(pid) {
    return new Promise((resolve) => {
      const ps = spawn('ps', ['-p', pid.toString(), '-o', 'pid,comm,command,rss,state,cwd']);
      let output = '';
      
      ps.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      ps.on('close', (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }

        try {
          const lines = output.split('\n').filter(line => line.trim());
          if (lines.length < 2) {
            resolve(null);
            return;
          }

          // Parse ps output (skip header)
          const data = lines[1].trim().split(/\s+/);
          
          const processInfo = {
            pid: parseInt(data[0], 10),
            name: data[1] || 'Unknown',
            command: data.slice(2, -3).join(' ') || 'N/A',
            memory: parseInt(data[data.length - 3], 10) || 0,
            status: data[data.length - 2] || 'Unknown',
            cwd: data[data.length - 1] || 'N/A'
          };
          
          resolve(processInfo);
        } catch (error) {
          console.error('Error parsing Unix process info:', error);
          resolve(null);
        }
      });
      
      ps.on('error', (error) => {
        console.error('Error executing ps:', error);
        resolve(null);
      });
    });
  }

  /**
   * Get all processes matching a name pattern
   * @param {string} namePattern - Process name pattern
   * @returns {Promise<ProcessInfo[]>} Array of matching processes
   */
  static async getProcessesByName(namePattern) {
    return new Promise((resolve) => {
      const ps = spawn('ps', ['-axo', 'pid,comm,command,rss,state,cwd']);
      let output = '';
      
      ps.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      ps.on('close', (code) => {
        if (code !== 0) {
          resolve([]);
          return;
        }

        try {
          const lines = output.split('\n').filter(line => line.trim());
          const processes = [];
          const regex = new RegExp(namePattern.replace(/\*/g, '.*'), 'i');
          
          // Skip header line
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            // Parse ps output
            const parts = line.split(/\s+/);
            if (parts.length < 6) continue;
            
            const name = parts[1];
            if (regex.test(name)) {
              processes.push({
                pid: parseInt(parts[0], 10),
                name: name,
                command: parts.slice(2, -3).join(' ') || 'N/A',
                memory: parseInt(parts[parts.length - 3], 10) || 0,
                status: parts[parts.length - 2] || 'Unknown',
                cwd: parts[parts.length - 1] || 'N/A'
              });
            }
          }
          
          resolve(processes);
        } catch (error) {
          console.error('Error parsing process list:', error);
          resolve([]);
        }
      });
      
      ps.on('error', () => {
        resolve([]);
      });
    });
  }

  /**
   * Kill a process
   * @param {number} pid - Process ID to kill
   * @returns {Promise<boolean>} Whether the process was killed successfully
   */
  static async killProcess(pid) {
    return new Promise((resolve) => {
      const kill = spawn('kill', ['-9', pid.toString()]);
      
      kill.on('close', (code) => {
        resolve(code === 0);
      });
      
      kill.on('error', () => {
        resolve(false);
      });
    });
  }
}

module.exports = {
  UnixProcessInspector
};