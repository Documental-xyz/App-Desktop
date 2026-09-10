/**
 * @fileoverview Async PID registry with on-disk persistence and orphan reaping.
 *   Replaces the sync `saveProcesses()`/`loadProcesses()` resume pattern in
 *   documentalTracker.js with a read-write-reap model: the same file concept,
 *   but orphans are killed on startup instead of being resumed.
 *   All filesystem access is async via `fs.promises` — `fs.*Sync` is forbidden
 *   in the Electron main process (see AGENTS.md).
 * @author Documental Team
 * @since 1.1.0
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');

/**
 * Lazy require of `killPidTree` (Task 1). Resolved on first reap so this
 * module can be `require()`d even before the helper exists — the contract is
 * only exercised at reap time.
 * @returns {(pid: number, gracePeriod?: number) => Promise<unknown>}
 */
function getKillPidTree() {
  // eslint-disable-next-line global-require
  const { killPidTree } = require('./killPidTree.js');
  return killPidTree;
}

/**
 * Resolve the live command identity of a pid via the platform inspector.
 * Prefers the full command line (`getCommandLine`); falls back to the
 * coarser `getProcessInfo().command`.
 * @param {Object} inspector - Platform process inspector
 * @param {number} pid
 * @returns {Promise<string|null>} Command identity or null when unavailable
 * @private
 */
async function resolveLiveCommand(inspector, pid) {
  if (typeof inspector.getCommandLine === 'function') {
    const cmdline = await inspector.getCommandLine(pid);
    if (cmdline && cmdline.trim()) {
      return cmdline.trim();
    }
  }
  if (typeof inspector.getProcessInfo === 'function') {
    const info = await inspector.getProcessInfo(pid);
    if (info && info.command && info.command !== 'N/A') {
      return String(info.command).trim();
    }
  }
  return null;
}

/**
 * Compare a registered command against a live process identity for the
 * PID-reuse guard. Matching is intentionally conservative: no identity
 * available → no match (don't kill).
 *
 * Match rules (normalized, case-insensitive):
 *   1. the whole registered command is a substring of the live identity
 *      (same argv, e.g. Linux /proc cmdline), or
 *   2. the registered executable's basename appears in the live identity
 *      AND at least one distinctive argument token (when any exist) does
 *      too — covers Windows where only the image name may be available.
 *
 * @param {string} registered - Command recorded at register() time
 * @param {string|null} live - Live process identity (cmdline/image name)
 * @returns {boolean}
 */
function commandIdentityMatches(registered, live) {
  if (!registered || !live) {
    return false;
  }
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const reg = norm(registered);
  const lv = norm(live);
  if (!reg || !lv) {
    return false;
  }
  if (lv.includes(reg)) {
    return true;
  }
  const tokens = reg.split(' ');
  const first = tokens[0];
  const base = first
    .slice(Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\')) + 1)
    .replace(/\.exe$/, '');
  if (!base || base.length < 3 || !lv.includes(base)) {
    return false;
  }
  const argTokens = tokens
    .slice(1)
    .filter((t) => t.length >= 3 && !t.startsWith('-') && !t.startsWith('/'));
  return argTokens.length === 0 || argTokens.some((t) => lv.includes(t));
}

/**
 * Async on-disk registry of live PIDs with orphan reaping.
 *
 * JSON schema (flat array, no version/migration):
 * ```
 * [{ "pid": 1234, "command": "npm start", "cwd": "/proj", "startedAt": 1700000000000, "parentPid": 1000 }]
 * ```
 *
 * @class
 */
class PIDRegistryFile {
  /**
   * @param {string} [filePath] - Absolute path to the registry JSON file.
   *   Defaults to `<userData>/documental-pids.json`.
   */
  constructor(filePath) {
    /** @type {string} */
    this.filePath = filePath || this._defaultPath();
  }

  /**
   * Resolve the default registry path under Electron's userData directory.
   * Falls back to the OS temp dir if the Electron `app` module is unavailable
   * (e.g. when unit-tested outside Electron).
   * @returns {string}
   * @private
   */
  _defaultPath() {
    try {
      // Lazily access electron — avoids a hard dependency at require() time.
      // eslint-disable-next-line global-require
      const { app } = require('electron');
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), 'documental-pids.json');
      }
    } catch {
      /* electron not available — fall through */
    }
    return path.join(require('os').tmpdir(), 'documental-pids.json');
  }

  /**
   * Read and parse the registry file.
   *
   * Resolves to `[]` for: missing file, unreadable file, invalid JSON, or any
   * non-array JSON. Never throws — corrupt state is treated as empty so the
   * app can boot and re-register fresh entries.
   *
   * @returns {Promise<Array<{pid: number, command: string, cwd: string, startedAt: number, parentPid: number}>>}
   */
  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed;
    } catch (error) {
      // ENOENT, EACCES, SyntaxError — all collapse to empty registry.
      return [];
    }
  }

  /**
   * Atomically persist the registry array to disk.
   *
   * Writes to `<filePath>.tmp` then renames over the target so a crash mid-write
   * cannot leave a truncated/corrupt registry file. Rename is atomic on POSIX
   * and on Windows when both paths are on the same volume (they are here).
   *
   * @param {Array<Object>} entries - Registry entries to persist.
   * @returns {Promise<void>}
   * @private
   */
  async _persist(entries) {
    const tmp = `${this.filePath}.tmp`;
    const data = JSON.stringify(entries, null, 2);
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, this.filePath);
  }

  /**
   * Register (or overwrite) an entry for `pid`.
   *
   * @param {number} pid - Live process ID.
   * @param {{command: string, cwd: string, startedAt?: number, parentPid?: number}} metadata -
   *   Descriptive metadata. `startedAt` defaults to now; `parentPid` defaults
   *   to the current process (the Documental Electron main process).
   * @returns {Promise<void>}
   */
  async register(pid, metadata = {}) {
    if (!pid || typeof pid !== 'number') {
      throw new Error(`register(): pid must be a number, got ${typeof pid}`);
    }

    const entries = await this.load();
    const idx = entries.findIndex((e) => e && e.pid === pid);
    const entry = {
      pid,
      command: metadata.command || '',
      cwd: metadata.cwd || '',
      startedAt: typeof metadata.startedAt === 'number' ? metadata.startedAt : Date.now(),
      parentPid: typeof metadata.parentPid === 'number' ? metadata.parentPid : process.pid
    };

    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }

    try {
      await this._persist(entries);
    } catch (error) {
      // Persistence failure must not crash registration; the in-memory entry
      // is moot here since this class is purely the on-disk view, but we
      // swallow to keep callers resilient. Next register/unregister retries.
    }
  }

  /**
   * Remove an entry for `pid`. Silently no-ops if the pid is not present or
   * the file is missing/corrupt.
   *
   * @param {number} pid - Process ID to remove.
   * @returns {Promise<void>}
   */
  async unregister(pid) {
    const entries = await this.load();
    const next = entries.filter((e) => e && e.pid !== pid);

    if (next.length === entries.length) {
      // Nothing to remove — avoid an unnecessary write.
      return;
    }

    try {
      await this._persist(next);
    } catch (error) {
      /* silent — see register() */
    }
  }

  /**
   * Reap orphaned processes: for each registered PID, if the PID is still
   * alive BUT its registered `parentPid` (the spawning Electron process) is
   * dead, the PID is an orphan and is killed via `killPidTree(pid)`. Reaped
   * entries are removed from the registry.
   *
   * Non-orphaned live entries and entries whose PID has already exited are
   * also removed from the registry (the latter is housekeeping: a dead PID
   * shouldn't linger on disk).
   *
   * @param {{processExists: (pid: number) => Promise<boolean>}} inspector -
   *   Platform process inspector (e.g. `ProcessInspectorFactory.getInspector()`).
   * @returns {Promise<{reaped: number[]}>} Array of PIDs that were killed.
   */
  async reapOrphans(inspector) {
    if (!inspector || typeof inspector.processExists !== 'function') {
      throw new Error('reapOrphans(): inspector with processExists(pid) is required');
    }

    const entries = await this.load();
    if (entries.length === 0) {
      return { reaped: [] };
    }

    const killPidTree = getKillPidTree();
    /** @type {number[]} */
    const reaped = [];
    /** @type {Array} */
    const survivors = [];

    // Inspect every entry; collect verdicts before mutating to keep the
    // reap deterministic even if processExists races.
    const verdicts = await Promise.all(
      entries.map(async (entry) => {
        if (!entry || typeof entry.pid !== 'number') {
          return { entry, action: 'drop' };
        }
        let pidAlive = false;
        let parentAlive = false;
        try {
          pidAlive = await inspector.processExists(entry.pid);
        } catch {
          pidAlive = false;
        }
        if (!pidAlive) {
          // PID already gone — just drop the entry.
          return { entry, action: 'drop' };
        }
        try {
          parentAlive = await inspector.processExists(entry.parentPid);
        } catch {
          parentAlive = false;
        }
        if (!parentAlive) {
          // PID-reuse guard: a live PID whose registered parent died may
          // have been recycled by the OS into an unrelated process. Only
          // reap when the live command identity still matches the
          // registered one. Inspectors without any identity capability
          // keep the legacy reap behavior.
          if (typeof inspector.getCommandLine === 'function' ||
              typeof inspector.getProcessInfo === 'function') {
            let liveCommand = null;
            try {
              liveCommand = await resolveLiveCommand(inspector, entry.pid);
            } catch {
              liveCommand = null;
            }
            if (!commandIdentityMatches(entry.command, liveCommand)) {
              console.warn(
                `reapOrphans: PID ${entry.pid} alive but command identity mismatch ` +
                `(registered "${entry.command}", live "${liveCommand}") — ` +
                `presumed PID reuse, dropping entry without killing`
              );
              return { entry, action: 'drop' };
            }
          }
          return { entry, action: 'reap' };
        }
        return { entry, action: 'keep' };
      })
    );

    for (const { entry, action } of verdicts) {
      if (action === 'keep') {
        survivors.push(entry);
        continue;
      }
      if (action === 'reap') {
        // Fast sync probe: PID may have died between verdict loop and here.
        try { process.kill(entry.pid, 0); } catch {
          // ESRCH — already dead, drop silently.
          continue;
        }
        try {
          await killPidTree(entry.pid);
          reaped.push(entry.pid);
        } catch (error) {
          // Kill failed — leave the entry in place so the next reap can retry.
          survivors.push(entry);
        }
        // On successful kill the entry is dropped (not pushed to survivors).
        continue;
      }
      // action === 'drop' (PID already dead / invalid entry): drop silently.
    }

    try {
      await this._persist(survivors);
    } catch (error) {
      /* silent — registry will be rewritten on next op */
    }

    return { reaped };
  }

  /**
   * Clear the entire registry — remove all entries from disk.
   * Used after a successful shutdown to signal that no PIDs need recovery
   * on the next launch.
   * @returns {Promise<void>}
   */
  async clear() {
    try {
      await this._persist([]);
    } catch (error) {
      /* silent — next register/unregister will overwrite */
    }
  }
}

module.exports = { PIDRegistryFile, commandIdentityMatches };
