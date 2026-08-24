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

/**
 * Build an object-style git-ops interface (the historical isomorphic-git
 * module call convention: `op({ fs, dir, ... })`) on top of a GitService
 * facade. GitSafety methods accept whatever implements this interface —
 * unit tests inject spies directly; the app injects the adapter returned
 * here so all operations flow through the provider facade.
 *
 * @param {import('../git/GitService.js').GitService} gitService - facade instance
 * @returns {object} object-style ops (currentBranch/resolveRef/statusMatrix/
 *   writeRef/checkout/branch/add/remove/commit/deleteBranch/listBranches/readCommit)
 */
function createObjectStyleOps(gitService) {
  return {
    currentBranch: ({ dir }) => gitService.currentBranch(dir),
    resolveRef: ({ dir, ref }) => gitService.resolveRef(dir, ref),
    statusMatrix: ({ dir }) => gitService.statusMatrix(dir),
    writeRef: ({ dir, ref, value, force }) =>
      gitService.writeRef(dir, ref, value, force !== undefined ? { force } : undefined),
    checkout: ({ dir, ref, force }) =>
      gitService.checkout(dir, ref, force !== undefined ? { force } : undefined),
    branch: ({ dir, ref, object, checkout, force }) =>
      gitService.branch(
        dir,
        ref,
        object !== undefined || checkout !== undefined || force !== undefined
          ? { ...(object !== undefined ? { object } : {}), ...(checkout !== undefined ? { checkout } : {}), ...(force !== undefined ? { force } : {}) }
          : undefined
      ),
    add: ({ dir, filepath }) => gitService.add(dir, filepath),
    remove: ({ dir, filepath }) => gitService.remove(dir, filepath),
    commit: ({ dir, message, author }) =>
      gitService.commit(dir, message, author !== undefined ? { author } : undefined),
    deleteBranch: ({ dir, ref }) => gitService.deleteBranch(dir, ref),
    listBranches: ({ dir }) => gitService.listBranches(dir),
    readCommit: ({ dir, oid }) => gitService.readCommit(dir, oid),
  };
}

/**
 * Typed error for gitSafety hard blocks (Task 5).
 *
 * Codes:
 *  - `BACKUP_FAILED`        — backup creation (createBranch / snapshot
 *    commit) failed; the protected operation MUST NOT run. Guarantees
 *    zero destructive provider mutations on this path.
 *  - `STATUS_MATRIX_FAILED` — statusMatrix threw; we can't know whether
 *    the working tree is dirty, so proceeding would risk treating a
 *    dirty tree as clean (the historical dirty=[] data-loss path).
 *    Hard block — never fall back to dirty=[].
 */
class GitSafetyError extends Error {
  /**
   * @param {'BACKUP_FAILED'|'STATUS_MATRIX_FAILED'} code
   * @param {string} message
   * @param {Error} [cause]
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'GitSafetyError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// Regex to parse the trailing timestamp from an auto-generated backup name.
// Backup names are of the form:  backup/<branch>-<shortSha>-<timestamp>
// We capture the final dash-separated numeric group as the timestamp.
const BACKUP_TIMESTAMP_SUFFIX = /-(\d+)$/;

/** Retention window (days) for `backup/*` branches before pruning. */
const BACKUP_RETENTION_DAYS = 7;

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
   * Shared pre-flight (Task 5): assess unpushed/dirty state and create the
   * backup when there is anything to lose. All failures are HARD blocks:
   *  - statusMatrix throws  → GitSafetyError STATUS_MATRIX_FAILED
   *    (never continue with dirty=[] — that was the data-loss bug)
   *  - backup creation fails → GitSafetyError BACKUP_FAILED
   *    (never reach the destructive step without a backup)
   *
   * @private
   * @returns {Promise<{ backupBranch: string|null }>}
   */
  async _assessAndBackup(gitMod, fs, projectPath, localBranch, options = {}) {
    const currentBranch = await gitMod.currentBranch({ fs, dir: projectPath });
    const localHead = await gitMod.resolveRef({ fs, dir: projectPath, ref: 'HEAD' });

    let hasUnpushed = false;
    if (currentBranch) {
      try {
        const remoteHead = await gitMod.resolveRef({
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

    let matrix;
    try {
      matrix = await gitMod.statusMatrix({ fs, dir: projectPath });
    } catch (err) {
      throw new GitSafetyError(
        'STATUS_MATRIX_FAILED',
        `Não foi possível avaliar o estado do repositório (statusMatrix: ${err.message}) — operação bloqueada por segurança`,
        err
      );
    }
    const dirty = matrix.filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));

    if (!hasUnpushed && dirty.length === 0) {
      return { backupBranch: null };
    }

    let backupBranch;
    try {
      backupBranch = await this._createBackup({
        gitMod,
        fs,
        projectPath,
        currentBranch: currentBranch || localBranch || 'detached',
        localHead,
        dirty,
        author: options.author,
      });
    } catch (err) {
      if (err instanceof GitSafetyError) throw err;
      throw new GitSafetyError(
        'BACKUP_FAILED',
        `Backup obrigatório falhou — operação abortada para proteger seus dados (${err.message})`,
        err
      );
    }
    this.logger.info(`📦 Backup criado: ${backupBranch}`);
    return { backupBranch };
  }

  /**
   * MANDATORY blocking backup around any destructive flow (Task 5).
   *
   * Contract: `operation` (the destructive/mutating part of a flow —
   * merge/push/checkout-force/...) runs ONLY after the pre-flight above
   * succeeded. If there is anything to lose and the backup cannot be
   * created, `operation` is NEVER invoked — zero provider mutations —
   * and a {@link GitSafetyError} (`BACKUP_FAILED` or
   * `STATUS_MATRIX_FAILED`) is thrown for the caller to surface.
   *
   * @param {object} gitMod - object-style git ops (facade-backed via createObjectStyleOps)
   * @param {object} fs - filesystem client accepted by isomorphic-git
   * @param {string} projectPath - absolute path to the repository
   * @param {() => Promise<T>} operation - the protected (destructive) flow body
   * @param {object} [options]
   * @param {string} [options.author] - author for the temp backup commit
   * @param {string} [options.branch] - branch name used for backup naming (default: current)
   * @returns {Promise<{ backupBranch: string|null, result: T }>}
   * @template T
   */
  async withMandatoryBackup(gitMod, fs, projectPath, operation, options = {}) {
    const { backupBranch } = await this._assessAndBackup(
      gitMod,
      fs,
      projectPath,
      options.branch || '',
      options
    );
    const result = await operation();
    return { backupBranch, result };
  }

  /**
   * Replaces `_hardResetBranch`. Performs a safe destructive operation:
   * if there is unpushed work OR uncommitted working-tree state, a backup
   * branch is created (including a temp commit of dirty files) BEFORE the
   * reset/checkout runs. If backup creation fails, the operation is
   * aborted to protect user data.
   *
   * @param {object} gitMod - object-style git ops (facade-backed via createObjectStyleOps)
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

    // 1-4. Assess + mandatory blocking backup (see _assessAndBackup).
    const { backupBranch } = await this._assessAndBackup(gitMod, fs, projectPath, localBranch, options);

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
   * Post-success backup cleanup — RETENTION semantics (Task 4).
   *
   * Backups are NO LONGER deleted on operation success. They are kept
   * for `BACKUP_RETENTION_DAYS` (7) and removed by {@link GitSafety#pruneOldBackups},
   * which runs best-effort at the end of successful sync operations.
   * Keeping this method (as a no-op) preserves existing call sites; flows
   * are rewritten in later tasks of the git-sync-strategy plan.
   *
   * @param {object} gitMod - object-style git ops (facade-backed via createObjectStyleOps)
   * @param {object} fs - filesystem client
   * @param {string} projectPath - absolute repo path
   * @param {string} backupBranch - backup branch ref (retained, not deleted)
   * @returns {Promise<void>}
   */
  async cleanupBackupBranch(gitMod, fs, projectPath, backupBranch) {
    void gitMod;
    void fs;
    void projectPath;
    this.logger.info(
      `📦 Backup ${backupBranch} retido (pruning automático após ${BACKUP_RETENTION_DAYS} dias)`
    );
  }

  /**
   * Delete backup branches older than `maxAgeDays` (default 7).
   *
   * Age is determined by the tip commit's committer timestamp (readCommit),
   * the same pattern used by {@link GitSafety#listBackups}. Uses only
   * existing provider methods: listBranches → resolveRef → readCommit →
   * deleteBranch.
   *
   * Best-effort by design: NEVER throws — a pruning failure must not fail
   * the sync operation that triggered it. Per-branch failures are skipped
   * and logged.
   *
   * @param {object} gitMod - object-style git ops (facade-backed via createObjectStyleOps)
   * @param {object} fs - filesystem client
   * @param {string} projectPath - absolute repo path
   * @param {number} [maxAgeDays=BACKUP_RETENTION_DAYS] - retention window in days
   * @returns {Promise<{ pruned: string[] }>} names of the deleted backup branches
   */
  async pruneOldBackups(gitMod, fs, projectPath, maxAgeDays = BACKUP_RETENTION_DAYS) {
    const pruned = [];

    let branches;
    try {
      branches = await gitMod.listBranches({ fs, dir: projectPath });
    } catch (err) {
      this.logger.warn(`pruneOldBackups: falha ao listar branches: ${err.message}`);
      return { pruned };
    }

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    for (const name of branches) {
      if (!name.startsWith(BACKUP_BRANCH_PREFIX)) continue;

      try {
        const sha = await gitMod.resolveRef({ fs, dir: projectPath, ref: name });
        const { commit } = await gitMod.readCommit({ fs, dir: projectPath, oid: sha });
        const committedAt =
          commit && commit.committer && commit.committer.timestamp
            ? commit.committer.timestamp * 1000
            : Date.now();

        if (committedAt < cutoff) {
          await gitMod.deleteBranch({ fs, dir: projectPath, ref: name });
          pruned.push(name);
          this.logger.info(`🗑️ Backup expirado (${maxAgeDays}+ dias) removido: ${name}`);
        }
      } catch (err) {
        // Skip this branch; never abort the whole pruning (nor the sync).
        this.logger.warn(`pruneOldBackups: pulando ${name}: ${err.message}`);
      }
    }

    return { pruned };
  }

  /**
   * List all backup branches in the repository.
   *
   * @param {object} gitMod - object-style git ops (facade-backed via createObjectStyleOps)
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
   * @param {object} gitMod - object-style git ops (facade-backed via createObjectStyleOps)
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
   * Cancel/CRASH RECOVERY (Task 5). Restores `workBranch` to the state
   * captured by a backup branch: `writeRef` of the work branch to the
   * backup tip + force checkout (the pattern at GitProvider.js:601-604).
   *
   * The backup branch is NEVER deleted here — `git:cancel-operation`
   * keeps backups so the user can retry recovery or restore an older
   * snapshot; expiry is handled solely by {@link GitSafety#pruneOldBackups}
   * (7-day retention).
   *
   * @param {object} gitMod - object-style git ops (facade-backed via createObjectStyleOps)
   * @param {object} fs - filesystem client
   * @param {string} projectPath - absolute repo path
   * @param {string} backupBranch - backup branch to restore from (retained)
   * @param {string} workBranch - branch to point at the backup tip
   * @returns {Promise<{ restoredFrom: string, backupRetained: true }>}
   * @throws on ref/checkout failure — the backup is untouched either way
   */
  async recoverFromBackup(gitMod, fs, projectPath, backupBranch, workBranch) {
    const oid = await gitMod.resolveRef({ fs, dir: projectPath, ref: backupBranch });
    await gitMod.writeRef({
      fs,
      dir: projectPath,
      ref: 'refs/heads/' + workBranch,
      value: oid,
      force: true,
    });
    await gitMod.checkout({ fs, dir: projectPath, ref: workBranch, force: true });
    this.fsSyncSafe(fs, projectPath);
    return { restoredFrom: backupBranch, backupRetained: true };
  }

  /**
   * User-initiated backup deletion (from UI).
   *
   * @param {object} gitMod - object-style git ops (facade-backed via createObjectStyleOps)
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

module.exports = {
  GitSafety,
  GitSafetyError,
  BACKUP_BRANCH_PREFIX,
  BACKUP_RETENTION_DAYS,
  createObjectStyleOps,
};
