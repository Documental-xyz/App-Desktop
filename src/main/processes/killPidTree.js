/**
 * @fileoverview Kill a process and all its descendants (process tree).
 * Uses process group kill on Unix (negative PID → SIGTERM → grace → SIGKILL)
 * and taskkill /T /F on Windows. Wraps tree-kill for the actual tree enumeration
 * on Unix, but uses direct process.kill for the group kill strategy.
 * @author Thiago Paixao
 * @since 1.0.0
 */

'use strict';

const { execFile } = require('child_process');
const treeKill = require('tree-kill');

/**
 * Kill a process tree by PID.
 *
 * On Unix: sends SIGTERM to the process group, waits `gracePeriod` ms,
 * then sends SIGKILL if the process still exists. Swallows ESRCH (already dead).
 * Logs a warning on EPERM (no permission) but does not throw.
 *
 * On Windows: uses `taskkill /pid <pid> /T /F` via execFile (immediate force kill,
 * no graceful period — OS limitation).
 *
 * @param {number} pid - Process ID to kill (root of the tree)
 * @param {number} [gracePeriod=1500] - Milliseconds to wait between SIGTERM and SIGKILL (Unix only)
 * @returns {Promise<void>} Resolves when the process tree has been killed
 */
async function killPidTree(pid, gracePeriod = 1500) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`killPidTree: invalid PID ${pid}`);
  }

  if (process.platform === 'win32') {
    return killWindows(pid);
  }

  return killUnix(pid, gracePeriod);
}

/**
 * Kill process tree on Windows using taskkill /T /F.
 * @param {number} pid
 * @returns {Promise<void>}
 */
function killWindows(pid) {
  return new Promise((resolve, reject) => {
    // NOTE: tree-kill's internal exec('taskkill') is intentionally NOT reached
    // on win32 — killPidTree branches to this execFile first, so tree-kill
    // itself stays unpatched. `windowsHide: true` suppresses the console-window
    // flash that taskkill would otherwise cause on Windows (no-op elsewhere).
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // taskkill exits non-zero when the process is already dead
        // Treat this as success — the goal is "process is gone"
        if (/not found|no running|does not exist/i.test(stderr || error.message)) {
          resolve();
          return;
        }
        // Log EPERM-like errors but don't throw
        console.warn(`killPidTree: taskkill failed for PID ${pid}: ${error.message}`);
        resolve();
        return;
      }
      resolve();
    });
  });
}

/**
 * Kill process tree on Unix using process group kill.
 *
 * Strategy:
 * 1. Send SIGTERM to the process group (-pid)
 * 2. Wait gracePeriod ms
 * 3. Check if process still exists via process.kill(pid, 0)
 * 4. If alive, send SIGKILL to the process group (-pid)
 *
 * @param {number} pid
 * @param {number} gracePeriod
 * @returns {Promise<void>}
 */
async function killUnix(pid, gracePeriod) {
  // Step 1: SIGTERM to process group
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Process group already dead — nothing to do
      return;
    }
    if (err.code === 'EPERM') {
      console.warn(`killPidTree: EPERM sending SIGTERM to process group -${pid}`);
      // Fall through to try SIGKILL anyway
    } else {
      console.warn(`killPidTree: unexpected error sending SIGTERM to -${pid}: ${err.message}`);
    }
  }

  // Step 2: Wait grace period
  await new Promise((resolve) => setTimeout(resolve, gracePeriod));

  // Step 3: Check if process still exists
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Process is dead — success
      return;
    }
    // EPERM on the check means the process exists but we can't signal it
    // Treat as alive and try SIGKILL
    alive = true;
  }

  if (!alive) {
    return;
  }

  // Step 4: SIGKILL to process group
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Died between check and kill — fine
      return;
    }
    if (err.code === 'EPERM') {
      console.warn(`killPidTree: EPERM sending SIGKILL to process group -${pid}`);
      return;
    }
    console.warn(`killPidTree: error sending SIGKILL to -${pid}: ${err.message}`);
  }
}

module.exports = { killPidTree };