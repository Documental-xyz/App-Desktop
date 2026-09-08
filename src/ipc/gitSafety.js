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

const path = require('path');
const {
  BACKUP_BRANCH_PREFIX,
  LOCK_HEARTBEAT_INTERVAL_MS,
  LOCK_HEARTBEAT_STALE_MS,
} = require('./gitFlowTypes.js');

/**
 * Build an object-style git-ops interface (the historical object-style
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

// ─── Auto-restore decision matrix (Task 7, publish-update-resilience) ─────────

/**
 * PURE decision function: given the failure context of a git flow, decide
 * whether the engine must restore the repository to its pre-operation
 * state, verify the remote first, or leave it untouched.
 *
 * MATRIX (first matching row wins):
 *
 * | Failure context                                             | Action                |
 * |-------------------------------------------------------------|-----------------------|
 * | CONFLICT_PENDING (conflictPending flag or typed code)       | NO — NEVER (the state |
 * |                                                             | is resolvable; restore|
 * |                                                             | would destroy the    |
 * |                                                             | pending user decision)|
 * | Failure BEFORE the first mutating command (preflight /      | NO (nothing changed)  |
 * | BACKUP_FAILED / STATUS_MATRIX_FAILED hard blocks)           |                       |
 * | Push REJECTED (PUSH_REJECTED / PUSH_FORBIDDEN typed codes,  | RESTORE (nothing      |
 * | or large_file error class) — definitively did not land      | landed)               |
 * | Push UNCERTAIN outcome (timeout / network / unknown class   | VERIFY_THEN_RESTORE   |
 * | or user cancel WHILE the push had started) — ls-remote      | (restore ONLY when    |
 * | decides: remote contains the attempted commit → keep state  | the remote does NOT   |
 * | and report partial success                                  | contain the push)     |
 * | Auth failure (post-mutations: the WIP commit already ran)   | RESTORE               |
 * | Cancel AFTER a successful push (finalizing stage)           | NO (work already      |
 * |                                                             | published)            |
 * | Any other post-mutation failure/cancel (local commit /      | RESTORE (local        |
 * | checkout / merge / branch mutation failed, fetch-stage      | mutation failed or   |
 * | network/auth, cancel post-merge pre-push)                   | cancelled mid-flow)   |
 *
 * `failureClass` values are the T5 classifyError classes
 * ('large_file'|'auth'|'timeout'|'network'|'conflict'|'unknown') plus the
 * pseudo-class 'cancel' for user/timeout aborts (cancelled results are
 * never enriched, so they carry no errorClass).
 *
 * @param {{failureClass?: string, stage?: string|null, code?: string, conflictPending?: boolean, cancelled?: boolean}} failureContext
 * @returns {{action: 'RESTORE'|'VERIFY_THEN_RESTORE'|'NO', reason: string}}
 */
function shouldRestore(failureContext) {
  const ctx = failureContext || {};
  const failureClass = ctx.failureClass || 'unknown';
  const stage = ctx.stage || null;
  const code = ctx.code || null;

  // Row 5 — CONFLICT_PENDING: NEVER restore (a resolvable state and a
  // live resumeToken exist; restoring would destroy the user's decision).
  if (ctx.conflictPending || code === 'CONFLICT_PENDING') {
    return {
      action: 'NO',
      reason: 'CONFLICT_PENDING — estado resolvível: o usuário possui uma decisão pendente (resumeToken válido) e o restore destruiria essa decisão.',
    };
  }

  // Row 6 — failure BEFORE the first mutating command: nothing changed.
  // BACKUP_FAILED / STATUS_MATRIX_FAILED are the Task-5 hard blocks raised
  // BEFORE the protected operation runs (zero provider mutations); the
  // 'preflight' stage covers read-only pre-lock validation failures.
  if (code === 'BACKUP_FAILED' || code === 'STATUS_MATRIX_FAILED' || stage === 'preflight') {
    return {
      action: 'NO',
      reason: 'Falha ANTES do primeiro comando mutante (preflight/status/backup) — nada mudou no repositório.',
    };
  }

  // Push-stage rows: the push was started, landing is the question.
  if (stage === 'pushing') {
    if (code === 'PUSH_REJECTED' || code === 'PUSH_FORBIDDEN' || failureClass === 'large_file') {
      return {
        action: 'RESTORE',
        reason: 'Push rejeitado pelo remoto (nada foi publicado) — devolver o repositório ao estado original.',
      };
    }
    if (failureClass === 'timeout' || failureClass === 'network' || failureClass === 'unknown' || failureClass === 'cancel') {
      return {
        action: 'VERIFY_THEN_RESTORE',
        reason: 'Resultado do push incerto (timeout/rede/cancel durante o push) — verificar o remoto (ls-remote) e restaurar SOMENTE se o push não chegou.',
      };
    }
    // auth / conflict / anything else at push: the server refused before
    // landing anything — deterministic RESTORE.
    return {
      action: 'RESTORE',
      reason: `Falha ${failureClass} durante o push — nada foi publicado; devolver o repositório ao estado original.`,
    };
  }

  // Cancel AFTER a successful push (finalizing stage): the work is already
  // on the remote — restoring would desync local from a landed remote.
  if (ctx.cancelled && stage === 'finalizing') {
    return {
      action: 'NO',
      reason: 'Cancelamento após o push bem-sucedido — o trabalho já foi publicado; nada a desfazer.',
    };
  }

  // All remaining post-mutation failures/cancels: local mutation failed
  // (commit/checkout/merge/branch), fetch-stage auth/network failure
  // (post-WIP), or a cancel with mutations applied (post-merge pre-push).
  if (failureClass === 'auth') {
    return {
      action: 'RESTORE',
      reason: 'Falha de autenticação após mutações locais (commit WIP) — devolver o repositório ao estado original.',
    };
  }
  if (ctx.cancelled) {
    return {
      action: 'RESTORE',
      reason: 'Cancelamento com mutações locais aplicadas — devolver o repositório ao estado original.',
    };
  }
  return {
    action: 'RESTORE',
    reason: `Mutação local falhou (${failureClass} em '${stage || 'preparing'}') — devolver o repositório ao estado original.`,
  };
}

/**
 * Remote-state verification for the VERIFY_THEN_RESTORE row (Task 7).
 * Consults the server via `git ls-remote` (read-only) and reports whether
 * the branch tip equals the commit the failed push ATTEMPTED to land.
 *
 * `remoteContains` is an EXACT tip match — a successor tip (our commit
 * plus someone else's) is conservatively reported as not-containing
 * (documented limitation: the successor OID is generally not available
 * locally for an ancestry check without an extra fetch).
 *
 * When ls-remote itself fails (network down), `verified: false` is
 * returned — the caller must KEEP the current state (never wrongly
 * revert a push that may have landed; nothing is lost either way: every
 * commit is local plus in a backup branch).
 *
 * Reused by the transient push retry (Task 8): it runs in the flow
 * wrappers AFTER `_pushWithTransientRetry` has exhausted its retries,
 * so this verification always sees the post-exhaustion remote state.
 *
 * @param {import('../git/GitService.js').GitService} git - GitService facade
 * @param {string} projectPath - absolute repo path (remote URL resolution)
 * @param {string} branch - branch the push targeted
 * @param {string|null} expectedOid - commit the push attempted to land
 * @param {{auth?: {token: string}, signal?: AbortSignal}} [opts]
 * @returns {Promise<{remoteContains: boolean, remoteOid: string|null, verified: boolean, error?: string}>}
 */
async function verifyRemoteState(git, projectPath, branch, expectedOid, opts = {}) {
  let url = null;
  try {
    url = await git.getConfig(projectPath, 'remote.origin.url');
  } catch (err) {
    return { remoteContains: false, remoteOid: null, verified: false, error: `remote.origin.url: ${err.message}` };
  }
  if (!url) {
    return { remoteContains: false, remoteOid: null, verified: false, error: 'remote.origin.url indisponível' };
  }
  try {
    const refs = await git.listServerRefs(url, {
      ...(opts.auth ? { auth: opts.auth } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const hit = (refs || []).find((r) => r && r.ref === `refs/heads/${branch}`);
    const remoteOid = hit ? hit.oid : null;
    return {
      remoteContains: Boolean(expectedOid) && remoteOid === expectedOid,
      remoteOid,
      verified: true,
    };
  } catch (err) {
    return { remoteContains: false, remoteOid: null, verified: false, error: err.message };
  }
}

/** Retention window (days) for `backup/*` branches before pruning. */
const BACKUP_RETENTION_DAYS = 7;

/**
 * Flow-context backup reuse window (Task 4, publish-main dedupe): a
 * `_safeResetToOrigin` running INSIDE the same withMandatoryBackup flow
 * may skip its own 2nd backup when the flow's backup is younger than
 * this and still covers the exact same state.
 * @type {number}
 */
const BACKUP_REUSE_WINDOW_MS = 5 * 60 * 1000;

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
   * Flow-context reuse (Task 4): `options.recentBackup` — `{ name,
   * branch, localHead, timestamp }` as returned in `backupInfo` by a
   * wrapping withMandatoryBackup — lets an INNER backup-guarded step
   * (publish-main's _safeResetToOrigin) skip creating a 2nd branch when
   * the flow's backup ALREADY covers the current state. Safety-first
   * conditions, ALL required:
   *   1. younger than BACKUP_REUSE_WINDOW_MS (5 min),
   *   2. same branch AND same localHead (no commits since — the backup
   *      tip covers every local commit),
   *   3. working tree CLEAN (a dirty tree always gets a fresh snapshot
   *      commit — the load-bearing Block 3 contract),
   *   4. the backup branch still EXISTS and still resolves to that
   *      localHead (not pruned/moved in between — verified live).
   * Any failure → a fresh backup is created exactly as before.
   *
   * @private
   * @returns {Promise<{ backupBranch: string|null, backupInfo: object|null, reusedBackup?: boolean }>}
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
      return { backupBranch: null, backupInfo: null };
    }

    const recent = options.recentBackup;
    if (
      recent &&
      typeof recent === 'object' &&
      dirty.length === 0 &&
      Date.now() - recent.timestamp < BACKUP_REUSE_WINDOW_MS &&
      recent.branch === currentBranch &&
      recent.localHead === localHead
    ) {
      try {
        const tip = await gitMod.resolveRef({ fs, dir: projectPath, ref: recent.name });
        if (tip === localHead) {
          this.logger.info(`♻️ Backup recente do fluxo reutilizado: ${recent.name}`);
          return { backupBranch: recent.name, backupInfo: null, reusedBackup: true };
        }
      } catch (_e) { /* backup gone/unresolvable — create a fresh one below */ }
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
    return {
      backupBranch,
      backupInfo: {
        name: backupBranch,
        branch: currentBranch,
        localHead,
        timestamp: Date.now(),
      },
    };
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
   * Task 4 (backup dedupe): when a backup was created, `operation` is
   * invoked with it as the argument — `{ name, branch, localHead,
   * timestamp }` (null when nothing needed backing up) — so inner
   * backup-guarded steps can forward it as `options.recentBackup` and
   * skip a redundant 2nd backup. Existing `() => ...` closures ignore
   * the argument. The same info is also returned as `backupInfo`.
   *
   * @param {object} gitMod - object-style git ops (facade-backed via createObjectStyleOps)
   * @param {object} fs - filesystem client (object-style interface convention)
   * @param {string} projectPath - absolute path to the repository
   * @param {(backupInfo: {name: string, branch: string, localHead: string, timestamp: number}|null) => Promise<T>} operation - the protected (destructive) flow body
   * @param {object} [options]
   * @param {string} [options.author] - author for the temp backup commit
   * @param {string} [options.branch] - branch name used for backup naming (default: current)
   * @returns {Promise<{ backupBranch: string|null, backupInfo: object|null, result: T }>}
   * @template T
   */
  async withMandatoryBackup(gitMod, fs, projectPath, operation, options = {}) {
    const { backupBranch, backupInfo } = await this._assessAndBackup(
      gitMod,
      fs,
      projectPath,
      options.branch || '',
      options
    );
    const result = await operation(backupInfo);
    return { backupBranch, backupInfo, result };
  }

  /**
   * Replaces `_hardResetBranch`. Performs a safe destructive operation:
   * if there is unpushed work OR uncommitted working-tree state, a backup
   * branch is created (including a temp commit of dirty files) BEFORE the
   * reset/checkout runs. If backup creation fails, the operation is
   * aborted to protect user data.
   *
   * `options.recentBackup` (Task 4, publish-main dedupe): flow context
   * from the wrapping withMandatoryBackup — when it still covers the
   * CURRENT state (< 5 min old, same branch, same HEAD, clean tree,
   * verified live), the 2nd backup branch is SKIPPED and the existing
   * one is reused. Any mismatch → fresh backup (safety first).
   *
   * @param {object} gitMod - object-style git ops (facade-backed via createObjectStyleOps)
   * @param {object} fs - filesystem client (object-style interface convention)
   * @param {string} projectPath - absolute path to the repository
   * @param {string} targetRef - ref to reset to (e.g. `'origin/preview'`)
   * @param {object} [options]
   * @param {string} [options.author] - Optional author for the temp backup commit
   * @param {{ name: string, branch: string, localHead: string, timestamp: number }} [options.recentBackup]
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
        // 100 (Task 4): large publishes were bounded by 10-file batches;
        // 100 keeps the argv-limit guard while cutting batch count 10×.
        const BATCH = 100;
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
          // the provider throws when there is nothing to commit (e.g. dirty
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

  // ─── Auto-restore engine (Task 7, publish-update-resilience) ─────────────────

  /**
   * Restore the repository to its pre-operation state after a flow
   * failure/cancel. Runs INSIDE the caller's git-lock scope (the wrappers
   * call it from their failure/cancel cleanup, before releaseGitLock —
   * never acquires the lock itself).
   *
   * Sequence (guardrailed):
   *  1. PRE-PROBE — cheap skip when the repo is already at the original
   *     state (branch + HEAD + clean tree + no merge in progress). This
   *     is the efficient path the plan requires: no backup, no checkout.
   *  2. SAFETY BACKUP of the CURRENT state FIRST (via _assessAndBackup —
   *     only created when there is anything to lose). On failure this
   *     ABORTS the restore (unlike restoreBackup's warn-and-continue):
   *     an unbacked-up destructive restore is exactly the historical
   *     data-loss bug. The pre-op backup branch is NEVER deleted here
   *     (RECOVERY CONTRACT — user-initiated delete or 7-day prune only).
   *  3. writeRef(originalBranch → pre-op backup tip) + checkout -f. The
   *     target is flowContext.preOpBackupName — the FIRST (flow) backup,
   *     never an intermediate _safeResetToOrigin backup. When no pre-op
   *     backup exists (clean+pushed state, backup was null) the recorded
   *     originalHead is the target — safe because step 2 already snapped
   *     the current state. A dead merge (MERGE_HEAD left by a killed
   *     merge) is cleared around the checkout: `checkout -f` is not
   *     guaranteed to clear merge metadata across providers.
   *     On checkout failure: PARTIAL — probe and report the exact state,
   *     never blind-retry (writeRef may have already moved the branch).
   *
   * @param {object} gitMod - object-style git ops (facade-backed via createObjectStyleOps)
   * @param {object} fs - filesystem client (node fs in production)
   * @param {string} projectPath - absolute repo path
   * @param {{projectId?: string|number|null, operationId?: string|null, preOpBackupName?: string|null,
   *          originalBranch?: string|null, originalHead?: string|null, author?: object}} flowContext
   * @returns {Promise<{restored: boolean|'PARTIAL', skipped?: string, aborted?: string,
   *                    journalHint?: string, safetyBackup?: string|null, restoredFrom?: string,
   *                    branch?: string, head?: string, details?: object, error?: string}>}
   */
  async autoRestoreFromBackup(gitMod, fs, projectPath, flowContext) {
    const fc = flowContext || {};
    const originalBranch = fc.originalBranch || null;
    const journalHint = fc.operationId || null;

    if (!originalBranch) {
      return { restored: false, aborted: 'NO_RESTORE_TARGET', journalHint };
    }

    // 1. Pre-probe: already at the original state → skip (cheap path).
    try {
      const branch = await gitMod.currentBranch({ fs, dir: projectPath });
      const head = await gitMod.resolveRef({ fs, dir: projectPath, ref: 'HEAD' });
      const mergeInProgress = GitSafety._mergeStateFileExists(fs, projectPath);
      if (!mergeInProgress && branch === originalBranch && head === fc.originalHead) {
        try {
          const matrix = await gitMod.statusMatrix({ fs, dir: projectPath });
          const dirty = matrix.filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));
          if (dirty.length === 0) {
            this.logger.info('♻️ Auto-restore pulado — repositório já está no estado original');
            return { restored: false, skipped: 'ALREADY_AT_ORIGINAL' };
          }
        } catch (_probeErr) { /* dirty unknown → proceed (safety first) */ }
      }
    } catch (_probeErr) { /* probe failed → proceed (safety first) */ }

    // 2. Safety-backup of the CURRENT state — ABORT on failure (guardrail).
    let safetyBackup = null;
    try {
      const assessment = await this._assessAndBackup(gitMod, fs, projectPath, originalBranch, {
        branch: originalBranch,
        ...(fc.author ? { author: fc.author } : {}),
      });
      safetyBackup = assessment.backupBranch;
    } catch (err) {
      this.logger.error(
        '❌ Auto-restore ABORTADO — falha ao criar o backup de segurança do estado atual:',
        err
      );
      return {
        restored: false,
        aborted: 'SAFETY_BACKUP_FAILED',
        journalHint,
        error: err && err.message,
      };
    }

    // 3. Resolve the restore target: the FIRST (flow) backup, else the
    //    recorded originalHead (safe — step 2 already snapped the state).
    let targetOid = null;
    let restoredFrom = null;
    if (fc.preOpBackupName) {
      try {
        targetOid = await gitMod.resolveRef({ fs, dir: projectPath, ref: fc.preOpBackupName });
        restoredFrom = fc.preOpBackupName;
      } catch (err) {
        this.logger.error('❌ Auto-restore ABORTADO — backup pré-op irresolvível:', err);
        return { restored: false, aborted: 'BACKUP_REF_UNRESOLVABLE', journalHint, error: err && err.message };
      }
    } else if (fc.originalHead) {
      targetOid = fc.originalHead;
      restoredFrom = 'originalHead';
    }
    if (!targetOid) {
      return { restored: false, aborted: 'NO_RESTORE_TARGET', journalHint };
    }

    GitSafety._clearMergeState(fs, projectPath);
    try {
      await gitMod.writeRef({
        fs,
        dir: projectPath,
        ref: 'refs/heads/' + originalBranch,
        value: targetOid,
        force: true,
      });
      await gitMod.checkout({ fs, dir: projectPath, ref: originalBranch, force: true });
    } catch (err) {
      const details = await GitSafety._probeRepoState(gitMod, fs, projectPath);
      this.logger.error('❌ Auto-restore PARCIAL — writeRef aplicado mas o checkout falhou:', err);
      return {
        restored: 'PARTIAL',
        details,
        safetyBackup,
        journalHint,
        error: err && err.message,
      };
    }
    GitSafety._clearMergeState(fs, projectPath);
    this.fsSyncSafe(fs, projectPath);

    this.logger.info(`♻️ Auto-restore concluído: ${originalBranch} → ${restoredFrom}`);
    return { restored: true, restoredFrom, safetyBackup, branch: originalBranch, head: targetOid };
  }

  /**
   * Whether a merge/cherry-pick state file exists (a killed merge may
   * leave MERGE_HEAD behind — the repo is NOT at a clean state even when
   * the branch/HEAD match the original).
   * @private
   * @param {object} fs
   * @param {string} projectPath
   * @returns {boolean}
   */
  static _mergeStateFileExists(fs, projectPath) {
    try {
      return typeof fs.existsSync === 'function'
        ? Boolean(fs.existsSync(path.join(projectPath, '.git', 'MERGE_HEAD')))
        : false;
    } catch (_e) {
      return false;
    }
  }

  /**
   * Remove stale merge/cherry-pick metadata (.git/MERGE_HEAD etc.) —
   * idempotent best-effort. `checkout -f` is not guaranteed to clear it
   * across providers, and a stale MERGE_HEAD makes every later command
   * behave as if a merge were in progress.
   * @private
   * @param {object} fs
   * @param {string} projectPath
   */
  static _clearMergeState(fs, projectPath) {
    for (const name of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'CHERRY_PICK_HEAD']) {
      try {
        if (typeof fs.rmSync === 'function') {
          fs.rmSync(path.join(projectPath, '.git', name), { force: true });
        }
      } catch (_e) { /* best-effort */ }
    }
  }

  /**
   * Exact-state probe (branch + HEAD + dirty file list) for PARTIAL
   * reporting. Fields become null when the probe itself fails.
   * @private
   * @param {object} gitMod
   * @param {object} fs
   * @param {string} projectPath
   * @returns {Promise<{branch: string|null, head: string|null, dirtyFiles: string[]|null, mergeInProgress: boolean}>}
   */
  static async _probeRepoState(gitMod, fs, projectPath) {
    const state = { branch: null, head: null, dirtyFiles: null, mergeInProgress: false };
    try { state.branch = await gitMod.currentBranch({ fs, dir: projectPath }); } catch (_e) { /* report null */ }
    try { state.head = await gitMod.resolveRef({ fs, dir: projectPath, ref: 'HEAD' }); } catch (_e) { /* report null */ }
    try {
      const matrix = await gitMod.statusMatrix({ fs, dir: projectPath });
      state.dirtyFiles = matrix
        .filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))
        .map(([filepath]) => filepath);
    } catch (_e) { /* report null */ }
    state.mergeInProgress = GitSafety._mergeStateFileExists(fs, projectPath);
    return state;
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
   * Force an immediate heartbeat renewal (cancel hardening, Task 6).
   * Called by GitHandlers right before each potentially long git command
   * (fetch deepen/push): refreshes the last-activity timestamp so a full
   * stale window (180s) opens from NOW, and restarts the interval so the
   * cadence phase realigns. No-op when the heartbeat is not running —
   * renewal outside a held lock must never resurrect a stopped heartbeat
   * (that would mask a dead holder from the NEXT acquire's stale check).
   */
  renewHeartbeat() {
    if (!this._heartbeatInterval || this._lastHeartbeat === null) {
      return;
    }
    this._lastHeartbeat = Date.now();
    clearInterval(this._heartbeatInterval);
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
  shouldRestore,
  verifyRemoteState,
};
