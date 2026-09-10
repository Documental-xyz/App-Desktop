/**
 * @fileoverview Kill a process and all its descendants (process tree).
 * Uses process group kill on Unix (negative PID → SIGTERM → grace → SIGKILL)
 * and taskkill /T /F on Windows. When the Unix group kill hits ESRCH but the
 * pid itself is alive (child not spawned detached → NOT a group leader;
 * validated empirically — see ajustes-wizard-preview-servicos Task 4), falls
 * back to enumerating descendants via `pgrep -P` and killing each pid
 * directly with the same two-phase escalation.
 * @author Thiago Paixao
 * @since 1.0.0
 */

'use strict';

const { execFile } = require('child_process');

/**
 * Probe whether a pid is alive (signal 0). EPERM counts as alive — the
 * process exists but is not signalable by us.
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/**
 * List the direct children of a pid via `pgrep -P <pid>`.
 * Resolves to [] when pgrep is missing or finds no children (exit 1).
 * @param {number} pid
 * @returns {Promise<number[]>}
 */
function listChildren(pid) {
  return new Promise((resolve) => {
    execFile('pgrep', ['-P', String(pid)], { windowsHide: true }, (error, stdout) => {
      if (error || typeof stdout !== 'string') {
        resolve([]);
        return;
      }
      const pids = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
      resolve(pids);
    });
  });
}

/**
 * Recursively enumerate all descendants of a pid (BFS over the ppid tree).
 * Cycle-safe via a visited set (kernel reparenting races can otherwise
 * loop).
 * @param {number} rootPid
 * @returns {Promise<number[]>} Descendant pids (excludes rootPid)
 */
async function listDescendants(rootPid) {
  const descendants = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = await listChildren(current);
    for (const child of children) {
      if (!seen.has(child)) {
        seen.add(child);
        descendants.push(child);
        queue.push(child);
      }
    }
  }
  return descendants;
}

/**
 * Kill a process tree by PID.
 *
 * On Unix: sends SIGTERM to the process group, waits `gracePeriod` ms,
 * then sends SIGKILL if the process still exists. If the group kill hits
 * ESRCH while the pid is still alive (non-detached child), falls back to
 * direct pid + enumerated descendant kill with the same two-phase
 * escalation. Swallows ESRCH (already dead). Logs a warning on EPERM
 * (no permission) but does not throw.
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
    // `windowsHide: true` suppresses the console-window flash that
    // taskkill would otherwise cause on Windows (no-op elsewhere).
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
 * 2. If that hits ESRCH and the pid itself is alive, the child was NOT
 *    spawned detached (not a group leader) — fall back to direct +
 *    enumerated descendant kill (killUnixFallback)
 * 3. Wait gracePeriod ms
 * 4. Check if process still exists via process.kill(pid, 0)
 * 5. If alive, send SIGKILL to the process group (-pid)
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
      // The process GROUP -pid does not exist. Either everything is
      // already dead, or the child was spawned non-detached (not a
      // group leader) — empirically validated: kill(-pid) then returns
      // ESRCH while the pid and its descendants stay alive. Probe the
      // pid directly and fall back to enumerated tree kill if needed.
      return killUnixFallback(pid, gracePeriod);
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

/**
 * Fallback for non-group-leader children: kill the pid directly plus every
 * enumerated descendant, two-phase (SIGTERM → grace → SIGKILL).
 *
 * @param {number} pid
 * @param {number} gracePeriod
 * @returns {Promise<void>}
 */
async function killUnixFallback(pid, gracePeriod) {
  // If the root pid is dead too, the group ESRCH really meant "all dead".
  if (!isAlive(pid)) {
    return;
  }

  const tree = [pid, ...(await listDescendants(pid))];

  // Phase 1: SIGTERM to every member of the tree.
  for (const member of tree) {
    try {
      process.kill(member, 'SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') {
        console.warn(`killPidTree: error sending SIGTERM to ${member}: ${err.message}`);
      }
    }
  }

  // Phase 2: grace period, then SIGKILL the survivors.
  await new Promise((resolve) => setTimeout(resolve, gracePeriod));

  for (const member of tree) {
    if (!isAlive(member)) {
      continue;
    }
    try {
      process.kill(member, 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') {
        console.warn(`killPidTree: error sending SIGKILL to ${member}: ${err.message}`);
      }
    }
  }
}

module.exports = { killPidTree };