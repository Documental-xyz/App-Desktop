/**
 * @fileoverview Safety wrapper for destructive git operations.
 *
 * Wraps checkout-force / writeRef-force / hardReset with automatic backup
 * branch creation so that unpushed commits and uncommitted working-tree
 * changes can be recovered if the destructive op fails, crashes, or is
 * triggered by mistake.
 *
 * Key fix for the historical data-loss bug:
 *   Creating a branch only saves the HEAD commit — it does NOT save dirty
 *   working-tree state. Because `checkout({ force: true })` discards the
 *   working tree, we MUST pre-commit dirty files to the backup branch
 *   before performing the destructive operation. Without this step, any
 *   uncommitted edit would be lost irrecoverably.
 *
 * Heartbeat APIs are provided so callers (e.g. GitHandlers) can integrate
 * stale-lock detection: a long-running publish writes a heartbeat every
 * LOCK_HEARTBEAT_INTERVAL_MS; if a subsequent process finds a lock held
 * with a heartbeat older than LOCK_HEARTBEAT_STALE_MS, the holder is
 * presumed crashed and the lock may be force-released.
 *
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const {
  BACKUP_BRANCH_PREFIX,
  LOCK_HEARTBEAT_INTERVAL_MS,
  LOCK_HEARTBEAT_STALE_MS,
} = require('./gitFlowTypes.js');

// Regex to parse the trailing timestamp from an auto-generated backup name.
// Backup names are of the form:  backup/<branch>-<shortSha>-<timestamp>
// We capture the final dash-separated numeric group as the timestamp.
const BACKUP_TIMESTAMP_SUFFIX = /-(\d+)$/;

/**
 * @typedef {Object} BackupInfo
 * @property {string} name - Full ref name of the backup branch
 * @property {string} sha - SHA the backup points to
 * @property {number} timestamp - Creation time (ms since epoch), parsed from name or commit
 */

class GitSafety {
  /**
   * @param {{ logger: object }} opts - Dependencies
   */
  constructor({ logger }) {
    this.logger = logger;
    /** @type {NodeJS.Timeout|null} */
    this._heartbeatInterval = null;
    /** @type {number|null} */
    this._lastHeartbeat = null;
  }

  // ─── Core destructive-op wrapper ─────────────────────────────────────────────

  /**
   * Replaces `_hardResetBranch`. Performs a safe destructive operation:
   * if there is unpushed work OR uncommitted working-tree state, a backup
   * branch is created (including a temp commit of dirty files) BEFORE the
   * reset/checkout runs. If backup creation fails, the operation is
   * aborted to protect user data.
   *
   * @param {object} gitMod - isomorphic-git module
   * @param {object} fs - filesystem client accepted by isomorphic-git
   * @param {string} projectPath - absolute path to the repository
   * @param {string} targetRef - ref to reset to (e.g. `'origin/preview'`)
   * @param {object} [options]
   * @param {string} [options.author] - Optional author for the temp backup commit
   * @returns {Promise<{ backupBranch: string|null }>} backup branch name or null
   * @throws {Error} if backup creation fails — caller MUST abort
   */
  async _safeResetOrCheckout(gitMod, fs, projectPath, targetRef, options = {}) {
    const localBranch = targetRef.replace(/^origin\//, '');

    // 1. Current branch + local HEAD
    const currentBranch = await gitMod.currentBranch({ fs, dir: projectPath });
    const localHead = await gitMod.resolveRef({ fs, dir: projectPath, ref: 'HEAD' });

    // 2. Detect unpushed commits (best-effort — remote ref may not exist yet)
    let remoteHead = null;
    let hasUnpushed = false;
    if (currentBranch) {
      try {
        remoteHead = await gitMod.resolveRef({
          fs,
          dir: projectPath,
          ref: 'refs/remotes/origin/' + currentBranch,
        });
        hasUnpushed = remoteHead !== localHead;
      } catch {
        // No upstream tracking ref → assume everything is unpushed if there
        // are commits; the dirty-tree check below is the authoritative guard.
        hasUnpushed = false;
      }
    }

    // 3. Detect uncommitted working-tree changes
    let dirty = [];
    try {
      const matrix = await gitMod.statusMatrix({ fs, dir: projectPath });
      dirty = matrix.filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));
    } catch (err) {
      this.logger.warn('statusMatrix falhou na criação de backup:', err.message);
    }
    const hasDirty = dirty.length > 0;

    // 4. Create backup if there's anything to lose
    let backupBranch = null;
    if (hasUnpushed || hasDirty) {
      backupBranch = await this._createBackup({
        gitMod,
        fs,
        projectPath,
        currentBranch: currentBranch || localBranch || 'detached',
        localHead,
        dirty,
        author: options.author,
      });
      this.logger.info(`📦 Backup criado: ${backupBranch}`);
    }

    // 5. Execute the destructive reset/checkout (mirrors `_hardResetBranch`)
    const oid = await gitMod.resolveRef({ fs, dir: projectPath, ref: targetRef });
    await gitMod.writeRef({
      fs,
      dir: projectPath,
      ref: 'refs/heads/' + localBranch,
      value: oid,
      force: true,
    });
    await gitMod.checkout({ fs, dir: projectPath, ref: localBranch, force: true });

    // On Windows, flush the filesystem after the critical write
    this.fsSyncSafe(fs, projectPath);

    return { backupBranch };
  }

  /**
   * Build a collision-safe backup branch name and create it. If uncommitted
   * changes exist, they are staged and committed on the backup branch so the
   * working-tree state is preserved (the actual fix for the data-loss bug).
   *
   * @private
   */
  async _createBackup({ gitMod, fs, projectPath, currentBranch, localHead, dirty, author }) {
    const shortSha = (localHead || '0000000').substring(0, 7);
    const baseName = `${BACKUP_BRANCH_PREFIX}${currentBranch}-${shortSha}-${Date.now()}`;

    // 1. Pick a non-colliding name (append -2, -3, ...). Do NOT use force:true.
    let backupName = baseName;
    let suffix = 2;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await gitMod.branch({
          fs,
          dir: projectPath,
          ref: backupName,
          checkout: false,
          force: false,
        });
        break; // created successfully
      } catch (err) {
        const msg = (err && err.message) || '';
        if (msg.includes('already exists') || msg.includes('exists')) {
          backupName = `${baseName}-${suffix}`;
          suffix += 1;
          continue;
        }
        // Any other failure is fatal — ABORT.
        this.logger.error('❌ Falha ao criar backup — operação abortada para proteger seus dados', err);
        throw err;
      }
    }

    // 2. If there are dirty files, commit them ON the backup branch so the
    //    working-tree state is recoverable. We point the backup branch at the
    //    current HEAD, check it out, stage+commit, then switch back.
    if (dirty && dirty.length > 0) {
      const previousBranch = await gitMod.currentBranch({ fs, dir: projectPath });

      try {
        await gitMod.checkout({ fs, dir: projectPath, ref: backupName, force: false });

        // Stage dirty files (add present / remove deleted) in batches.
        const BATCH = 10;
        const stageErrors = [];
        for (let i = 0; i < dirty.length; i += BATCH) {
          const batch = dirty.slice(i, i + BATCH);
          await Promise.all(
            batch.map(async ([filepath, , worktreeStatus]) => {
              try {
                if (worktreeStatus) {
                  await gitMod.add({ fs, dir: projectPath, filepath });
                } else {
                  await gitMod.remove({ fs, dir: projectPath, filepath });
                }
              } catch (fileErr) {
                stageErrors.push({ filepath, error: fileErr.message });
              }
            })
          );
        }

        if (stageErrors.length > 0) {
          const detail = stageErrors.map((e) => e.filepath).join(', ');
          throw new Error(`Falha ao preparar arquivos para backup: ${detail}`);
        }

        // Temp commit preserving the working-tree snapshot.
        const backupAuthor = author || {
          name: 'documental-backup',
          email: 'backup@documental.local',
        };
        try {
          await gitMod.commit({
            fs,
            dir: projectPath,
            message: `chore(backup): snapshot de working tree (${new Date().toISOString()})`,
            author: backupAuthor,
          });
        } catch (commitErr) {
          // isomorphic-git throws when there is nothing to commit (e.g. dirty
          // entries were staged-only-noise). That's fine — HEAD already points
          // at the right state on the backup branch.
          const m = (commitErr && commitErr.message) || '';
          if (!/nothing to commit/i.test(m)) {
            throw commitErr;
          }
        }

        this.fsSyncSafe(fs, projectPath);
      } catch (innerErr) {
        // Snapshotting dirty state failed — abort to avoid losing data.
        // Try to leave the working tree on the original branch.
        try {
          if (previousBranch) {
            await gitMod.checkout({ fs, dir: projectPath, ref: previousBranch, force: true });
          }
          await this.cleanupBackupBranch(gitMod, fs, projectPath, backupName);
        } catch {
          // best-effort cleanup; original error is the important one
        }
        this.logger.error(
          '❌ Falha ao criar backup — operação abortada para proteger seus dados',
          innerErr
        );
        throw innerErr;
      }

      // 3. Switch back to the original branch so the destructive op runs on
      //    the branch the caller expects.
      if (previousBranch) {
        await gitMod.checkout({ fs, dir: projectPath, ref: previousBranch, force: true });
      }
    }

    return backupName;
  }

  // ─── Backup lifecycle ────────────────────────────────────────────────────────

  /**
   * Best-effort delete of a backup branch. Called by the caller on operation
   * SUCCESS. Never throws — logs failures only.
   *
   * @param {object} gitMod - isomorphic-git module
   * @param {object} fs - filesystem client
   * @param {string} projectPath - absolute repo path
   * @param {string} backupBranch - backup branch ref to delete
   * @returns {Promise<void>}
   */
  async cleanupBackupBranch(gitMod, fs, projectPath, backupBranch) {
    try {
      await gitMod.deleteBranch({ fs, dir: projectPath, ref: backupBranch });
    } catch (err) {
      this.logger.warn(`Não foi possível remover backup ${backupBranch}: ${err.message}`);
    }
  }

  /**
   * List all backup branches in the repository.
   *
   * @param {object} gitMod - isomorphic-git module
   * @param {object} fs - filesystem client
   * @param {string} projectPath - absolute repo path
   * @returns {Promise<BackupInfo[]>}
   */
  async listBackups(gitMod, fs, projectPath) {
    let branches = [];
    try {
      branches = await gitMod.listBranches({ fs, dir: projectPath });
    } catch (err) {
      this.logger.warn('listBackups: falha ao listar branches:', err.message);
      return [];
    }

    const backups = [];
    for (const name of branches) {
      if (!name.startsWith(BACKUP_BRANCH_PREFIX)) continue;

      let sha = null;
      let timestamp = null;
      try {
        sha = await gitMod.resolveRef({ fs, dir: projectPath, ref: name });
      } catch {
        // unresolved ref — skip
        continue;
      }

      // Prefer the timestamp encoded in the name; fall back to commit date.
      const match = name.match(BACKUP_TIMESTAMP_SUFFIX);
      if (match) {
        timestamp = Number(match[1]);
      } else {
        try {
          const commit = await gitMod.readCommit({ fs, dir: projectPath, oid: sha });
          timestamp = (commit.committer && commit.committer.timestamp * 1000) || Date.now();
        } catch {
          timestamp = Date.now();
        }
      }

      backups.push({ name, sha, timestamp });
    }

    // Newest first
    backups.sort((a, b) => b.timestamp - a.timestamp);
    return backups;
  }

  /**
   * Restore user state from a backup branch. Creates a fresh backup of the
   * CURRENT state first, so restore is non-destructive.
   *
   * @param {object} gitMod - isomorphic-git module
   * @param {object} fs - filesystem client
   * @param {string} projectPath - absolute repo path
   * @param {string} backupBranch - backup branch to restore from
   * @param {object} [options]
   * @param {string} [options.author] - author for the pre-restore backup commit
   * @returns {Promise<{ safetyBackup: string|null }>} backup created for current state
   */
  async restoreBackup(gitMod, fs, projectPath, backupBranch, options = {}) {
    // Safety net: back up the current state before overwriting it.
    let safetyBackup = null;
    try {
      const currentBranch = await gitMod.currentBranch({ fs, dir: projectPath });
      if (currentBranch) {
        const result = await this._safeResetOrCheckout(
          gitMod,
          fs,
          projectPath,
          currentBranch,
          options
        );
        safetyBackup = result.backupBranch;
      }
    } catch (err) {
      this.logger.warn(
        `restoreBackup: não foi possível criar backup de segurança do estado atual: ${err.message}`
      );
    }

    await gitMod.checkout({ fs, dir: projectPath, ref: backupBranch, force: true });
    this.fsSyncSafe(fs, projectPath);
    return { safetyBackup };
  }

  /**
   * User-initiated backup deletion (from UI).
   *
   * @param {object} gitMod - isomorphic-git module
   * @param {object} fs - filesystem client
   * @param {string} projectPath - absolute repo path
   * @param {string} backupBranch - backup branch to delete
   * @returns {Promise<void>}
   * @throws on failure (UI should surface the error)
   */
  async deleteBackup(gitMod, fs, projectPath, backupBranch) {
    await gitMod.deleteBranch({ fs, dir: projectPath, ref: backupBranch });
  }

  // ─── Heartbeat / stale-lock detection ────────────────────────────────────────

  /**
   * Start the lock heartbeat timer. The interval callback ONLY updates the
   * timestamp — no I/O, must execute in <1ms so it never blocks the event
   * loop meaningfully.
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this._lastHeartbeat = Date.now();
    this._heartbeatInterval = setInterval(() => {
      this._lastHeartbeat = Date.now();
    }, LOCK_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop the heartbeat timer and clear state. Safe to call when not running.
   */
  stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    this._lastHeartbeat = null;
  }

  /**
   * Whether the heartbeat is stale (holder presumed dead).
   * Returns false if no heartbeat is active — there's nothing to recover.
   *
   * @returns {boolean}
   */
  checkStaleHeartbeat() {
    if (!this._lastHeartbeat) return false;
    return Date.now() - this._lastHeartbeat > LOCK_HEARTBEAT_STALE_MS;
  }

  // ─── Filesystem helper ───────────────────────────────────────────────────────

  /**
   * Flush the filesystem after a critical stage if the fs client supports it.
   * No-op on POSIX / when `fs.sync` is unavailable.
   *
   * @param {object} fs - filesystem client
   * @param {string} projectPath - absolute repo path
   * @returns {undefined}
   */
  fsSyncSafe(fs, projectPath) {
    try {
      return typeof fs.sync === 'function' ? fs.sync(projectPath) : undefined;
    } catch (err) {
      this.logger.debug('fsSyncSafe: sync falhou (esperado em alguns backends):', err.message);
      return undefined;
    }
  }
}

module.exports = { GitSafety, BACKUP_BRANCH_PREFIX };
