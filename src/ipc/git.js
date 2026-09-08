/**
 * @fileoverview IPC handlers for Git operations
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const { GitOperations } = require('./gitOperations.js');
const { GitService } = require('../git/GitService.js');
const { createGitProvider } = require('../git/GitProviderFactory.js');
const { enrichFailureResult } = require('./gitErrorMessages.js');

// Resilient import: fallback to 120s if gitFlowTypes.js is unavailable yet.
const {
  LOCK_TIMEOUT_MS: _IMPORTED_LOCK_TIMEOUT_MS,
  BRANCH_PREVIEW,
  BRANCH_MAIN,
  TEMP_PUBLISH_BRANCH,
  MAX_PUBLISH_RETRIES,
  STEP_TIMEOUT_FETCH_MS: _IMPORTED_STEP_TIMEOUT_FETCH_MS,
  STEP_TIMEOUT_MERGE_MS: _IMPORTED_STEP_TIMEOUT_MERGE_MS,
  STEP_TIMEOUT_PUSH_MS: _IMPORTED_STEP_TIMEOUT_PUSH_MS,
  STEP_TIMEOUT_CHECKOUT_MS: _IMPORTED_STEP_TIMEOUT_CHECKOUT_MS,
  STAGE_LISTS,
} = (() => {
  try {
    return require('./gitFlowTypes.js');
  } catch (_e) {
    return {
      LOCK_TIMEOUT_MS: 120000,
      BRANCH_PREVIEW: 'preview',
      BRANCH_MAIN: 'main',
      TEMP_PUBLISH_BRANCH: 'publish-preview',
      MAX_PUBLISH_RETRIES: 2,
      STEP_TIMEOUT_FETCH_MS: 30000,
      STEP_TIMEOUT_MERGE_MS: 45000,
      STEP_TIMEOUT_PUSH_MS: 60000,
      STEP_TIMEOUT_CHECKOUT_MS: 20000,
      // Mirror of gitFlowTypes.STAGE_LISTS (publish-update-resilience Task 2)
      STAGE_LISTS: {
        refresh: ['preparing', 'fetching', 'merging', 'finalizing'],
        'publish-preview': ['preparing', 'fetching', 'merging', 'pushing', 'finalizing'],
        'publish-main': ['preparing', 'fetching', 'merging', 'pushing', 'finalizing'],
      },
    };
  }
})();

// Resilient import: GitSafety wrapper for destructive ops (backup + recover).
const {
  GitSafety: _GitSafetyClass,
  createObjectStyleOps: _createObjectStyleOps,
  shouldRestore: _shouldRestore,
  verifyRemoteState: _verifyRemoteState,
} = (() => {
  try {
    return require('./gitSafety.js');
  } catch (_e) {
    return { GitSafety: null, createObjectStyleOps: null, shouldRestore: null, verifyRemoteState: null };
  }
})();

// Resilient import: T5 error classification — the transient push retry
// (Task 8) whitelists timeout|network and vetoes auth|large_file|conflict.
const { classifyError: _classifyError } = (() => {
  try {
    const mod = require('../git/GitError.js');
    return { classifyError: mod.classifyError || mod.GitError.classifyError || null };
  } catch (_e) {
    return { classifyError: null };
  }
})();

// Resilient import: GitPreflight for read-only pre-lock validation.
const { GitPreflight: _GitPreflightClass } = (() => {
  try {
    return require('./gitPreflight.js');
  } catch (_e) {
    return { GitPreflight: null };
  }
})();

// Resilient import: pre-merge conflict detection (conflict-strategy-modal Task 1).
const { detectMergeConflicts: _detectMergeConflicts } = (() => {
  try {
    return require('./gitConflictDetect.js');
  } catch (_e) {
    return { detectMergeConflicts: null };
  }
})();

// Resilient imports: per-operation raw output journal (publish-update-
// resilience Task 3). The journal is a pure singleton (no electron
// dependency); the DugiteProvider command observer is MODULE-level
// because GitProviderFactory constructs the provider without arguments.
const _operationJournalMod = (() => {
  try {
    return require('./operationJournal.js');
  } catch (_e) {
    return null;
  }
})();
const { setCommandObserver: _dugiteSetCommandObserver } = (() => {
  try {
    return require('../git/providers/DugiteProvider.js');
  } catch (_e) {
    return { setCommandObserver: null };
  }
})();

/**
 * Conflict-strategy roundtrip (conflict-strategy-modal Task 3).
 *
 * The 4 product strategies offered by the modal. Context mapping:
 *  - publish/refresh: OURS = the local working branch, THEIRS = origin
 *    (remote). MERGE_LOCAL = keep local conflicting hunks (por-hunk),
 *    MERGE_REMOTE = keep remote conflicting hunks (por-hunk), FULL_* =
 *    same winner, declared as the "total" product intention.
 *  - publish-main: OURS = main, THEIRS = preview (the side being
 *    promoted). MERGE_LOCAL keeps MAIN, MERGE_REMOTE keeps PREVIEW.
 *  - cross-branch publish (pushToBranch from another branch): the LOCAL
 *    commits are the THEIRS side of the merge — the mapping is flipped
 *    automatically (_conflictDriverFor).
 *
 * @readonly
 * @type {string[]}
 */
const CONFLICT_STRATEGIES = ['MERGE_LOCAL', 'MERGE_REMOTE', 'FULL_LOCAL', 'FULL_REMOTE'];

/** Validity window of a conflict resumeToken (15 minutes). */
const RESUME_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Extract the LAST git transfer percentage from fetch/push output lines
 * (stderr/sideband) like `Counting objects: 45% (9/20)` or
 * `remote: Writing objects:  67% (6/9), 1234 KiB | ...`. Used at the
 * git:progress emission points to report real transfer percentages.
 *
 * @param {string} text - Raw (possibly multi-line) git output
 * @returns {number|null} Last percentage found, or null
 */
function parseTransferPercentage(text) {
  if (typeof text !== 'string' || text === '') return null;
  const RE = /(?:counting|writing|compressing) objects:\s+(\d+)%/gi;
  let match = null;
  let last = null;
  while ((match = RE.exec(text)) !== null) {
    last = parseInt(match[1], 10);
  }
  return Number.isNaN(last) ? null : last;
}

/**
 * Typed error for git FLOW failures (Task 6). Mirrors the GitSafetyError
 * pattern (machine-readable `code` + user-facing message) so the renderer
 * can branch on it without parsing free-form strings.
 *
 * Codes:
 *  - `PUSH_REJECTED` — remote refused the push (non-fast-forward /
 *    shallow-related rejection). Payload message guides the user to
 *    "update first" (Atualizar) before publishing again. Nothing local
 *    was lost: the merge step already synced, and the mandatory backup
 *    branch is retained.
 *  - `NO_UPSTREAM` (Task 7) — `origin/preview` does not exist yet (new
 *    repo / first sync). Refresh cannot pull from a branch that was
 *    never published; the message guides the user to publish first.
 */
class GitFlowError extends Error {
  /**
   * @param {'PUSH_REJECTED'|'NO_UPSTREAM'} code
   * @param {string} message
   * @param {Error} [cause]
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'GitFlowError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * @typedef {Object} GitOperationResult
 * @property {boolean} success - Whether the operation succeeded
 * @property {string} [error] - Error message if operation failed
 * @property {*} [data] - Operation result data
 */

/**
 * @typedef {Object} BranchInfo
 * @property {string} name - Branch name
 * @property {boolean} isCurrent - Whether this is the current branch
 * @property {boolean} isRemote - Whether this is a remote branch
 */

/**
 * @typedef {Object} RepositoryInfo
 * @property {string} currentBranch - Current branch name
 * @property {Array<string>} branches - List of local branches
 * @property {Array<string>} remoteBranches - List of remote branches
 * @property {string|null} remoteUrl - Remote repository URL
 * @property {boolean} isClean - Whether working directory is clean
 * @property {string|null} status - Git status information
 */

/**
 * Git Operations IPC Handlers
 */
class GitHandlers {
  /**
   * Create an instance of GitHandlers
   * @param {Object} dependencies - Dependency injection container
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.databaseManager - Database manager instance
   * @param {Object} [dependencies.permissionHandlers] - Permission handler (for publish-main gating)
   * @param {Object} [dependencies.gitService] - GitService facade (provider-backed; defaults to a new one)
   */
  constructor({ logger, databaseManager, permissionHandlers, gitService }) {
    this.logger = logger;
    this.databaseManager = databaseManager;
    this.gitOps = new GitOperations({ logger, databaseManager });
    // No module loaders: loadGit/loadHttp existed only to feed the
    // legacy provider; the dugite provider takes no arguments.
    this.git = gitService || new GitService({ provider: createGitProvider() });
    this.permissionHandlers = permissionHandlers || null;
    this.gitOperationInProgress = false;
    this.LOCK_TIMEOUT_MS = _IMPORTED_LOCK_TIMEOUT_MS;
    this.STEP_TIMEOUT_FETCH_MS = _IMPORTED_STEP_TIMEOUT_FETCH_MS;
    this.STEP_TIMEOUT_MERGE_MS = _IMPORTED_STEP_TIMEOUT_MERGE_MS;
    this.STEP_TIMEOUT_PUSH_MS = _IMPORTED_STEP_TIMEOUT_PUSH_MS;
    this.STEP_TIMEOUT_CHECKOUT_MS = _IMPORTED_STEP_TIMEOUT_CHECKOUT_MS;
    // Task 8: transient push retry budget (2 retries → 3 attempts max).
    this.MAX_PUBLISH_RETRIES = MAX_PUBLISH_RETRIES;
    this._lockTimeout = null;
    this._abortController = null;
    this._gitCache = {};
    this._sendOutputBuffer = [];
    this._sendOutputTimer = null;
    this.cancelRequested = false;
    /**
     * In-memory registry of pending conflict decisions (Task 3).
     * Key: resumeToken (crypto-random hex). Value: flow resume context
     * + expiry. Never persisted — a forged/foreign token cannot exist.
     * @type {Map<string, object>}
     */
    this._pendingConflicts = new Map();
    this.gitSafety = _GitSafetyClass ? new _GitSafetyClass({ logger }) : null;
    this.gitPreflight = _GitPreflightClass
      ? new _GitPreflightClass({ logger, gitOps: this.gitOps, databaseManager })
      : null;
    // Task 3: wire the dugite command observer into the operation
    // journal. _run does not know the operationId — recordCommand(null,…)
    // inherits the CURRENT operation, set by _beginOperation under the
    // single git lock (see _beginOperation/_emitTerminal).
    this.operationJournal = _operationJournalMod
      ? (_operationJournalMod.journal || _operationJournalMod)
      : null;
    if (this.operationJournal && _dugiteSetCommandObserver) {
      _dugiteSetCommandObserver((entry) => this.operationJournal.recordCommand(null, entry));
    }
  }

  /**
   * Memoized object-style ops adapter over the GitService facade, consumed
   * by the legacy GitSafety object-style helpers (createObjectStyleOps).
   * @returns {object|null} adapter, or null when gitSafety.js failed to load
   */
  _safetyOps() {
    if (!this._safetyOpsCache) {
      this._safetyOpsCache = _createObjectStyleOps
        ? _createObjectStyleOps(this.git)
        : null;
    }
    return this._safetyOpsCache;
  }

  /**
   * The ONLY sanctioned path to a hard reset (Task 5): always through
   * GitSafety's backup-guarded `_safeResetOrCheckout`. The raw
   * `_hardResetBranch` fallback was removed — when GitSafety is
   * unavailable a destructive reset is REFUSED (fail-safe), never
   * degraded to an unguarded writeRef-force + checkout-force.
   * @param {string} projectPath - Absolute path to the git repository
   * @param {string} targetRef - Ref to reset to (e.g., `'origin/preview'`)
   * @param {object} [options] - forwarded to _safeResetOrCheckout ({ author })
   * @returns {Promise<{ backupBranch: string|null }>}
   */
  async _safeResetToOrigin(projectPath, targetRef, options) {
    const ops = this._safetyOps();
    if (!this.gitSafety || !ops) {
      throw new Error('GitSafety indisponível — reset destrutivo recusado (sem backup obrigatório)');
    }
    return this.gitSafety._safeResetOrCheckout(ops, require('fs'), projectPath, targetRef, options);
  }

  /**
   * Per-step observability helper. Awaits `promise` to completion but logs a
   * warning if it takes longer than `ms`. Local git ops cannot be truly
   * cancelled mid-flight — only observed.
   * for local operations, so we cannot truly cancel — only observe.
   * @template T
   * @param {Promise<T>} promise - Operation to await.
   * @param {number} ms - Soft-timeout threshold in milliseconds.
   * @param {string} label - Human-readable label for the warning message.
   * @returns {Promise<T>} The resolved value of `promise`.
   */
  async _raceTimeout(promise, ms, label) {
    const timer = setTimeout(() => {
      this.logger.warn(`⚠️ Etapa "${label}" excedeu ${ms}ms — aguardando conclusão...`);
    }, ms);
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Acquire the git operation lock
   * @returns {boolean} True if lock was acquired, false if already in progress
   */
  acquireGitLock() {
    // Stale-lock auto-recovery: if a previous process crashed mid-operation,
    // the in-process heartbeat is stale. Only recovers on NEXT acquire attempt
    // — never interrupts an active operation.
    if (this.gitOperationInProgress && this.gitSafety && this.gitSafety.checkStaleHeartbeat()) {
      this.logger.warn('🔒 Lock auto-recuperado de processo anterior (heartbeat stale)');
      this.gitOperationInProgress = false;
      if (this._lockTimeout) { clearTimeout(this._lockTimeout); this._lockTimeout = null; }
      this._abortController = null;
    }
    if (this.gitOperationInProgress) {
      this.logger.warn('Git operation already in progress');
      return false;
    }
    this.gitOperationInProgress = true;
    this.cancelRequested = false;
    this._abortController = new AbortController();
    this._lockTimeout = setTimeout(() => {
      this.logger.warn('Git operation auto-aborted after timeout');
      this._abortController.abort(new Error('Operation timeout'));
    }, this.LOCK_TIMEOUT_MS);
    if (this.gitSafety) {
      this.gitSafety.startHeartbeat();
    }
    this.logger.info('Git operation lock acquired');
    return true;
  }

  /**
   * Release the git operation lock
   */
  releaseGitLock() {
    if (this.gitSafety) {
      this.gitSafety.stopHeartbeat();
    }
    this._flushSendOutput();
    this.gitOperationInProgress = false;
    if (this._lockTimeout) {
      clearTimeout(this._lockTimeout);
      this._lockTimeout = null;
    }
    // Note: do NOT call _abortController.abort() here — the operation has
    // already completed (success or error). We only clear the reference.
    this._abortController = null;
    this.logger.info('Git operation lock released');
  }

  /**
   * Returns the AbortSignal for the current operation. Pass this to the provider's
   * fetch/pull/push calls so they can be cancelled by timeout or user request.
   * @returns {AbortSignal|null}
   */
  getAbortSignal() {
    return this._abortController ? this._abortController.signal : null;
  }

  /**
   * Request cancellation of the current Git operation
   * Sets the cancel flag that operations should check between steps
   */
  requestCancel() {
    this.cancelRequested = true;
    if (this._abortController) {
      this._abortController.abort(new Error('User requested cancel'));
    }
    this.logger.info('Git operation cancellation requested');
  }

  /**
   * Reset the cancellation flag
   * Should be called at the start of new operations
   */
  resetCancel() {
    this.cancelRequested = false;
    this.logger.debug('Git operation cancellation flag reset');
  }

  /**
   * Renew the lock heartbeat immediately (cancel hardening, Task 6).
   * Called right before each potentially long git command (fetch
   * deepen/push) so a fresh 180s stale window opens even if some future
   * change ever stops the interval from ticking mid-await. The 5s
   * interval itself keeps running during subprocess awaits (Node
   * timers fire while the event loop waits on a subprocess promise —
   * empirically proven in tests/ipc/git.cancel-hardening.test.js), so
   * this is defense-in-depth, not the primary mechanism.
   */
  _renewHeartbeat() {
    if (this.gitSafety && typeof this.gitSafety.renewHeartbeat === 'function') {
      this.gitSafety.renewHeartbeat();
    }
  }

  /**
   * Check if cancellation has been requested
   * @returns {boolean} True if cancellation was requested
   */
  isCancelRequested() {
    return this.cancelRequested;
  }

  /**
   * Broadcast a message to all renderer windows
   * @param {string} channel - IPC channel name
   * @param {*} payload - Payload to send
   */
  broadcastToWindows(channel, payload) {
    try {
      const normalizedPayload = typeof payload === 'object' && payload !== null
        ? payload
        : { message: String(payload) };
      const { BrowserWindow } = require('electron');
      if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send(channel, normalizedPayload);
          }
        });
      }
    } catch (error) {
      this.logger.debug('broadcastToWindows failed (expected in tests):', error.message);
    }
  }

  /**
   * Send output to the commands console (debounced for performance)
   * Error messages (❌) are delivered immediately, others are batched
   * @param {string} message - Message to send
   */
  sendOutput(message) {
    // Error messages bypass debounce — deliver immediately
    if (typeof message === 'string' && message.includes('❌')) {
      this._flushSendOutput();
      this.broadcastToWindows('command-output', { message });
      return;
    }
    // Buffer non-error messages and batch them with 100ms debounce
    this._sendOutputBuffer.push(message);
    if (this._sendOutputTimer) {
      clearTimeout(this._sendOutputTimer);
    }
    this._sendOutputTimer = setTimeout(() => {
      this._sendOutputTimer = null;
      this._flushSendOutput();
    }, 100);
  }

  /**
   * Flush the sendOutput buffer — deliver all pending messages immediately
   * @private
   */
  _flushSendOutput() {
    if (this._sendOutputTimer) {
      clearTimeout(this._sendOutputTimer);
      this._sendOutputTimer = null;
    }
    if (this._sendOutputBuffer.length > 0) {
      const messages = this._sendOutputBuffer.splice(0);
      this.broadcastToWindows('command-output', { message: messages.join('\n') });
    }
  }

  /**
   * Send structured progress update to all renderer windows.
   *
   * Two payload shapes share this single choke point (publish-update-
   * resilience Task 2 — the renderer subscription lands in Task 9):
   *
   *  1. Instrumented flows (`progress.flow` set — refresh / publish-preview /
   *     publish-main / push-to-branch publish): the payload is the Task-2
   *     SUPERSET — { projectId, operationId, flow, stage, stageIndex,
   *     stageTotal, message, percentage (number|null), terminal? }.
   *     stageIndex is 1-based from STAGE_LISTS[flow]; terminal stages
   *     ('complete'|'cancelled'|'failed') are not list members and report
   *     stageIndex = stageTotal.
   *  2. Legacy shape (gitPullFromPreview): { stage, current, total, message }
   *     + the computed percentage — kept untouched for compatibility.
   *
   * @param {Object} progress - Progress data
   * @param {string} progress.stage - Current stage (checking, staging, committing, fetching, pulling, pushing, complete)
   * @param {number} progress.current - Current item number (legacy)
   * @param {number} progress.total - Total items (legacy)
   * @param {string} progress.message - Status message
   */
  sendProgress(progress) {
    if (progress && progress.flow && STAGE_LISTS[progress.flow]) {
      const stages = STAGE_LISTS[progress.flow];
      const stageTotal = stages.length;
      const idx = stages.indexOf(progress.stage);
      this.broadcastToWindows('git:progress', {
        ...progress,
        stageTotal,
        stageIndex: idx >= 0 ? idx + 1 : stageTotal,
        percentage: typeof progress.percentage === 'number' ? progress.percentage : null,
      });
      return;
    }

    const percentage = progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

    this.broadcastToWindows('git:progress', {
      ...progress,
      percentage
    });
  }

  /**
   * Mint the per-operation progress context (publish-update-resilience
   * Task 2). Born in the same scope as acquireGitLock — one operationId
   * per lock acquisition, threaded through the flow bodies as `op`.
   * @param {number|string|null} projectId
   * @param {'refresh'|'publish-preview'|'publish-main'} flow
   * @returns {{projectId, operationId: string, flow: string, stage: string|null, terminalEmitted: boolean}}
   * @private
   */
  _beginOperation(projectId, flow) {
    const op = {
      projectId: projectId === undefined ? null : projectId,
      operationId: require('crypto').randomUUID(),
      flow,
      stage: null,
      terminalEmitted: false,
    };
    // Task 3: the journal's CURRENT operation — every dugite command run
    // while this lock is held is attributed to this operationId. Safe
    // under the single git lock (1 lock = 1 operation); commands outside
    // any lock fall into the journal's disposable unattributed buffer.
    if (this.operationJournal) {
      this.operationJournal.setCurrentOperation(op.operationId, {
        projectId: op.projectId,
        flow: op.flow,
      });
    }
    return op;
  }

  /**
   * Emit a stage-start progress event (inline at each real stage
   * transition of the instrumented flows). Percentage stays null except
   * for transfer stages fed by _emitTransferProgress. Between
   * requestCancel() and the operation settling, the payload carries
   * `cancelling: true` so the renderer (T9/T10) can render
   * "Cancelando…" while the in-flight git child is being killed
   * (cancel hardening, Task 6).
   * @private
   */
  _emitStage(op, stage, message, percentage) {
    if (!op || op.terminalEmitted) return;
    op.stage = stage;
    this.sendProgress({
      projectId: op.projectId,
      operationId: op.operationId,
      flow: op.flow,
      stage,
      message,
      percentage: typeof percentage === 'number' ? percentage : null,
      ...(this.isCancelRequested() ? { cancelling: true } : {}),
    });
  }

  /**
   * Live transfer percentage (fetch/push onProgress) labelled with the
   * operation's CURRENT stage, so deepen fetches happening inside the
   * merge phase can never regress the reported stageIndex. Git's transfer
   * phases (counting/compressing/receiving) each restart at 0% — the
   * per-stage clamp keeps the reported percentage monotonic.
   * @private
   */
  _emitTransferProgress(op, evt) {
    if (!op || op.terminalEmitted) return;
    let percent = null;
    if (evt && typeof evt === 'object') {
      if (evt.total && evt.loaded) {
        percent = Math.round((evt.loaded / evt.total) * 100);
      } else {
        percent = parseTransferPercentage(String(evt.rawDetail || evt.message || ''));
      }
    } else {
      percent = parseTransferPercentage(typeof evt === 'string' ? evt : '');
    }
    if (percent === null || Number.isNaN(percent)) return;
    if (op.lastPercentStage !== op.stage) {
      op.lastPercentStage = op.stage;
      op.lastPercent = null;
    }
    if (op.lastPercent !== null && percent < op.lastPercent) return;
    op.lastPercent = percent;
    this.sendProgress({
      projectId: op.projectId,
      operationId: op.operationId,
      flow: op.flow,
      stage: op.stage,
      message: `${percent}%`,
      percentage: percent,
      ...(this.isCancelRequested() ? { cancelling: true } : {}),
    });
  }

  /**
   * Emit the operation's terminal event — EXACTLY once (guarded), even on
   * failure/cancel. 'failed' reports the stage where the operation died
   * (op.stage fallback 'failed'); 'complete'/'cancelled' use their own
   * stage names. Nothing may be emitted after the terminal.
   *
   * `extra` (Task 7) merges additive payload fields into the terminal
   * event — `restored: true|false|'PARTIAL'`, `partial`,
   * `restoreAborted` — without touching the frozen base shape.
   *
   * @param {'complete'|'cancelled'|'failed'} kind
   * @param {object} [extra] - additive payload fields (restore outcome)
   * @private
   */
  _emitTerminal(op, kind, message, extra) {
    if (!op || op.terminalEmitted) return;
    op.terminalEmitted = true;
    const stage = kind === 'failed' ? (op.stage || 'failed') : kind;
    this.sendProgress({
      projectId: op.projectId,
      operationId: op.operationId,
      flow: op.flow,
      stage,
      message: message || (kind === 'complete'
        ? 'Operação concluída.'
        : kind === 'cancelled' ? 'Operação cancelada.' : 'Operação falhou.'),
      percentage: kind === 'complete' ? 100 : null,
      terminal: kind,
      ...(extra || {}),
    });
    // Task 3: arm the journal's 30-min post-terminal expiry (light hook —
    // the entry stays readable for post-mortem diagnosis via
    // git:get-operation-log, then is dropped; markTerminal also clears
    // the current-operation pointer).
    if (this.operationJournal) {
      this.operationJournal.markTerminal(op.operationId);
    }
  }

  /**
   * Map a flow result to its terminal kind and emit it (exactly-once via
   * _emitTerminal). Returns the result so handlers can
   * `return this._emitTerminalFromResult(op, result)`.
   *
   * Task 7: additive restore-outcome fields on the result
   * (restored/partial/restoreAborted/restoreSkipped/restoreDetails) ride
   * along on the terminal payload.
   * @private
   */
  _emitTerminalFromResult(op, result) {
    if (op && !op.terminalEmitted) {
      const restoreFields = {};
      for (const key of ['restored', 'partial', 'restoreAborted', 'restoreSkipped', 'restoreDetails']) {
        if (result && result[key] !== undefined) {
          restoreFields[key] = result[key];
        }
      }
      if (result && result.cancelled) {
        this._emitTerminal(op, 'cancelled', result.message, restoreFields);
      } else if (result && (result.conflictPending || result.code === 'CONFLICT_PENDING')) {
        // The in-flight operation ends lockless awaiting the user's
        // strategy decision; the resume mints a NEW operationId.
        this._emitTerminal(op, 'cancelled', 'Conflito detectado — aguardando decisão do usuário.');
      } else if (result && result.success === false) {
        this._emitTerminal(op, 'failed', result.error || result.message, restoreFields);
      } else {
        this._emitTerminal(op, 'complete');
      }
    }
    return result;
  }

  /**
   * Emit the auto-restore 'restoring' stage WITHOUT clobbering op.stage:
   * the frozen Task-2 contract says the terminal 'failed' event reports
   * the stage where the OPERATION died (e.g. 'pushing'), and the restore
   * is recovery, not a flow stage transition. Emitted directly (not via
   * sendProgress) so stageIndex stays CLAMPED to the failing stage's
   * index — a stageTotal-indexed event would break the consumers'
   * stageIndex monotonicity once the terminal re-reports the (lower)
   * failing-stage index. No `cancelling` flag: the operation's fate is
   * already sealed, the renderer must show "restoring", not "cancelling".
   * @private
   */
  _emitRestoreStage(op, message) {
    if (!op || op.terminalEmitted) return;
    const stages = STAGE_LISTS[op.flow];
    const idx = Array.isArray(stages) ? stages.indexOf(op.stage) : -1;
    this.broadcastToWindows('git:progress', {
      projectId: op.projectId,
      operationId: op.operationId,
      flow: op.flow,
      stage: 'restoring',
      ...(idx >= 0 ? { stageIndex: idx + 1 } : { stageIndex: stages ? stages.length : null }),
      ...(stages ? { stageTotal: stages.length } : {}),
      message,
      percentage: null,
    });
  }

  /**
   * Build the pure-matrix input (gitSafety.shouldRestore) from the failed
   * result + caught error. failureClass prefers the T5 enriched
   * `result.errorClass`; cancelled results (never enriched) use the
   * pseudo-class 'cancel'.
   * @private
   */
  _failureContextFromResult(op, result, error) {
    let failureClass = result && typeof result.errorClass === 'string' ? result.errorClass : null;
    if (!failureClass && error && typeof error.errorType === 'string') failureClass = error.errorType;
    if (!failureClass && result && result.cancelled) failureClass = 'cancel';
    if (!failureClass) failureClass = 'unknown';
    return {
      failureClass,
      stage: op && op.stage ? op.stage : 'preparing',
      code: (result && result.code) || (error && error.code) || undefined,
      conflictPending: Boolean(result && (result.conflictPending || result.code === 'CONFLICT_PENDING')),
      cancelled: Boolean(result && result.cancelled),
    };
  }

  /**
   * AUTO-RESTORE orchestrator (Task 7). Called from the failure/cancel
   * cleanup of the 3 core wrappers' host handlers — ALWAYS inside the
   * git-lock scope (before releaseGitLock; the engine never acquires the
   * lock itself). Requires op.flowContext, set by the wrappers once the
   * flow backup exists (pre-mutation failures have none → no-op, matching
   * matrix row "falha ANTES do primeiro comando mutante").
   *
   * Steps: matrix decision → (VERIFY_THEN_RESTORE: ls-remote first —
   * remote contains the push → keep state + partial:true) →
   * gitSafety.autoRestoreFromBackup (probe/safety-backup-with-ABORT/
   * writeRef+checkout/PARTIAL probe) → invalidate the repo's conflict
   * tokens → broadcast 'git:state-changed'. The result only ever gains
   * ADDITIVE fields (restored / partial / restoreAborted / …).
   *
   * @param {{flowContext?: object, projectId: *, stage: string|null}} op
   * @param {string} projectPath
   * @param {object} result - failure/cancel result (mutated additively)
   * @param {Error} [error] - the caught error, when the result came from a catch
   * @returns {Promise<object>} the (additively-enriched) result
   * @private
   */
  async _restoreOnFailure(op, projectPath, result, error) {
    try {
      if (!op || !op.flowContext || !result || result.success !== false) return result;
      if (result.conflictPending || result.code === 'CONFLICT_PENDING') return result;

      const failureContext = this._failureContextFromResult(op, result, error);
      const decision = _shouldRestore(failureContext);
      if (decision.action === 'NO') {
        this.logger.info(`🛟 Auto-restore: matriz → NO (${failureContext.failureClass}@${failureContext.stage})`);
        return result;
      }
      const ops = this._safetyOps();
      if (!this.gitSafety || !ops || typeof this.gitSafety.autoRestoreFromBackup !== 'function') {
        return result;
      }
      const fc = op.flowContext;

      if (decision.action === 'VERIFY_THEN_RESTORE') {
        this._emitRestoreStage(op, 'Verificando se a publicação chegou ao repositório remoto...');
        let expectedOid = null;
        try {
          expectedOid = await this.git.resolveRef(projectPath, 'HEAD');
        } catch (_e) { /* null expectedOid → verified remoteContains stays false */ }
        const verify = await _verifyRemoteState(
          this.git, projectPath, fc.targetBranch, expectedOid,
          fc.auth ? { auth: fc.auth } : {}
        );
        if (!verify.verified) {
          this.logger.warn(`🛟 Auto-restore: remoto não verificável (${verify.error}) — estado mantido (nada foi perdido)`);
          return {
            ...result,
            restored: false,
            restoreSkipped: 'VERIFY_UNAVAILABLE',
            restoreInfo: 'Não foi possível verificar o repositório remoto. Nada foi perdido — sincronize quando a conexão voltar.',
          };
        }
        if (verify.remoteContains) {
          this.logger.info('🛟 Auto-restore: ls-remote contém o push — estado mantido (sucesso parcial)');
          return {
            ...result,
            restored: false,
            partial: true,
            remoteOid: verify.remoteOid,
            restoreInfo: 'A publicação CHEGOU ao repositório remoto apesar do erro — o estado local foi mantido em sincronia.',
          };
        }
      }

      this._emitRestoreStage(op, 'Restaurando o estado original do repositório...');
      const restore = await this.gitSafety.autoRestoreFromBackup(ops, require('fs'), projectPath, fc);

      if (restore.aborted === 'SAFETY_BACKUP_FAILED') {
        this.sendOutput('❌ Restauração automática abortada (falha no backup de segurança). Restaure manualmente em config.html → Gerenciar backups.');
        return {
          ...result,
          restored: false,
          restoreAborted: 'SAFETY_BACKUP_FAILED',
          restoreHint: 'A restauração automática foi abortada para proteger seus dados (falha ao criar o backup de segurança do estado atual). Restaure manualmente em config.html (gerenciar backups) — nada foi perdido.',
          ...(restore.journalHint ? { operationId: restore.journalHint } : {}),
        };
      }
      if (restore.aborted) {
        this.logger.error(`🛟 Auto-restore abortado: ${restore.aborted}`, restore.error);
        return {
          ...result,
          restored: false,
          restoreAborted: restore.aborted,
          ...(restore.journalHint ? { operationId: restore.journalHint } : {}),
        };
      }
      if (restore.restored === 'PARTIAL') {
        this.broadcastToWindows('git:state-changed', {
          projectId: op.projectId,
          reason: 'auto-restore-partial',
          operationId: fc.operationId,
        });
        return { ...result, restored: 'PARTIAL', restoreDetails: restore.details };
      }
      if (restore.skipped) {
        return { ...result, restored: false, restoreSkipped: restore.skipped };
      }

      // Full restore: tokens under stale state die, every window re-reads.
      this.invalidateConflictsForProject(op.projectId, projectPath);
      this.broadcastToWindows('git:state-changed', {
        projectId: op.projectId,
        reason: 'auto-restore',
        operationId: fc.operationId,
      });
      this.sendOutput(`♻️ Estado original restaurado a partir de ${restore.restoredFrom}.`);
      return { ...result, restored: true, restoredFrom: restore.restoredFrom };
    } catch (restoreErr) {
      // The restore must never mask the original failure result.
      this.logger.error('Auto-restore falhou (resultado original preservado):', restoreErr);
      return result;
    }
  }

  /**
   * Get project path by ID
   * @param {number} projectId - Project ID
   * @returns {Promise<string>} Full project path
   */
  async getProjectPath(projectId) {
    const db = await this.databaseManager.getDatabase();
    
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM projects WHERE id = ?', [projectId], (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        
        if (!row) {
          reject(new Error('Project not found'));
          return;
        }

        this.logger.info(`📂 Project data: ID=${row.id}, projectPath=${row.projectPath}, repoFolderName=${row.repoFolderName}`);

        // Validate required fields
        if (!row.projectPath) {
          reject(new Error(`Invalid project data: projectPath is missing`));
          return;
        }

        // Handle different path scenarios
        let projectPath;
        if (row.repoFolderName) {
          // Check if projectPath already includes repoFolderName
          if (row.projectPath.endsWith(row.repoFolderName)) {
            projectPath = row.projectPath;
            this.logger.info(`📂 Project path already includes repo folder: ${projectPath}`);
          } else {
            projectPath = path.join(row.projectPath, row.repoFolderName);
            this.logger.info(`📂 Constructed project path: ${projectPath}`);
          }
        } else {
          projectPath = row.projectPath;
          this.logger.info(`📂 Using project path directly: ${projectPath}`);
        }

        this.logger.info(`✅ Final project path: ${projectPath}`);
        resolve(projectPath);
      });
    });
  }

  /**
   * Check if repository has uncommitted changes
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<{success: boolean, isDirty: boolean, fileCount: number, files: string[]}>}
   */
  async gitCheckStatus(projectPath) {
    try {
      const matrix = await this.git.statusMatrix(projectPath, { cache: this._gitCache });
      const dirtyFiles = matrix.filter(([, head, workdir, stage]) =>
        !(head === 1 && workdir === 1 && stage === 1)
      );

      return {
        success: true,
        isDirty: dirtyFiles.length > 0,
        fileCount: dirtyFiles.length,
        files: dirtyFiles.map(([filepath]) => filepath)
      };
    } catch (error) {
      this.logger.error('Error checking git status:', error);
      return { success: false, isDirty: false, fileCount: 0, files: [], error: error.message };
    }
  }

  /**
   * Check if local branch has commits not yet pushed to remote.
   * Uses local remote-tracking refs only (no network fetch).
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<{success: boolean, hasUnpushed: boolean, currentBranch?: string, localSha?: string, remoteSha?: string}>}
   */
  async gitCheckUnpushed(projectPath) {
    try {
      const currentBranch = await this.git.currentBranch(projectPath, { cache: this._gitCache });
      const localSha = await this.git.resolveRef(projectPath, 'HEAD');
      let remoteSha = null;
      try {
        remoteSha = await this.git.resolveRef(projectPath, `refs/remotes/origin/${currentBranch}`);
      } catch (_e) {
        return { success: true, hasUnpushed: true, currentBranch, localSha, remoteSha: null };
      }
      return { success: true, hasUnpushed: localSha !== remoteSha, currentBranch, localSha, remoteSha };
    } catch (error) {
      this.logger.error('Error checking unpushed commits:', error);
      return { success: false, hasUnpushed: false, error: error.message };
    }
  }

  /**
   * Stage all dirty files and create a commit
   * @param {string} projectPath - Path to the git repository
   * @param {string} commitMessage - Commit message
   * @param {Object} author - Author object with name and email
   * @param {string[]|null} [dirtyFiles=null] - Pre-computed list of dirty filepaths.
   *   When provided (non-null and non-empty), the statusMatrix scan is skipped.
   *   Each entry must be either an existing filepath (will be staged with git.add)
   *   or a filepath prefixed with a deletion marker handled by the caller — the
   *   caller is responsible for ensuring each file's working-tree state matches
   *   what is intended. Pass null/[] to fall back to a full statusMatrix scan.
   * @returns {Promise<string|null>} Commit SHA or null if nothing to commit
   * @private
   */
  async _commitAll(projectPath, commitMessage, author, dirtyFiles = null) {
    try {
      let dirty;

      if (Array.isArray(dirtyFiles) && dirtyFiles.length > 0) {
        // Caller provided a pre-computed dirty file list — skip the O(n) statusMatrix.
        // Map plain filepaths to the [filepath, head, workdir, stage] shape expected
        // by the batching logic below. workdir=1 (present) by default; deletions are
        // detected per-file in the add/remove step via fs.access.
        dirty = dirtyFiles.map((entry) => {
          if (Array.isArray(entry)) return entry;
          return [entry, 1, 1, 1];
        });
      } else {
        const matrix = await this.git.statusMatrix(projectPath, { cache: this._gitCache });
        dirty = matrix.filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));
      }

      if (dirty.length === 0) {
        this.sendOutput('ℹ️ Nenhuma alteração para commitar.');
        return null;
      }

      this.sendOutput(`📝 Preparando ${dirty.length} arquivo(s) para commit...`);

      // Stage files em batches com tratamento de erro individual
      // 100 (Task 4): large publishes were bounded by 10-file batches;
      // 100 keeps the argv-limit guard while cutting batch count 10×.
      const stageErrors = [];
      const BATCH_SIZE = 100;
      const signal = this.getAbortSignal();
      for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
        const batch = dirty.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async ([filepath, , worktreeStatus]) => {
            try {
              if (worktreeStatus) {
                await this.git.add(projectPath, filepath, { signal });
              } else {
                await this.git.remove(projectPath, filepath, { signal });
              }
            } catch (fileError) {
              stageErrors.push({ filepath, error: fileError.message });
            }
          })
        );

        // Reportar progresso após cada batch
        const progress = Math.round(((i + batch.length) / dirty.length) * 100);
        this.sendOutput(`📊 Progresso: ${progress}% (${i + batch.length}/${dirty.length} arquivos)`);
      }

      if (stageErrors.length > 0) {
        const errorMsg = `Erro ao preparar arquivo(s): ${stageErrors.map(e => e.filepath).join(', ')}`;
        this.sendOutput(`❌ ${errorMsg}`);
        throw new Error(errorMsg);
      }

      this._gitCache = {};

      this.sendOutput(`💾 Commitando: "${commitMessage}"`);
      const sha = await this.git.commit(projectPath, commitMessage, { author, signal });
      this.sendOutput(`✅ Commit criado: ${sha.substring(0, 7)}`);
      return sha;
    } catch (error) {
      this.sendOutput(`❌ Erro durante commit: ${error.message}`);
      throw error;
    }
  }

  /**
   * List all branches in the repository
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<{branches: Array<BranchInfo>, current: string}>}
   */
  async gitListBranches(projectPath) {
    try {
      this.logger.info(`🔍 Listing branches for repository: ${projectPath}`);
      
      // Check if directory exists and is a git repository
      const fs = require('fs');
      try {
        await fs.promises.access(projectPath);
      } catch {
        throw new Error(`Repository path does not exist: ${projectPath}`);
      }
      
      const gitDir = require('path').join(projectPath, '.git');
      try {
        await fs.promises.access(gitDir);
      } catch {
        throw new Error(`Not a git repository: ${projectPath}`);
      }
      
      // Get current branch with fallback
      let currentBranch = 'master'; // Default fallback
      try {
        currentBranch = await this.git.currentBranch(projectPath, { cache: this._gitCache });
        this.logger.info(`✅ Current branch detected: ${currentBranch}`);
      } catch (error) {
        this.logger.warn(`⚠️ Could not determine current branch, using fallback: ${error.message}`);
        // Try to get branches directly as fallback
        try {
          const refs = await this.git.listRefs(projectPath, { cache: this._gitCache });
          const headRef = refs.find(ref => ref === 'HEAD');
           if (headRef) {
             // Try to resolve HEAD manually
             const headFile = require('path').join(gitDir, 'HEAD');
             try {
               const headContent = await fs.promises.readFile(headFile, 'utf8');
               const match = headContent.match(/ref: refs\/heads\/(.+)/);
               if (match) {
                 currentBranch = match[1].trim();
                 this.logger.info(`✅ Current branch resolved from HEAD file: ${currentBranch}`);
               }
             } catch {
               // HEAD file doesn't exist or can't be read, continue with fallback
             }
           }
        } catch (fallbackError) {
          this.logger.warn(`⚠️ Could not resolve current branch from HEAD: ${fallbackError.message}`);
        }
      }
      
    // Use the simple and reliable git.listBranches() approach (same as working GitOperations.js)
    let branches = [];
    let remoteBranches = [];
    
    try {
      // Get all branches (local and remote) via the git facade
      const allBranches = await this.git.listBranches(projectPath, { cache: this._gitCache });
      
      // Separate local and remote branches (same logic as GitOperations.js)
      const localBranches = allBranches.filter(branch => !branch.includes('origin/'));
      const remoteBranchNames = allBranches.filter(branch => branch.includes('origin/'))
        .map(branch => branch.replace('origin/', ''));
      
      // Create branch objects for local branches
      for (const branchName of localBranches) {
        branches.push({
          name: branchName,
          isCurrent: branchName === currentBranch,
          isRemote: false
        });
      }
      
      // Create branch objects for remote branches
      for (const branchName of remoteBranchNames) {
        if (branchName !== 'HEAD') {
          remoteBranches.push({
            name: branchName,
            isCurrent: false,
            isRemote: true
          });
        }
      }
      
    } catch (error) {
      this.logger.error(`Failed to list branches via git.listBranches(): ${error.message}`);
      
       // Fallback to filesystem method if git.listBranches() fails
       this.logger.warn('Falling back to filesystem method...');
       try {
         const headsDir = require('path').join(gitDir, 'refs', 'heads');
         try {
           const branchFiles = await fs.promises.readdir(headsDir);
           for (const branchName of branchFiles) {
             branches.push({
               name: branchName,
               isCurrent: branchName === currentBranch,
               isRemote: false
             });
           }
           this.logger.info(`Fallback: Found ${branchFiles.length} local branches via filesystem`);
         } catch {
           // headsDir doesn't exist or can't be read
         }
       } catch (fallbackError) {
         this.logger.error(`Filesystem fallback also failed: ${fallbackError.message}`);
       }
    }
      
      const result = {
        branches: branches.concat(remoteBranches),
        current: currentBranch
      };
      
      this.logger.info(`✅ Branch listing complete: ${result.branches.length} branches, current: ${result.current}`);
      return result;
    } catch (error) {
      this.logger.error('❌ Error listing branches:', error);
      throw error;
    }
  }

  /**
   * Create a new branch
   * @param {string} projectPath - Path to the git repository
   * @param {string} branchName - Name of the branch to create
   * @returns {Promise<void>}
   */
  async gitCreateBranch(projectPath, branchName) {
    try {
      await this.git.branch(projectPath, branchName);
      this._gitCache = {};
      
      this.logger.info(`Created branch: ${branchName}`);
    } catch (error) {
      this.logger.error('Error creating branch:', error);
      throw error;
    }
  }

  /**
   * Checkout to a specific branch
   * @param {string} projectPath - Path to the git repository
   * @param {string} branchName - Name of the branch to checkout
   * @returns {Promise<void>}
   */
  async gitCheckoutBranch(projectPath, branchName) {
    try {
      this.logger.info(`🔄 Checking out branch '${branchName}' in ${projectPath}`);
      
      const fs = require('fs');
      
      // Start branch list fetch in parallel with checkout attempt (avoids redundant call on failure)
      const branchListPromise = this.gitListBranches(projectPath).catch(() => null);
      
      // First, try to checkout directly (for local branches)
      try {
        await this.git.checkout(projectPath, branchName);
        this._gitCache = {};
        
        this.logger.info(`✅ Successfully checked out branch: ${branchName}`);
        return;
      } catch (directError) {
        this.logger.warn(`⚠️ Direct checkout failed: ${directError.message}`);
        
        // Use the already-fetched (parallel) branch list
        try {
          const branchResult = await branchListPromise;
          if (!branchResult) {
            throw new Error(`Branch '${branchName}' not found locally or remotely`);
          }
          const localBranch = branchResult.branches.find(b => b.name === branchName && !b.isRemote);
          const remoteBranch = branchResult.branches.find(b => b.name === branchName && b.isRemote);
          
          if (localBranch) {
            // Local branch exists but checkout failed, try again with force
            this.logger.info(`📂 Local branch exists, trying checkout again...`);
            await this.git.checkout(projectPath, branchName);
            this._gitCache = {};
            this.logger.info(`✅ Successfully checked out local branch: ${branchName}`);
          } else if (remoteBranch) {
            // Remote branch exists, create local tracking branch
            this.logger.info(`📥 Remote branch exists, creating local tracking branch...`);
            await this.git.branch(projectPath, branchName, {
              object: `origin/${branchName}`,
              checkout: true
            });
            await this.git.setConfig(projectPath, `branch.${branchName}.remote`, 'origin');
            await this.git.setConfig(projectPath, `branch.${branchName}.merge`, `refs/heads/${branchName}`);
            this._gitCache = {};
            this.logger.info(`✅ Created and checked out local branch: ${branchName}`);
          } else {
            throw new Error(`Branch '${branchName}' not found locally or remotely`);
          }
        } catch (branchError) {
          this.logger.error(`❌ Branch checkout failed: ${branchError.message}`);
          throw branchError;
        }
      }
    } catch (error) {
      this.logger.error('❌ Error checking out branch:', error);
      throw error;
    }
  }

  /**
   * Get current branch name
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<string>} Current branch name
   */
  async gitGetCurrentBranch(projectPath) {
    try {
      const currentBranch = await this.git.currentBranch(projectPath, { cache: this._gitCache });
      return currentBranch;
    } catch (error) {
      this.logger.error('Error getting current branch:', error);
      throw error;
    }
  }

  /**
   * Get repository information
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<RepositoryInfo>} Repository information
   */
  async gitGetRepositoryInfo(projectPath) {
    try {
      this.logger.info(`📋 Getting repository information from ${projectPath}`);
      
      const fs = require('fs');
      
      // Get current branch with fallback
      let currentBranch = 'master';
      try {
        currentBranch = await this.git.currentBranch(projectPath, { cache: this._gitCache });
        this.logger.info(`✅ Current branch: ${currentBranch}`);
      } catch (error) {
        this.logger.warn(`⚠️ Could not get current branch: ${error.message}`);
        // Use gitListBranches to get current branch
        try {
          const branchResult = await this.gitListBranches(projectPath);
          currentBranch = branchResult.current || 'master';
          this.logger.info(`✅ Using fallback current branch: ${currentBranch}`);
        } catch (fallbackError) {
          this.logger.warn(`⚠️ Could not get branches for fallback: ${fallbackError.message}`);
        }
      }
      
      // Get branches
      const branchResult = await this.gitListBranches(projectPath);
      const allBranches = branchResult.branches || [];
      const localBranches = allBranches.filter(b => !b.isRemote);
      const remoteBranches = allBranches.filter(b => b.isRemote);
      
      // Get remote URL
      let remoteUrl = null;
      try {
        remoteUrl = await this.git.getConfig(projectPath, 'remote.origin.url', { cache: this._gitCache });
      } catch (error) {
        this.logger.debug('Could not get remote URL:', error.message);
      }
      
      // Get last commit information
      let lastCommit = {
        hash: '',
        message: '',
        date: null
      };
      
      try {
        // Try to get commit OID for the current branch HEAD
        const commitOid = await this.git.resolveRef(projectPath, currentBranch, { cache: this._gitCache });
        
        if (commitOid) {
          // Get commit details
          const commit = await this.git.readCommit(projectPath, commitOid, { cache: this._gitCache });
          
          if (commit && commit.commit) {
            lastCommit.hash = commitOid.substring(0, 7); // Short hash (7 characters)
            lastCommit.message = commit.commit.message.split('\n')[0]; // First line only
            lastCommit.date = new Date(commit.commit.author.timestamp * 1000);
          }
        }
      } catch (error) {
        this.logger.warn('Could not get last commit info:', error.message);
        // Try fallback to get commit from HEAD directly
        try {
          const headOid = await this.git.resolveRef(projectPath, 'HEAD', { cache: this._gitCache });
          
          if (headOid) {
            const commit = await this.git.readCommit(projectPath, headOid, { cache: this._gitCache });
            
            if (commit && commit.commit) {
              lastCommit.hash = headOid.substring(0, 7);
              lastCommit.message = commit.commit.message.split('\n')[0];
              lastCommit.date = new Date(commit.commit.author.timestamp * 1000);
              this.logger.info(`✅ Got commit info from HEAD: ${lastCommit.hash}`);
            }
          }
        } catch (headError) {
          this.logger.warn('Could not get commit from HEAD either:', headError.message);
        }
      }
      
      // Get status
      let isClean = true;
      let status = null;
      try {
        const statusResult = await this.git.statusMatrix(projectPath, { cache: this._gitCache });
        
        // Check if there are any unstaged changes
        isClean = statusResult.every(row => row[1] === row[2]);
        status = isClean ? 'clean' : 'dirty';
      } catch (error) {
        this.logger.debug('Could not get status:', error.message);
      }
      
      const result = {
        workingDirectory: projectPath,
        remoteUrl: remoteUrl || '',
        lastCommit: lastCommit,
        currentBranch,
        branches: localBranches.map(b => b.name),
        remoteBranches: remoteBranches.map(b => b.name),
        isClean,
        status
      };
      
      this.logger.info(`✅ Repository info retrieved:`, result);
      return result;
    } catch (error) {
      this.logger.error('Error getting repository info:', error);
      throw error;
    }
  }

  /**
   * Pull changes from remote for current branch
   * @param {string} projectPath - Path to the git repository
   * @param {string|null} [commitMessage=null] - If provided, commit all changes before pulling
   * @returns {Promise<{success: boolean, pulled?: boolean, branch?: string, error?: string}>}
   */
  async gitPullFromPreview(projectPath, commitMessage = null) {
    if (!this.acquireGitLock()) {
      this.sendOutput('⚠️ Operação Git já em andamento. Aguarde...');
      return { success: false, error: 'Git operation already in progress. Please wait.' };
    }

    try {
      // 1. Início - verificando
      this.sendProgress({
        stage: 'checking',
        current: 0,
        total: commitMessage ? 5 : 3,
        message: 'Verificando status do repositório...'
      });

      const [token, currentBranch] = await Promise.all([
        this.gitOps.getGitHubToken(),
        this.git.currentBranch(projectPath, { cache: this._gitCache })
      ]);

      if (!token) {
        this.sendOutput('❌ Autenticação GitHub necessária. Faça login novamente.');
        return { success: false, error: 'Autenticação GitHub necessária. Faça login novamente.' };
      }

      if (!currentBranch) {
        this.sendOutput('❌ Nenhuma branch selecionada (detached HEAD). Selecione uma branch para atualizar.');
        return { success: false, error: 'Nenhuma branch selecionada (detached HEAD). Selecione uma branch primeiro.' };
      }

      const auth = { token };

      // Commit local changes before pulling if commitMessage provided
      if (commitMessage) {
        // 2. Staging
        this.sendProgress({
          stage: 'staging',
          current: 1,
          total: 5,
          message: 'Preparando arquivos para commit...'
        });

        this.sendOutput('⚙️ Configurando usuário git para commit...');
        try {
          await this.gitOps.configureGitForUser(projectPath);
        } catch (configError) {
          this.logger.warn('Could not configure git user:', configError);
          this.sendOutput('⚠️ Não foi possível configurar usuário git. Continuando com configuração existente...');
        }
        const [authorName, authorEmail] = await Promise.all([
          this.git.getConfig(projectPath, 'user.name', { cache: this._gitCache }).then(v => v || 'documental'),
          this.git.getConfig(projectPath, 'user.email', { cache: this._gitCache }).then(v => v || 'documental@app')
        ]);
        const author = { name: authorName, email: authorEmail };

        // 3. Committing
        this.sendProgress({
          stage: 'committing',
          current: 2,
          total: 5,
          message: 'Criando commit...'
        });

        await this._commitAll(projectPath, commitMessage, author);

        // Check for cancellation after auto-commit
        if (this.isCancelRequested()) {
          this.logger.info('Pull operation cancelled after commit');
          this.releaseGitLock();
          return { success: false, cancelled: true, message: 'Operation cancelled by user' };
        }
      }

      // 4. Fetching (or step 2 if no commitMessage)
      this.sendProgress({
        stage: 'fetching',
        current: commitMessage ? 3 : 1,
        total: commitMessage ? 5 : 3,
        message: `Buscando alterações da branch remota '${currentBranch}'...`
      });

      this.sendOutput(`📥 Buscando alterações da branch remota '${currentBranch}'...`);

      await this.git.fetch(projectPath, {
        remote: 'origin',
        ref: currentBranch,
        singleBranch: true,
        depth: 1,
        auth,
        onProgress: (evt) => {
          if (evt.total && evt.loaded) {
            const percent = Math.round((evt.loaded / evt.total) * 100);
            this.sendProgress({
              stage: 'fetching',
              current: percent,
              total: 100,
              message: `Baixando: ${percent}%`
            });
          }
        }
      });
      this._gitCache = {};

      // Check for cancellation after fetch
      if (this.isCancelRequested()) {
        this.logger.info('Pull operation cancelled after fetch');
        this.releaseGitLock();
        return { success: false, cancelled: true, message: 'Operation cancelled by user' };
      }

      // 5. Pulling - Check if fast-forward is possible (faster than pull)
      this.sendProgress({
        stage: 'pulling',
        current: commitMessage ? 4 : 2,
        total: commitMessage ? 5 : 3,
        message: 'Mesclando alterações...'
      });

      this.sendOutput('🔄 Verificando atualização...');

      // Check for cancellation
      if (this.isCancelRequested()) {
        this.logger.info('Pull operation cancelled before merge');
        this.releaseGitLock();
        return { success: false, cancelled: true, message: 'Operation cancelled by user' };
      }

      // Try fast-forward first (faster than pull)
      try {
        const canFastForward = await this.git.canFastForward(projectPath, {
          ref: `origin/${currentBranch}`,
          target: currentBranch
        });

        if (canFastForward) {
          this.sendOutput('⚡ Fast-forward possível, atualizando...');
          await this.git.fastForward(projectPath, {
            ref: currentBranch,
            auth,
          });
        } else {
          this.sendOutput('🔄 Mesclando alterações...');
          await this.git.pull(projectPath, {
            ref: currentBranch,
            singleBranch: true,
            author: { name: 'documental', email: 'documental@app' },
            auth,
          });
        }
      } catch (ffError) {
        // Fallback to regular pull if fast-forward check fails
        this.logger.warn('Fast-forward check failed, using regular pull:', ffError);
        await this.git.pull(projectPath, {
          ref: currentBranch,
          singleBranch: true,
          author: { name: 'documental', email: 'documental@app' },
          auth,
        });
      }
      this._gitCache = {};

      // 6. Complete
      this.sendProgress({
        stage: 'complete',
        current: commitMessage ? 5 : 3,
        total: commitMessage ? 5 : 3,
        message: 'Pull concluído com sucesso!'
      });

      this.sendOutput(`✅ Pull concluído com sucesso na branch: ${currentBranch}`);
      this.logger.info(`Successfully pulled from branch: ${currentBranch}`);
      return { success: true, pulled: true, branch: currentBranch };

    } catch (error) {
      this.logger.error('Error pulling from branch:', error);

      let errorMessage = error.message || 'Erro desconhecido ao atualizar';

      if (error.message && (error.message.includes('merge') || error.message.includes('conflict'))) {
        errorMessage = 'Conflito de merge detectado. Resolva manualmente.';
      } else if (error.message && (error.message.includes('network') || error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT'))) {
        errorMessage = 'Erro de rede. Verifique sua conexão.';
      } else if (error.message && (error.message.includes('401') || error.message.includes('403') || error.message.includes('authentication'))) {
        errorMessage = 'Erro de autenticação. Faça login novamente.';
      }

      this.sendOutput(`❌ Erro ao atualizar: ${errorMessage}`);
      return { success: false, error: errorMessage };

    } finally {
      this.releaseGitLock();
    }
  }

  /**
   * Push changes to a specific branch with optional commit-before-push and first-push-wins strategy
   * @param {string} projectPath - Path to the git repository
   * @param {string} targetBranch - Target branch name
   * @param {string|null} [commitMessage=null] - If provided, commit all changes before pushing
   * @returns {Promise<{success: boolean, pushed?: boolean, branch?: string, error?: string}>}
   */
  async _publishCore(projectPath, targetBranch, { localSha, auth, signal, author, conflictStrategy, op }) {
    const originalBranch = await this.git.currentBranch(projectPath, { cache: this._gitCache });
    const onWorkingBranch = originalBranch === targetBranch;

    const headBeforeMerge = localSha || await this.git.resolveRef(projectPath, 'HEAD');

    if (this.isCancelRequested()) {
      return { cancelled: true };
    }

    if (!onWorkingBranch) {
      this.sendOutput(`📥 Mudando para branch '${targetBranch}'...`);
      try {
        await this._raceTimeout(
          this.git.checkout(projectPath, targetBranch, { signal }),
          this.STEP_TIMEOUT_CHECKOUT_MS,
          `checkout ${targetBranch}`,
        );
      } catch (_e) {
        await this._raceTimeout(
          this.git.checkout(projectPath, `origin/${targetBranch}`, { signal }),
          this.STEP_TIMEOUT_CHECKOUT_MS,
          `checkout origin/${targetBranch}`,
        );
        await this.git.branch(projectPath, targetBranch, { checkout: true, signal });
      }
    }

    this._emitStage(op, 'fetching', `Buscando alterações remotas de '${targetBranch}'...`);
    this.sendOutput(`📥 Buscando alterações remotas de '${targetBranch}'...`);
    let firstPublish = false;
    try {
      this._renewHeartbeat();
      await this._raceTimeout(
        this.git.fetch(projectPath, {
          remote: 'origin', ref: targetBranch, singleBranch: true, depth: 1,
          ...(signal ? { signal } : {}), ...(auth ? { auth } : {}),
          ...(op ? { onProgress: (evt) => this._emitTransferProgress(op, evt) } : {}),
        }),
        this.STEP_TIMEOUT_FETCH_MS,
        `fetch origin/${targetBranch}`,
      );
    } catch (fetchErr) {
      const msg = fetchErr.message || '';
      if (!msg.includes('Could not find') && !msg.includes('not found') && !msg.includes('404')) {
        throw fetchErr;
      }
      firstPublish = true;
    }
    this._gitCache = {};

    let originOid = null;
    if (!firstPublish) {
      try {
        originOid = await this.git.resolveRef(projectPath, `refs/remotes/origin/${targetBranch}`);
      } catch (_e) {
        firstPublish = true;
      }
    }

    if (firstPublish) {
      this.sendOutput('ℹ️ Branch remota não encontrada — criando nova branch.');
    } else if (originOid !== headBeforeMerge) {
      // Divergence: is the remote tip already an ancestor of HEAD (local ahead)?
      // Vitest throws on accessing undefined mock exports — guard with try/catch.
      let localAhead = false;
      try {
        localAhead = await this.git.canFastForward(projectPath, {
          ref: `origin/${targetBranch}`, target: 'HEAD',
        });
      } catch (_ffErr) { localAhead = false; }

      if (!localAhead) {
        // Diverged AND not ahead: deepen the depth:1 fetch so the merge-base
        // exists (shallow tips have no common history to merge from).
        try {
          this._renewHeartbeat();
          await this._raceTimeout(
            this.git.fetch(projectPath, {
              remote: 'origin', ref: targetBranch, singleBranch: true,
              ...(signal ? { signal } : {}), ...(auth ? { auth } : {}),
              ...(op ? { onProgress: (evt) => this._emitTransferProgress(op, evt) } : {}),
            }),
            this.STEP_TIMEOUT_FETCH_MS,
            `deepen fetch origin/${targetBranch}`,
          );
          this._gitCache = {};
        } catch (_deepenErr) {
          // best-effort: the merge below surfaces the real error if any
        }

        // Cancel raced the deepen (or killed it): the shallow tips now
        // lack a merge-base, which the conflict gate would misread as a
        // conflict — stop here instead (same checkpoint pattern as
        // _refreshCore post-deepen).
        if (this.isCancelRequested()) {
          return { cancelled: true };
        }

        this._emitStage(op, 'merging', 'Verificando e mesclando alterações...');

        // F3-D1: re-check ancestry now that history is complete. Post-recovery
        // topologies (PUSH_REJECTED → guided refresh merge) make origin/target
        // an ANCESTOR of HEAD, but the ancestry walk can fail on the shallow
        // depth:1 tip (isDescendent needs full history), reporting
        // localAhead=false above. Merging anyway hits the legacy provider's NON-MINIMAL
        // findMergeBase (multiple bases incl. the already-merged remote tip)
        // → MergeNotSupportedError. Skipping the merge is the correct outcome:
        // the local branch is strictly ahead, the push alone syncs the remote.
        let stillLocalAhead = false;
        try {
          stillLocalAhead = await this.git.canFastForward(projectPath, {
            ref: `origin/${targetBranch}`, target: 'HEAD',
          });
        } catch (_ffErr) { stillLocalAhead = false; }

        let merged = stillLocalAhead;
        if (!merged) {
          // Direction contract (anti-inversion):
          //  - working-branch publish: ours = LOCAL commits → -X ours
          //  - cross-branch publish:   ours = target(remote state), theirs =
          //    the local commits → -X theirs keeps LOCAL winning
          const theirRef = onWorkingBranch ? `origin/${targetBranch}` : originalBranch;

          // Task 3: on the auto path, ask the user BEFORE merging a real
          // conflict; on resume (conflictStrategy set), merge with the
          // user-chosen driver instead.
          if (!conflictStrategy) {
            const gate = await this._conflictGate(projectPath, theirRef);
            if (gate) {
              if (!onWorkingBranch && originalBranch) {
                // Best-effort cleanup: deliberately NO signal — an aborted
                // signal would throw inside this catch and skip the
                // conflictPending return (Task 6 decision, see learnings).
                try {
                  await this.git.checkout(projectPath, originalBranch);
                  this._gitCache = {};
                } catch (_e) { /* best-effort return to the working branch */ }
              }
              return { conflictPending: gate };
            }
          }
          const strat = conflictStrategy
            ? this._conflictDriverFor(conflictStrategy, onWorkingBranch)
            : null;

          this.sendOutput('🔀 Mesclando alterações (suas alterações vencem conflitos)...');
          try {
            await this._raceTimeout(
              this.git.merge(projectPath, theirRef, {
                ours: targetBranch,
                fastForward: false,
                // T5-1: stage clean merges + conflict stages in the index
                // BEFORE the legacy provider throws, so the binary fallback commit
                // keeps the remote's clean files (dugite ignores this key).
                abortOnConflict: false,
              ...(strat
                ? { strategy: strat.side }
                : { strategy: onWorkingBranch ? 'ours' : 'theirs' }),
              message: `Merge publish${conflictStrategy ? ` (${conflictStrategy})` : ''} (${targetBranch}) — ${new Date().toISOString()}`,
                author,
                ...(signal ? { signal } : {}),
              }),
              this.STEP_TIMEOUT_MERGE_MS,
              `merge publish ${targetBranch}`,
            );
          } catch (mergeErr) {
            // F3-D1 defense: multi merge-base → MergeNotSupportedError. When
            // the remote tip is already merged into HEAD (non-minimal base
            // list includes it), the merge is a semantic no-op — push only.
            if (this._isMergeNotSupported(mergeErr)) {
              try {
                merged = await this.git.canFastForward(projectPath, {
                  ref: `origin/${targetBranch}`, target: 'HEAD',
                });
              } catch (_ffErr) { merged = false; }
            }
            if (!merged) {
              const conflictFiles = this._extractConflictFiles(mergeErr);
              if (!conflictFiles) {
                throw mergeErr;
              }
              this.sendOutput('⚠️ Conflito binário detectado — usando sua versão.');
              // Strategy resume: binary bytes come from the winning side of
              // the chosen strategy; auto path keeps the historical
              // LOCAL-wins direction.
              const binaryOidFor = async () => {
                if (!strat) {
                  return headBeforeMerge;
                }
                if (strat.side === 'ours') {
                  return onWorkingBranch ? headBeforeMerge : originOid;
                }
                return onWorkingBranch
                  ? originOid
                  : this.git.resolveRef(projectPath, originalBranch);
              };
              const binaryOid = strat ? await binaryOidFor() : headBeforeMerge;
              for (const filepath of conflictFiles) {
                try {
                  await this._resolveBinarySide(projectPath, filepath, binaryOid);
                } catch (resolveErr) {
                  this.logger.warn(`Could not resolve binary ${filepath}: ${resolveErr.message}`);
                }
              }
              const otherParent = onWorkingBranch ? originOid : originalBranch;
              await this.git.commit(
                projectPath,
                `Merge publish (binary resolved) — ${new Date().toISOString()}`,
                { author, parent: [targetBranch, otherParent], ...(signal ? { signal } : {}) },
              );
            }
          }
        }

        if (!merged) {
          // the legacy provider merge does NOT touch the working tree — materialize
          // HEAD. Safe: the caller wraps this core in withMandatoryBackup.
          await this._raceTimeout(
            this.git.checkout(projectPath, targetBranch, { force: true, signal }),
            this.STEP_TIMEOUT_CHECKOUT_MS,
            `materialize ${targetBranch}`,
          );
          this._gitCache = {};
        }
      } else {
        this.sendOutput('⚡ Modo rápido');
      }
    }

    if (this.isCancelRequested()) {
      return { cancelled: true };
    }

    this._emitStage(op, 'pushing', `Publicando na branch '${targetBranch}'...`);
    this.sendOutput(`🚀 Publicando na branch '${targetBranch}'...`);
    try {
      await this._pushWithTransientRetry(projectPath, {
        remote: 'origin', branch: targetBranch, remoteRef: targetBranch,
        ...(auth ? { auth } : {}),
      }, { op, signal, label: targetBranch });
    } catch (pushErr) {
      if (this._isPushRejected(pushErr)) {
        throw new GitFlowError(
          'PUSH_REJECTED',
          'O repositório remoto tem novidades. Clique em Atualizar primeiro e depois publique novamente.',
          pushErr,
        );
      }
      throw pushErr;
    }
    this._gitCache = {};

    this._emitStage(op, 'finalizing', 'Finalizando publicação (checkout + limpeza)...');
    if (!onWorkingBranch && originalBranch) {
      // Best-effort cleanup: no signal (Task 6 decision) — the push already
      // succeeded; a cancel here must not skip-or-fail the return home.
      try {
        await this.git.checkout(projectPath, originalBranch);
        this._gitCache = {};
      } catch (_e) { /* best-effort return to the working branch */ }
    }

    return { pushedBranch: targetBranch, localSha: headBeforeMerge };
  }

  /**
   * Conflict-file list from a (possibly provider-wrapped) MergeConflictError.
   *
   * @param {Error} err
   * @returns {string[]|null} filepaths, or null when the error is not a
   *   merge conflict (caller must rethrow).
   */
  _extractConflictFiles(err) {
    const isConflict = err.code === 'MergeConflictError' ||
      err.name === 'MergeConflictError' ||
      (err.cause && (err.cause.code === 'MergeConflictError' || err.cause.name === 'MergeConflictError'));
    if (!isConflict) {
      return null;
    }
    // the legacy provider delivers data either as string[] or as an OBJECT
    // {filepaths: [...], bothModified, deleteByUs, deleteByTheirs}
    // (T5-1) — both carry the conflicted paths.
    const filepathsOf = (data) => {
      if (Array.isArray(data)) {
        return data;
      }
      if (data && typeof data === 'object' && Array.isArray(data.filepaths)) {
        return data.filepaths;
      }
      return null;
    };
    return filepathsOf(err.data) ??
      (err.cause ? filepathsOf(err.cause.data) : null) ?? [];
  }

  _isPushRejected(err) {
    const msg = (err && err.message) || '';
    const code = err && (err.code || (err.cause && err.cause.code));
    // "cannot lock ref"/"incorrect old value provided"/"remote rejected":
    // non-fast-forward RACE — the origin advanced between the ref
    // advertisement and the git-receive-pack POST (T11-D1). Same remedy as
    // any other rejection: typed PUSH_REJECTED so the renderer offers
    // "Atualizar primeiro".
    return code === 'PushRejectedError' ||
      msg.includes('non-fast-forward') ||
      msg.includes('fetch first') ||
      msg.includes('cannot lock ref') ||
      msg.includes('incorrect old value') ||
      msg.includes('[remote rejected]') ||
      msg.includes('remote rejected') ||
      /\b409\b/.test(msg);
  }

  /**
   * Whether a git.push failure is TRANSIENT and safe to retry
   * (publish-update-resilience Task 8 — the retry whitelist).
   *
   * Never retriable (idempotency / Task-6 contracts):
   *  - user cancel: AbortError/ABORT_ERR, an aborted signal, or the
   *    cancel flag up — cancel must stay a cancelled result, never a
   *    retry (characterization Block 2);
   *  - typed PUSH_REJECTED / PUSH_FORBIDDEN GitFlowError and anything
   *    _isPushRejected recognises (PushRejectedError, non-fast-forward,
   *    fetch first, cannot lock ref, remote rejected incl. GH001
   *    large-file stderr, 409);
   *  - T5 classes auth / large_file / conflict.
   *
   * Retriable: T5 classes timeout | network, the legacy provider's empty-payload
   * pack-response ParseError (the client-side signature of a connection
   * dropped mid-push — the server died before "unpack ok"), and the
   * legacy provider evidence in gitOperations._isRetriablePushError
   * (ECONNRESET/ETIMEDOUT/ENOTFOUND codes, HTTP 5xx responses).
   *
   * @param {Error} error - Error thrown by git.push
   * @param {AbortSignal} [signal] - The flow's cancellation signal
   * @returns {boolean} True when the push may be retried
   */
  _isTransientPushError(error, signal) {
    if (!error) return false;
    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return false;
    if (signal && signal.aborted) return false;
    if (this.isCancelRequested()) return false;
    if (error.name === 'GitFlowError' &&
        (error.code === 'PUSH_REJECTED' || error.code === 'PUSH_FORBIDDEN')) return false;
    if (this._isPushRejected(error)) return false;
    const errorType = _classifyError ? _classifyError(error) : 'unknown';
    if (errorType === 'timeout' || errorType === 'network') return true;
    // the legacy provider's signature of a connection dropped mid-push: the pack
    // response ends BEFORE "unpack ok" (ParseError on the raw error; the
    // provider wrap copies it into GitError.stderr/cause). Only the
    // empty-payload form is transient — a present-but-garbage payload
    // stays unknown.
    const truncatedDrop = (e) => Boolean(e) && (
      /Expected "unpack ok"[^\n]*but received ""/.test(`${e.message || ''} ${e.stderr || ''}`)
    );
    if (truncatedDrop(error) || truncatedDrop(error.cause)) return true;
    if (this.gitOps && typeof this.gitOps._isRetriablePushError === 'function') {
      return Boolean(this.gitOps._isRetriablePushError(error));
    }
    return false;
  }

  /**
   * Push with transient-failure retry (publish-update-resilience Task 8).
   * Wires MAX_PUBLISH_RETRIES into the push step of the publish cores:
   * up to 2 retries (3 attempts) for TRANSIENT failures only, backoff
   * 1s then 2s. Deterministic refusals and cancels rethrow on the FIRST
   * attempt (single-attempt contract frozen by publish-flow suites).
   *
   * Per attempt: renew the lock heartbeat (Task 6), _raceTimeout with
   * STEP_TIMEOUT_PUSH_MS, live onProgress transfer events. Each retry
   * re-emits the SAME stage with a custom "Tentativa N/3…" message —
   * stageIndex never changes between attempts (Task 2 invariant).
   *
   * Order with Task 7 auto-restore: _restoreOnFailure runs in the core
   * wrappers' failure cleanup, i.e. only AFTER this helper exhausts its
   * retries and rethrows — VERIFY_THEN_RESTORE (ls-remote via
   * gitSafety.verifyRemoteState) always sees the post-exhaustion state.
   *
   * On exhaustion the ORIGINAL last error is rethrown (not a wrapper):
   * the T5 enrichment and the T7 matrix must classify it exactly as
   * they would without retries (e.g. timeout → VERIFY_THEN_RESTORE).
   *
   * @param {string} projectPath - Repository directory
   * @param {Object} pushOptions - git.push options (remote/branch/remoteRef/auth)
   * @param {{op?: object, signal?: AbortSignal, label?: string}} [ctx]
   * @returns {Promise<void>}
   */
  async _pushWithTransientRetry(projectPath, pushOptions, ctx = {}) {
    const { op, signal, label } = ctx;
    const maxAttempts = 1 + (this.MAX_PUBLISH_RETRIES || 2);
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        this._emitStage(op, 'pushing', `Tentativa ${attempt}/${maxAttempts}…`);
      }
      this._renewHeartbeat();
      try {
        await this._raceTimeout(
          this.git.push(projectPath, {
            ...pushOptions,
            force: false,
            ...(signal ? { signal } : {}),
            ...(op ? { onProgress: (evt) => this._emitTransferProgress(op, evt) } : {}),
          }),
          this.STEP_TIMEOUT_PUSH_MS,
          `push ${label || pushOptions.branch || ''}`,
        );
        if (attempt > 1) {
          this.sendOutput(`✅ Push concluído na tentativa ${attempt}/${maxAttempts}.`);
        }
        return;
      } catch (error) {
        lastError = error;
        if (!this._isTransientPushError(error, signal)) throw error;
        if (attempt === maxAttempts) break;
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        this.logger?.info?.('[push-transient-retry] transient failure, will retry', {
          attempt, delayMs, message: error.message,
        });
        this.sendOutput(
          `⚠️ Push falhou (tentativa ${attempt}/${maxAttempts}): ${error.message}. ` +
          `Nova tentativa em ${delayMs / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    this.logger?.error?.('[push-transient-retry] exhausted all attempts', {
      maxAttempts, lastErrorMessage: lastError && lastError.message,
    });
    throw lastError;
  }

  _isMergeNotSupported(err) {
    const code = err && (err.code || (err.cause && err.cause.code));
    return code === 'MergeNotSupportedError' ||
      /Merges with conflicts are not supported yet/.test((err && err.message) || '') ||
      /Merges with conflicts are not supported yet/.test((err && err.cause && err.cause.message) || '');
  }

  /**
   * Raw provider behind the GitService facade. gitConflictDetect dispatches
   * on provider CAPABILITIES (mergeTree/readTree/mergeBase), so it needs the
   * provider itself, not the facade.
   * @returns {object} GitProvider instance
   */
  _gitProvider() {
    const svc = this.git;
    return typeof svc._resolve === 'function' ? svc._resolve() : svc;
  }

  /**
   * Pre-merge conflict gate (Task 3). Runs detectMergeConflicts (zero
   * mutation — see gitConflictDetect.js) right before a flow would merge.
   *
   * Fail-open: if detection itself throws (unexpected repo shape), the flow
   * falls through to the historical auto-resolution behavior instead of
   * blocking the user.
   *
   * @param {string} projectPath
   * @param {string} theirRef - ref that would be merged into HEAD
   * @returns {Promise<{files: string[], ours: string, theirs: string, mergeBase: string|null}|null>}
   *   pending payload when a REAL conflict exists, null otherwise
   */
  async _conflictGate(projectPath, theirRef) {
    if (!_detectMergeConflicts) {
      return null;
    }
    let detect;
    try {
      detect = await _detectMergeConflicts(
        { provider: this._gitProvider(), repoPath: projectPath },
        theirRef,
      );
    } catch (err) {
      this.logger.warn(`Conflict detection failed (fail-open to auto merge): ${err.message}`);
      return null;
    }
    if (!detect || !detect.hasConflicts) {
      return null;
    }
    return { files: detect.files, ours: detect.ours, theirs: detect.theirs, mergeBase: detect.mergeBase };
  }

  /**
   * Winning merge side for a user-chosen conflict strategy, translated by
   * the provider into `git merge -X ours|theirs`.
   *
   * `localIsOurs` tells which MERGE side holds the "local" content:
   *  - refresh / working-branch publish / publish-main(ours=main →
   *    "local" = our side): true
   *  - cross-branch publish (ours = target/remote state, theirs = the
   *    local commits): false — the mapping flips so MERGE_LOCAL still
   *    means "the user's local edits win".
   *
   * @param {string} strategy - one of CONFLICT_STRATEGIES
   * @param {boolean} [localIsOurs=true]
   * @returns {{side: 'ours'|'theirs'}}
   */
  _conflictDriverFor(strategy, localIsOurs = true) {
    const wantLocal = strategy === 'MERGE_LOCAL' || strategy === 'FULL_LOCAL';
    const oursFamilyWins = wantLocal === localIsOurs;
    return { side: oursFamilyWins ? 'ours' : 'theirs' };
  }

  /**
   * Binary-conflict fallback (port of the former resolveBinaryOurs/Theirs
   * helpers): materialize the winning side's blob into the
   * working tree and stage it. Provider-agnostic — goes through the
   * GitService facade (readBlob/add).
   *
   * @param {string} projectPath - repository working tree root
   * @param {string} filepath - conflicted file, relative to the repo
   * @param {string} oid - commit/tree/blob oid of the winning side
   * @returns {Promise<void>}
   */
  async _resolveBinarySide(projectPath, filepath, oid) {
    const { blob } = await this.git.readBlob(projectPath, oid, { filepath });
    require('fs').writeFileSync(path.join(projectPath, filepath), Buffer.from(blob));
    await this.git.add(projectPath, filepath);
  }

  /**
   * Mint a single-use resumeToken for a pending conflict and build the typed
   * CONFLICT_PENDING IPC result consumed by the Task 4 modal.
   *
   * Result shape (STABLE contract — renderer depends on it):
   *   {
   *     success: false,
   *     code: 'CONFLICT_PENDING',
   *     flow: 'publish' | 'refresh' | 'publish-main',
   *     files: string[],               // conflicted paths ([] = unrelated histories)
   *     strategies: string[],          // always the 4 CONFLICT_STRATEGIES
   *     resumeToken: string,           // single-use, 15min TTL
   *     expiresAt: number,             // epoch ms
   *     error: string,                 // user-facing message
   *     detail: { ours, theirs, mergeBase },
   *   }
   *
   * The internal registry entry additionally carries `projectId` (Task 7):
   * the auto-restore engine invalidates a repo's tokens selectively when
   * it moves the repository state out from under a pending decision.
   *
   * @param {string} projectPath
   * @param {'publish'|'refresh'|'publish-main'} flow
   * @param {{files: string[], ours: string, theirs: string, mergeBase: string|null}} pending
   * @param {object} resumeCtx - { auth, author, who?, targetBranch? } to re-run the flow
   * @param {string|number|null} [projectId=null] - project the flow runs for
   * @returns {object} typed IPC result
   */
  _mintConflictPending(projectPath, flow, pending, resumeCtx, projectId = null) {
    const token = require('crypto').randomBytes(16).toString('hex');
    const expiresAt = Date.now() + RESUME_TOKEN_TTL_MS;
    this._pendingConflicts.set(token, {
      ...resumeCtx,
      projectId: projectId === undefined ? null : projectId,
      projectPath,
      flow,
      createdAt: Date.now(),
      expiresAt,
    });
    this.logger.info(`⛔ Conflito real no fluxo ${flow} (${pending.files.length} arquivo(s)) — aguardando decisão do usuário`);
    this.sendOutput('⚠️ Conflito de mesclagem detectado — escolha como resolver para continuar.');
    return {
      success: false,
      code: 'CONFLICT_PENDING',
      flow,
      files: pending.files,
      strategies: [...CONFLICT_STRATEGIES],
      resumeToken: token,
      expiresAt,
      detail: { ours: pending.ours, theirs: pending.theirs, mergeBase: pending.mergeBase },
      error: 'Conflito de mesclagem detectado. Escolha uma estratégia para continuar (as duas versões ficam no histórico).',
    };
  }

  /**
   * Selectively invalidate every pending-conflict token of one repository
   * (Task 7 auto-restore step 4). The restore moves the repo state out
   * from under any pending decision (the frozen `detail.ours/theirs`
   * OIDs go stale), so the tokens must die — a later resolve against an
   * invalidated token returns the frozen INVALID_TOKEN result.
   *
   * Entries are matched by projectId (canonical) OR by projectPath
   * (entries minted before Task 7 carry no projectId).
   *
   * @param {string|number|null} projectId
   * @param {string} [projectPath]
   * @returns {string[]} invalidated tokens
   */
  invalidateConflictsForProject(projectId, projectPath) {
    const invalidated = [];
    for (const [token, entry] of Array.from(this._pendingConflicts.entries())) {
      const byId =
        projectId !== null && projectId !== undefined &&
        entry.projectId === projectId;
      const byPath = Boolean(projectPath) && entry.projectPath === projectPath;
      if (byId || byPath) {
        this._pendingConflicts.delete(token);
        invalidated.push(token);
      }
    }
    if (invalidated.length > 0) {
      this.logger.info(`⛔ ${invalidated.length} token(s) de conflito invalidados (restore moveu o estado do repositório)`);
    }
    return invalidated;
  }

  /**
   * Wrap object-style ops so a MISSING `refs/remotes/origin/<branch>` resolves
   * to a sentinel OID instead of throwing. gitSafety's assessment maps a
   * throwing resolveRef to hasUnpushed=false; per the plan a missing upstream
   * must mean "everything is unpushed" so the mandatory backup is created
   * even on a clean tree. gitSafety.js itself is frozen for this task
   * (see .omo/notepads/git-sync-strategy/learnings.md) — the compensation
   * lives here, scoped to the publish flow only.
   */
  _opsTreatMissingUpstreamAsUnpushed(ops, targetBranch) {
    const remoteRef = 'refs/remotes/origin/' + targetBranch;
    const NO_UPSTREAM_OID = '0000000000000000000000000000000000000000';
    return {
      ...ops,
      resolveRef: async (args) => {
        if (args && args.ref === remoteRef) {
          try {
            return await ops.resolveRef(args);
          } catch (_e) {
            return NO_UPSTREAM_OID;
          }
        }
        return ops.resolveRef(args);
      },
    };
  }

  /**
   * Backup-guarded publish (Task 6): mandatory blocking backup BEFORE any
   * mutating provider call, then the commit-first merge publish core, then
   * best-effort pruning. The backup is NEVER deleted on success (7-day
   * retention, Task 4). No hard reset runs post-push — the merge already
   * left the working branch in sync with origin/target.
   *
   * Task 7: captures the ORIGINAL state (branch/HEAD pre-WIP) and, once
   * the flow backup exists, records `op.flowContext` — the auto-restore
   * engine's target (preOpBackupName = the FIRST/flow backup, never an
   * intermediate _safeResetToOrigin backup).
   *
   * @returns {Promise<{success: boolean, pushed?: boolean, branch?: string, commitSha?: string, error?: string}>}
   */
  async _runBackupGuardedPublish(projectPath, targetBranch, { commitMessage, auth, author, conflictStrategy, op }) {
    const ops = this._safetyOps();
    if (!this.gitSafety || !ops) {
      throw new Error('GitSafety indisponível — publicação recusada (backup obrigatório)');
    }
    // Task 7: original state BEFORE any mutation (the WIP commit below is
    // the first mutating command of the flow).
    const originalBranch = (await this.git.currentBranch(projectPath, { cache: this._gitCache })) || targetBranch;
    const originalHead = await this.git.resolveRef(projectPath, 'HEAD');
    // Commit-first, BEFORE the backup: _createBackup snapshots a dirty tree
    // onto the backup branch and then force-checks the working branch back
    // out, which WIPES uncommitted edits from the working tree. Committing
    // first keeps the user's edits in the branch history, and the fresh
    // commit is unpushed — forcing the backup branch to exist.
    let localSha = null;
    if (commitMessage) {
      this.sendOutput('📝 Preparando commit...');
      localSha = await this._commitAll(projectPath, commitMessage, author);
    }
    const { result } = await this.gitSafety.withMandatoryBackup(
      this._opsTreatMissingUpstreamAsUnpushed(ops, targetBranch),
      require('fs'),
      projectPath,
      (backupInfo) => {
        if (op) {
          op.flowContext = {
            projectId: op.projectId,
            operationId: op.operationId,
            projectPath,
            targetBranch,
            originalBranch,
            originalHead,
            preOpBackupName: backupInfo ? backupInfo.name : null,
            ...(author ? { author } : {}),
            ...(auth ? { auth } : {}),
          };
        }
        return this._publishCore(projectPath, targetBranch, {
          localSha,
          auth,
          signal: this.getAbortSignal(),
          author,
          conflictStrategy,
          op,
        });
      },
      { branch: targetBranch }
    );

    if (result && result.conflictPending) {
      return this._mintConflictPending(projectPath, 'publish', result.conflictPending, {
        targetBranch, auth, author,
      }, op ? op.projectId : null);
    }

    if (result && result.cancelled) {
      return { success: false, cancelled: true, message: 'Operation cancelled by user' };
    }

    try {
      await this.gitSafety.pruneOldBackups(ops, require('fs'), projectPath);
    } catch (pruneErr) {
      this.logger.warn('Backup pruning failed (best-effort):', pruneErr.message);
    }

    return { success: true, pushed: true, branch: targetBranch, commitSha: result.localSha };
  }

  /**
   * Map a publish-flow error to the IPC result shape (typed codes for the
   * renderer: PUSH_REJECTED, BACKUP_FAILED, STATUS_MATRIX_FAILED).
   */
  _publishErrorToResult(error) {
    if (error.name === 'AbortError' || (error.cause && error.cause.name === 'AbortError')) {
      // User cancel keeps the frozen renderer-facing message (Block 2
      // characterization); non-user aborts (lock timeout) say "aborted".
      return {
        success: false,
        cancelled: true,
        message: this.isCancelRequested()
          ? 'Operation cancelled by user'
          : 'Operation aborted',
      };
    }
    if (error.name === 'GitFlowError' || error.name === 'GitSafetyError') {
      this.sendOutput(`❌ ${error.message}`);
      return enrichFailureResult({ success: false, code: error.code, error: error.message }, error);
    }
    let errorMessage = error.message || 'Erro desconhecido ao publicar';
    let code;
    if (this._isPushRejected(error)) {
      code = 'PUSH_REJECTED';
      errorMessage = 'O repositório remoto tem novidades. Clique em Atualizar primeiro e depois publique novamente.';
    } else if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('authentication')) {
      errorMessage = 'Erro de autenticação. Faça login novamente.';
    } else if (errorMessage.includes('network') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT')) {
      errorMessage = 'Erro de rede. Verifique sua conexão.';
    }
    this.sendOutput(`❌ Erro ao publicar: ${errorMessage}`);
    const result = { success: false, error: errorMessage };
    if (code) result.code = code;
    return enrichFailureResult(result, error);
  }

  /**
   * Push to a branch using the unified publish flow (Task 6):
   * lock → mandatory backup → commit-all → fetch (deepen on divergence) →
   * merge local-wins → push (force:false, PUSH_REJECTED typed error) →
   * best-effort pruning. Working tree is never reset.
   *
   * @param {string} projectPath - Path to the git repository
   * @param {string} targetBranch - Target branch name
   * @param {string|null} [commitMessage=null] - If provided, commit all changes before pushing
   * @returns {Promise<{success: boolean, pushed?: boolean, branch?: string, commitSha?: string, cancelled?: boolean, error?: string, code?: string}>}
   */
  async gitPushToBranch(projectPath, targetBranch, commitMessage = null, projectId = null) {
    if (!this.acquireGitLock()) {
      this.sendOutput('⚠️ Operação Git já em andamento. Aguarde...');
      return { success: false, error: 'Git operation already in progress. Please wait.' };
    }
    const op = this._beginOperation(projectId, 'publish-preview');
    try {
      this._gitCache = {};
      this._emitStage(op, 'preparing', 'Verificando status do repositório...');

      const [token, userConfigured] = await Promise.all([
        this.gitOps.getGitHubToken(),
        this.gitOps.configureGitForUser(projectPath),
      ]);
      if (!token) {
        this.sendOutput('❌ Autenticação GitHub necessária. Faça login novamente.');
        return this._emitTerminalFromResult(op, { success: false, error: 'Autenticação GitHub necessária. Faça login novamente.' });
      }
      if (!userConfigured) {
        this.sendOutput('⚠️ Não foi possível configurar usuário git. Continuando com configuração existente...');
        this.logger.warn('Could not configure git user, proceeding with existing config');
      }

      // Preflight stays informational only — the body's own fetch/push
      // surfaces real auth/network errors.
      if (this.gitPreflight) {
        try {
          const preflight = await this.gitPreflight.runPreflightForPreview(null, projectPath);
          if (preflight.warnings && preflight.warnings.length > 0) {
            for (const w of preflight.warnings) this.sendOutput(`⚠️ ${w.message}`);
          }
        } catch (preflightErr) {
          if (preflightErr && preflightErr.name === 'AbortError') {
            return this._emitTerminalFromResult(op, { success: false, cancelled: true, message: 'Operation aborted' });
          }
          this.logger.warn('gitPushToBranch: preflight threw (continuing):', preflightErr.message);
        }
      }

      const auth = { token };
      const [authorName, authorEmail] = await Promise.all([
        this.git.getConfig(projectPath, 'user.name', { cache: this._gitCache }).then((v) => v || 'documental'),
        this.git.getConfig(projectPath, 'user.email', { cache: this._gitCache }).then((v) => v || 'documental@app'),
      ]);

      const result = await this._runBackupGuardedPublish(projectPath, targetBranch, {
        commitMessage,
        auth,
        author: { name: authorName, email: authorEmail },
        op,
      });
      return this._emitTerminalFromResult(op, await this._restoreOnFailure(op, projectPath, result));
    } catch (error) {
      this.logger.error('Error pushing to branch:', error);
      const failResult = this._publishErrorToResult(error);
      return this._emitTerminalFromResult(
        op,
        await this._restoreOnFailure(op, projectPath, failResult, error)
      );
    } finally {
      this._gitCache = {};
      this.releaseGitLock();
    }
  }

  /**
   * List remote branches
   * @param {string} projectPath - Path to the git repository
   * @returns {Promise<Array<string>>} List of remote branch names
   */
  /**
   * Refresh the local preview workspace from origin/preview (Task 7
   * rewrite: WIP auto-commit + merge, THE END OF THE HARD RESET).
   *
   * Unified with the Task 6 publish pattern (_runBackupGuardedPublish /
   * _publishCore):
   *  1. Lock + WIP auto-commit of uncommitted changes (message
   *     `WIP by <login> at <ISO>`) — the "discard changes" option is
   *     GONE; committing first is what protects the dirty tree (the
   *     backup snapshot force-checks the working branch back out).
   *  2. Mandatory blocking backup (withMandatoryBackup, Task 5); a
   *     missing upstream counts as "everything unpushed".
   *  3. Shallow fetch origin/preview; deepen when diverged so a
   *     merge-base exists.
    *  4. Diverged (and not merely local-ahead): merge origin/preview with
    *     -X ours (LOCAL wins conflicting hunks; remote
    *     non-conflicting changes are integrated); binary conflicts fall
    *     back to _resolveBinarySide. NO hard reset on ANY path.
   *  5. HEAD == upstream after merge (or already) → done.
   *  6. Best-effort pruneOldBackups (7-day retention, Task 4).
   *
   * Missing upstream: when origin/preview does not exist (new repo,
   * first sync), a typed `NO_UPSTREAM` GitFlowError guides the user to
   * publish first — refresh cannot pull from a branch that was never
   * pushed.
   *
   * @param {number|string} projectId - Project ID (resolved to working directory).
   * @param {boolean} [force=false] - Kept for IPC signature compatibility; no longer discards anything.
   * @returns {Promise<{success: boolean, branch?: string, code?: string, cancelled?: boolean, error?: string}>}
   */
  async gitRefresh(projectId, force = false) {
    void force; // Refresh is always safe now — nothing to discard.
    let projectPath;
    try {
      projectPath = await this.getProjectPath(projectId);
    } catch (error) {
      this.sendOutput(`❌ Erro ao resolver caminho do projeto: ${error.message}`);
      return { success: false, error: error.message };
    }

    // Pre-lock: resolve token so missing-token fails fast without holding the
    // lock. Preflight is intentionally NOT invoked here: refresh is a recovery
    // operation that must run even when publish-preflight would block. The
    // mandatory backup wrapper in _runRefreshFlow is the authoritative
    // data-loss guard.
    let token = null;
    try {
      token = await this.gitOps.getGitHubToken();
    } catch (tokenErr) {
      this.logger.warn('gitRefresh: token lookup failed:', tokenErr.message);
    }

    if (!this.acquireGitLock()) {
      this.sendOutput('⚠️ Operação Git já em andamento. Aguarde...');
      return { success: false, error: 'Git operation already in progress. Please wait.' };
    }
    // operationId is born with the lock — one id per operation (Task 2).
    const op = this._beginOperation(projectId, 'refresh');
    try {
      this._emitStage(op, 'preparing', 'Preparando atualização (commit WIP + backup)...');
      const current = await this.git.currentBranch(projectPath, { cache: this._gitCache });

      if (current !== BRANCH_PREVIEW) {
        // Dirty files carry over the checkout and are committed immediately
        // after as WIP — no more DIRTY_LOCAL blocking / discard flow.
        this.sendOutput(`📥 Mudando para branch ${BRANCH_PREVIEW}...`);
        await this._raceTimeout(
          this.git.checkout(projectPath, BRANCH_PREVIEW, { signal: this.getAbortSignal() }),
          this.STEP_TIMEOUT_CHECKOUT_MS,
          `checkout ${BRANCH_PREVIEW}`,
        );
      }

      const [authorName, authorEmail] = await Promise.all([
        this.git.getConfig(projectPath, 'user.name', { cache: this._gitCache }).then((v) => v || 'documental'),
        this.git.getConfig(projectPath, 'user.email', { cache: this._gitCache }).then((v) => v || 'documental@app'),
      ]);

      // Login for the WIP message (best-effort — config user is the fallback).
      let login = null;
      try {
        const userInfo = await this.gitOps.getGitHubUserInfo();
        login = (userInfo && userInfo.login) || null;
      } catch (_loginErr) { /* best-effort */ }

      const result = await this._runRefreshFlow(projectPath, {
        auth: token ? { token } : undefined,
        author: { name: authorName, email: authorEmail },
        who: login || authorName,
        op,
      });
      return this._emitTerminalFromResult(op, await this._restoreOnFailure(op, projectPath, result));
    } catch (error) {
      const failResult = this._refreshErrorToResult(error);
      // Task 7: auto-restore runs INSIDE the lock, BEFORE the terminal
      // event (so the terminal can carry `restored`).
      return this._emitTerminalFromResult(
        op,
        await this._restoreOnFailure(op, projectPath, failResult, error)
      );
    } finally {
      this._gitCache = {};
      this.releaseGitLock();
    }
  }

  /**
   * Map a refresh-flow error to the IPC failure result (extracted from
   * gitRefresh's catch, Task 7, so the auto-restore hook can run between
   * result construction and terminal emission). Same mapping as before:
   * AbortError → cancelled (frozen Block-2 message), GitFlowError/
   * GitSafetyError → typed code, else friendly-message fallbacks.
   * @private
   */
  _refreshErrorToResult(error) {
    if (error.name === 'AbortError' || (error.cause && error.cause.name === 'AbortError')) {
      return {
        success: false,
        cancelled: true,
        message: this.isCancelRequested() ? 'Operation cancelled by user' : 'Operation aborted',
      };
    }
    if (error.name === 'GitFlowError' || error.name === 'GitSafetyError') {
      this.sendOutput(`❌ ${error.message}`);
      return enrichFailureResult({ success: false, code: error.code, error: error.message }, error);
    }
    this.logger.error('Error in gitRefresh:', error);
    let errorMessage = error.message || 'Erro desconhecido ao atualizar';
    if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('authentication')) {
      errorMessage = 'Erro de autenticação. Faça login novamente.';
    } else if (errorMessage.includes('network') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT')) {
      errorMessage = 'Erro de rede. Verifique sua conexão.';
    }
    this.sendOutput(`❌ Erro ao atualizar: ${errorMessage}`);
    return enrichFailureResult({ success: false, error: errorMessage }, error);
  }

  /**
   * Backup-guarded refresh body (Task 7): WIP commit BEFORE the mandatory
   * backup (Task 6 ordering — the backup snapshot force-checkout wipes
   * uncommitted edits), then the fetch/merge core, then best-effort
   * pruning. The backup is NEVER deleted on success (7-day retention).
   *
   * Task 7 (auto-restore): captures the original state pre-WIP and records
   * `op.flowContext` once the flow backup exists.
   *
   * @returns {Promise<{success: boolean, branch?: string, cancelled?: boolean, error?: string, code?: string}>}
   */
  async _runRefreshFlow(projectPath, { auth, author, who, conflictStrategy, op }) {
    const ops = this._safetyOps();
    if (!this.gitSafety || !ops) {
      throw new Error('GitSafety indisponível — atualização recusada (backup obrigatório)');
    }

    // Task 7: original state BEFORE the WIP commit (first mutation).
    const originalBranch = (await this.git.currentBranch(projectPath, { cache: this._gitCache })) || BRANCH_PREVIEW;
    const originalHead = await this.git.resolveRef(projectPath, 'HEAD');

    // 1. WIP auto-commit FIRST: protects the dirty tree (see class JSDoc)
    //    and makes the commit "unpushed", forcing the backup branch.
    const wipMessage = `WIP by ${who} at ${new Date().toISOString()}`;
    this.sendOutput('📝 Commitando alterações não salvas (WIP)...');
    await this._commitAll(projectPath, wipMessage, author);

    // 2. Mandatory blocking backup around the mutating fetch/merge core.
    const { result } = await this.gitSafety.withMandatoryBackup(
      this._opsTreatMissingUpstreamAsUnpushed(ops, BRANCH_PREVIEW),
      require('fs'),
      projectPath,
      (backupInfo) => {
        if (op) {
          op.flowContext = {
            projectId: op.projectId,
            operationId: op.operationId,
            projectPath,
            targetBranch: BRANCH_PREVIEW,
            originalBranch,
            originalHead,
            preOpBackupName: backupInfo ? backupInfo.name : null,
            ...(author ? { author } : {}),
            ...(auth ? { auth } : {}),
          };
        }
        return this._refreshCore(projectPath, {
          auth,
          signal: this.getAbortSignal(),
          author,
          conflictStrategy,
          op,
        });
      },
      { branch: BRANCH_PREVIEW, author }
    );

    if (result && result.conflictPending) {
      return this._mintConflictPending(projectPath, 'refresh', result.conflictPending, {
        auth, author, who,
      }, op ? op.projectId : null);
    }

    if (result && result.cancelled) {
      return { success: false, cancelled: true, message: 'Operation cancelled by user' };
    }

    // 3. Best-effort pruning (failure never fails the refresh).
    try {
      await this.gitSafety.pruneOldBackups(ops, require('fs'), projectPath);
    } catch (pruneErr) {
      this.logger.warn('Backup pruning failed (best-effort):', pruneErr.message);
    }

    return result;
  }

  /**
   * Refresh core (Task 7): fetch origin/preview (deepen on divergence),
   * merge LOCAL-wins when diverged. NO hard reset on any path — HEAD
   * only ever moves forward via merge commits.
   *
   * @returns {Promise<{success: boolean, branch?: string, cancelled?: boolean, error?: string, code?: string}>}
   */
  async _refreshCore(projectPath, { auth, signal, author, conflictStrategy, op }) {
    const headBefore = await this.git.resolveRef(projectPath, 'HEAD');

    if (this.isCancelRequested()) {
      return { success: false, cancelled: true, message: 'Operation cancelled by user' };
    }

    this._emitStage(op, 'fetching', `Buscando alterações de origin/${BRANCH_PREVIEW}...`);
    this.sendOutput(`📥 Buscando alterações de origin/${BRANCH_PREVIEW}...`);
    try {
      this._renewHeartbeat();
      await this._raceTimeout(
        this.git.fetch(projectPath, {
          remote: 'origin', ref: BRANCH_PREVIEW,
          singleBranch: true, depth: 1,
          ...(signal ? { signal } : {}), ...(auth ? { auth } : {}),
          ...(op ? { onProgress: (evt) => this._emitTransferProgress(op, evt) } : {}),
        }),
        this.STEP_TIMEOUT_FETCH_MS,
        `fetch origin/${BRANCH_PREVIEW}`,
      );
    } catch (fetchErr) {
      const msg = fetchErr.message || '';
      if (!msg.includes('Could not find') && !msg.includes('not found') && !msg.includes('404')) {
        throw fetchErr;
      }
      // Fetch says the remote branch is missing — typed friendly error.
    }
    this._gitCache = {};

    let originOid = null;
    try {
      originOid = await this.git.resolveRef(projectPath, `refs/remotes/origin/${BRANCH_PREVIEW}`);
    } catch (_e) { /* remote ref absent — handled below */ }

    if (!originOid) {
      throw new GitFlowError(
        'NO_UPSTREAM',
        `A branch remota origin/${BRANCH_PREVIEW} ainda não existe. Use Publicar primeiro para criar a branch no repositório remoto; nenhuma alteração local foi perdida.`,
      );
    }

    if (originOid === headBefore) {
      this.sendOutput(`✅ Já atualizado com origin/${BRANCH_PREVIEW}`);
      return { success: true, branch: BRANCH_PREVIEW, upToDate: true };
    }

    // Is the remote tip already an ancestor of HEAD (local ahead only)?
    // Nothing to integrate — refresh is done.
    let localAhead = false;
    try {
      localAhead = await this.git.canFastForward(projectPath, {
        ref: `origin/${BRANCH_PREVIEW}`, target: 'HEAD',
      });
    } catch (_ffErr) { localAhead = false; }
    if (localAhead) {
      this.sendOutput('⚡ Local já está à frente do remoto — nada a atualizar.');
      return { success: true, branch: BRANCH_PREVIEW, ahead: true };
    }

    // Diverged: deepen the depth:1 fetch so the merge-base exists
    // (shallow tips have no common history to merge from). Best-effort —
    // the merge below surfaces the real error if any.
    try {
      this._renewHeartbeat();
      await this._raceTimeout(
        this.git.fetch(projectPath, {
          remote: 'origin', ref: BRANCH_PREVIEW, singleBranch: true,
          ...(signal ? { signal } : {}), ...(auth ? { auth } : {}),
          ...(op ? { onProgress: (evt) => this._emitTransferProgress(op, evt) } : {}),
        }),
        this.STEP_TIMEOUT_FETCH_MS,
        `deepen fetch origin/${BRANCH_PREVIEW}`,
      );
      this._gitCache = {};
    } catch (_deepenErr) { /* best-effort */ }

    if (this.isCancelRequested()) {
      return { success: false, cancelled: true, message: 'Operation cancelled by user' };
    }

    this._emitStage(op, 'merging', 'Verificando e mesclando alterações...');

    // Direction contract (anti-inversion): refresh merges origin/preview
    // INTO the local working branch → ours = LOCAL commits → -X ours
    // keeps LOCAL winning conflicting hunks while remote
    // non-conflicting changes are integrated.
    //
    // Task 3: on the auto path, a REAL conflict pauses the flow for a user
    // decision (CONFLICT_PENDING); on resume (conflictStrategy set), the
    // user-chosen driver decides the conflicting hunks.
    if (!conflictStrategy) {
      const gate = await this._conflictGate(projectPath, `origin/${BRANCH_PREVIEW}`);
      if (gate) {
        return { conflictPending: gate };
      }
    }
    const strat = conflictStrategy ? this._conflictDriverFor(conflictStrategy) : null;

    this.sendOutput('🔀 Mesclando alterações (suas alterações vencem conflitos)...');
    try {
      await this._raceTimeout(
        this.git.merge(projectPath, `origin/${BRANCH_PREVIEW}`, {
          ours: BRANCH_PREVIEW,
          fastForward: false,
          // T5-1: stage clean merges + conflict stages in the index BEFORE
          // the legacy provider throws, so the binary fallback commit keeps the
          // remote's clean files (dugite ignores this key).
          abortOnConflict: false,
          ...(strat
            ? { strategy: strat.side }
            : { strategy: 'ours' }),
          message: `Merge refresh${conflictStrategy ? ` (${conflictStrategy})` : ''} (origin/${BRANCH_PREVIEW}) — ${new Date().toISOString()}`,
          author,
          ...(signal ? { signal } : {}),
        }),
        this.STEP_TIMEOUT_MERGE_MS,
        `merge refresh origin/${BRANCH_PREVIEW}`,
      );
    } catch (mergeErr) {
      const conflictFiles = this._extractConflictFiles(mergeErr);
      if (!conflictFiles) {
        throw mergeErr;
      }
      this.sendOutput('⚠️ Conflito binário detectado — usando sua versão.');
      const binaryOid = strat && strat.side === 'theirs' ? originOid : headBefore;
      for (const filepath of conflictFiles) {
        try {
          await this._resolveBinarySide(projectPath, filepath, binaryOid);
        } catch (resolveErr) {
          this.logger.warn(`Could not resolve binary ${filepath}: ${resolveErr.message}`);
        }
      }
      await this.git.commit(
        projectPath,
        `Merge refresh (binary resolved) — ${new Date().toISOString()}`,
        { author, parent: [BRANCH_PREVIEW, originOid], ...(signal ? { signal } : {}) },
      );
    }

    // the legacy provider merge does NOT touch the working tree — materialize
    // HEAD. Safe: this core runs inside withMandatoryBackup (Task 5).
    this._emitStage(op, 'finalizing', 'Finalizando atualização (checkout + limpeza)...');
    await this._raceTimeout(
      this.git.checkout(projectPath, BRANCH_PREVIEW, { force: true, signal }),
      this.STEP_TIMEOUT_CHECKOUT_MS,
      `materialize ${BRANCH_PREVIEW}`,
    );
    this._gitCache = {};

    this.sendOutput(`✅ Atualizado com merge de origin/${BRANCH_PREVIEW}`);
    return { success: true, branch: BRANCH_PREVIEW };
  }

  /**
   * Publish local changes to the preview branch (Task 6 rewrite).
   *
   * Unified with gitPushToBranch into _runBackupGuardedPublish:
   *  1. Lock + mandatory blocking backup (withMandatoryBackup, Task 5);
   *     a missing upstream counts as "everything unpushed".
   *  2. _commitAll — commit-first, always before fetch/merge/push.
   *  3. Shallow fetch; deepen when diverged so a merge-base exists.
    *  4. Merge origin/preview into the working preview branch with
    *     -X ours (LOCAL wins conflicting hunks); binary conflicts
    *     fall back to _resolveBinarySide.
   *  5. Push force:false; rejection → typed PUSH_REJECTED error guiding
   *     the user to "Atualizar primeiro".
   *  6. Success: NO hard reset (the merge already synced), NO backup
   *     deletion — pruneOldBackups runs best-effort (7-day retention).
   *
   * @param {number|string} projectId - Project ID (resolved to working directory).
   * @param {string} commitMessage - Commit message for local changes.
   * @returns {Promise<{success: boolean, branch?: string, commitSha?: string, cancelled?: boolean, error?: string, code?: string}>}
   */
  async gitPublishPreview(projectId, commitMessage) {
    let projectPath;
    try {
      projectPath = await this.getProjectPath(projectId);
    } catch (error) {
      this.sendOutput(`❌ Erro ao resolver caminho do projeto: ${error.message}`);
      return { success: false, error: error.message };
    }

    // Pre-lock: token + user config (fail fast without holding the lock).
    let token = null;
    let userConfigured = false;
    try {
      [token, userConfigured] = await Promise.all([
        this.gitOps.getGitHubToken(),
        this.gitOps.configureGitForUser(projectPath),
      ]);
    } catch (preErr) {
      this.logger.warn('gitPublishPreview: pre-lock setup failed:', preErr.message);
    }
    if (!token) {
      return { success: false, error: 'GitHub authentication required' };
    }

    // Pre-lock: preflight (hard errors block; warnings are surfaced only).
    if (this.gitPreflight) {
      try {
        const preflight = await this.gitPreflight.runPreflightForPreview(projectId, projectPath);
        if (preflight.warnings && preflight.warnings.length > 0) {
          for (const w of preflight.warnings) this.sendOutput(`⚠️ ${w.message}`);
        }
        if (!preflight.canProceed) {
          if (preflight.aborted) {
            return { success: false, cancelled: true, message: 'Operation aborted' };
          }
          const msg = (preflight.errors[0] && preflight.errors[0].message) || 'Preflight falhou';
          this.sendOutput(`❌ ${msg}`);
          return { success: false, error: msg, code: preflight.errors[0] && preflight.errors[0].code };
        }
      } catch (preflightErr) {
        if (preflightErr && preflightErr.name === 'AbortError') {
          return { success: false, cancelled: true, message: 'Operation aborted' };
        }
        this.logger.warn('gitPublishPreview: preflight threw (continuing):', preflightErr.message);
      }
    }

    if (!this.acquireGitLock()) {
      return { success: false, error: 'Git operation already in progress. Please wait.' };
    }

    const op = this._beginOperation(projectId, 'publish-preview');
    try {
      this._emitStage(op, 'preparing', 'Preparando publicação (commit + backup)...');
      if (!userConfigured) {
        this.logger.warn('Could not configure git user, proceeding with existing config');
      }

      // Publish ALWAYS lands on the preview working branch (Task 6 flow:
      // commit-first + merge LOCAL-wins; see _publishCore). Dirty files
      // carry over the checkout and are committed immediately after.
      const current = await this.git.currentBranch(projectPath, { cache: this._gitCache });
      if (current !== BRANCH_PREVIEW) {
        this.sendOutput(`📥 Mudando para branch ${BRANCH_PREVIEW}...`);
        await this._raceTimeout(
          this.git.checkout(projectPath, BRANCH_PREVIEW, { signal: this.getAbortSignal() }),
          this.STEP_TIMEOUT_CHECKOUT_MS,
          `checkout ${BRANCH_PREVIEW}`,
        );
      }

      const [authorName, authorEmail] = await Promise.all([
        this.git.getConfig(projectPath, 'user.name', { cache: this._gitCache }).then((v) => v || 'documental'),
        this.git.getConfig(projectPath, 'user.email', { cache: this._gitCache }).then((v) => v || 'documental@app'),
      ]);

      const result = await this._runBackupGuardedPublish(projectPath, BRANCH_PREVIEW, {
        commitMessage,
        auth: { token },
        author: { name: authorName, email: authorEmail },
        op,
      });
      return this._emitTerminalFromResult(op, await this._restoreOnFailure(op, projectPath, result));
    } catch (error) {
      this.logger.error('Error in gitPublishPreview:', error);
      const failResult = this._publishErrorToResult(error);
      return this._emitTerminalFromResult(
        op,
        await this._restoreOnFailure(op, projectPath, failResult, error)
      );
    } finally {
      this._gitCache = {};
      this.releaseGitLock();
    }
  }

  /**
   * Promote preview branch content to main (Task 8 rewrite:
   * preview-wins merge, return to preview).
   *
   * Workflow (mirrors the Task 6/7 pattern — _runRefreshFlow):
   *  1. Blocking preflight (runPreflightForMain): PREVIEW_NOT_AHEAD,
   *     MAIN_MISSING; a throwing preflight BLOCKS (never catch-and-run).
   *  2. Lock + WIP auto-commit of uncommitted changes (message
   *     `WIP by <login> at <ISO>`) BEFORE the mandatory backup. The WIP
   *     commit is LOCAL to preview — it is NEVER auto-moved to main
   *     (publishing to preview first is the user's job).
   *  3. Mandatory blocking backup (withMandatoryBackup, Task 5).
   *  4. Fetch origin/main + origin/preview (deepen best-effort so the
   *     merge-base exists — pattern of _publishCore).
   *  5. Local main := origin/main via _safeResetToOrigin (backup-guarded,
   *     no raw hard reset), then merge origin/preview into main with the
    *     PREVIEW-WINS contract: in the main←preview merge ours=main,
    *     theirs=preview → -X theirs + _resolveBinarySide keep
    *     PREVIEW winning (the OPPOSITE winner of the refresh flow).
   *  6. Push main force:false; a rejection is a typed GitFlowError
   *     PUSH_REJECTED (Task 6 contract — one attempt, renderer guides
   *     the user to "Atualizar primeiro").
   *  7. Success: return to the `preview` working branch (plain checkout —
   *     already inside the withMandatoryBackup guard; NO hard reset),
   *     then best-effort pruneOldBackups (7-day retention, Task 4).
   *     The backup is NEVER deleted on success.
   *
   * @param {number|string} projectId - Project ID (resolved to working directory).
   * @returns {Promise<{success: boolean, branch?: string, code?: string, cancelled?: boolean, error?: string}>}
   */
  async gitPublishMain(projectId) {
    let projectPath;
    try {
      projectPath = await this.getProjectPath(projectId);
    } catch (error) {
      this.sendOutput(`❌ Erro ao resolver caminho do projeto: ${error.message}`);
      return { success: false, error: error.message };
    }

    // Pre-lock: token (fail fast without the lock).
    let token = null;
    try {
      token = await this.gitOps.getGitHubToken();
    } catch (tokenErr) {
      this.logger.warn('gitPublishMain: token lookup failed:', tokenErr.message);
    }
    if (!token) {
      return { success: false, error: 'GitHub authentication required' };
    }

    // Pre-lock: preflight. Hard-block on MAIN_MISSING (no body-side equivalent)
    // and PREVIEW_NOT_AHEAD (preview must be published first — user requirement:
    // "o usuário só possa fazer publicação para main depois de já ter feito
    // para preview"). Other errors (FETCH_FAILED, PRECEDENCE_CHECK_FAILED) fall
    // through: the body's fetch+merge will surface the real failure.
    if (this.gitPreflight) {
      try {
        const preflight = await this.gitPreflight.runPreflightForMain(projectId, projectPath, this.permissionHandlers);
        if (preflight.warnings && preflight.warnings.length > 0) {
          for (const w of preflight.warnings) this.sendOutput(`⚠️ ${w.message}`);
        }
        if (!preflight.canProceed) {
          if (preflight.aborted) {
            return { success: false, cancelled: true, message: 'Operation aborted' };
          }
          const mainMissing = (preflight.errors || []).find((e) => e.code === 'MAIN_MISSING');
          if (mainMissing) {
            this.sendOutput(`❌ ${mainMissing.message}`);
            return { success: false, code: 'MAIN_MISSING', error: mainMissing.message };
          }
          const previewNotAhead = (preflight.errors || []).find((e) => e.code === 'PREVIEW_NOT_AHEAD');
          if (previewNotAhead) {
            this.sendOutput(`❌ ${previewNotAhead.message}`);
            return { success: false, code: 'PREVIEW_NOT_AHEAD', error: previewNotAhead.message };
          }
        }
      } catch (preflightErr) {
        if (preflightErr && preflightErr.name === 'AbortError') {
          return { success: false, cancelled: true, message: 'Operation aborted' };
        }
        // Guardrail must BLOCK, not catch-and-continue. If the preflight itself
        // throws, we cannot safely proceed — return an error instead of letting
        // the body run and potentially push without verification.
        this.logger.error('gitPublishMain: preflight threw (BLOCKING):', preflightErr);
        this.sendOutput('❌ Não foi possível verificar pré-requisitos para publicar em main.');
        return { success: false, code: 'PREFLIGHT_ERROR', error: preflightErr.message };
      }
    }

    if (!this.acquireGitLock()) {
      return { success: false, error: 'Git operation already in progress. Please wait.' };
    }
    const op = this._beginOperation(projectId, 'publish-main');
    try {
      this._emitStage(op, 'preparing', 'Preparando publicação em main (commit WIP + backup)...');
      const [authorName, authorEmail] = await Promise.all([
        this.git.getConfig(projectPath, 'user.name', { cache: this._gitCache }).then((v) => v || 'documental'),
        this.git.getConfig(projectPath, 'user.email', { cache: this._gitCache }).then((v) => v || 'documental@app'),
      ]);

      // Login for the WIP message (best-effort — config user is the fallback).
      let login = null;
      try {
        const userInfo = await this.gitOps.getGitHubUserInfo();
        login = (userInfo && userInfo.login) || null;
      } catch (_loginErr) { /* best-effort */ }

      const result = await this._runPublishMainFlow(projectPath, {
        auth: { token },
        author: { name: authorName, email: authorEmail },
        who: login || authorName,
        op,
      });
      return this._emitTerminalFromResult(op, await this._restoreOnFailure(op, projectPath, result));
    } catch (error) {
      const failResult = this._publishMainErrorToResult(error);
      // Task 7: auto-restore runs INSIDE the lock, BEFORE the terminal
      // event (so the terminal can carry `restored`).
      return this._emitTerminalFromResult(
        op,
        await this._restoreOnFailure(op, projectPath, failResult, error)
      );
    } finally {
      this._gitCache = {};
      this.releaseGitLock();
    }
  }

  /**
   * Map a publish-main error to the IPC failure result (extracted from
   * gitPublishMain's catch, Task 7 — same mapping as before, moved so the
   * auto-restore hook can run between result construction and terminal
   * emission): AbortError → cancelled, 403/protected-branch → typed
   * PUSH_FORBIDDEN, else _publishErrorToResult.
   * @private
   */
  _publishMainErrorToResult(error) {
    if (error.name === 'AbortError' || (error.cause && error.cause.name === 'AbortError')) {
      return {
        success: false,
        cancelled: true,
        message: this.isCancelRequested() ? 'Operation cancelled by user' : 'Operation aborted',
      };
    }
    const msg = error.message || '';
    const errData = error.data || (error.cause && error.cause.data);
    const isForbidden =
      (errData && (errData.code === 403 || errData.status === 403)) ||
      (error.message && /403|forbidden/i.test(error.message)) ||
      msg.includes('protected branch');
    if (isForbidden) {
      const forbiddenMsg =
        'Push rejeitado pelo GitHub (403). Verifique permissões do token ou se a branch main está protegida.';
      this.sendOutput(`❌ ${forbiddenMsg}`);
      return enrichFailureResult({ success: false, code: 'PUSH_FORBIDDEN', error: forbiddenMsg }, error);
    }
    this.logger.error('Error in gitPublishMain:', error);
    return this._publishErrorToResult(error);
  }

  /**
   * Backup-guarded publish-main body (Task 8): WIP commit BEFORE the
   * mandatory backup (Task 6/7 ordering — the backup snapshot
   * force-checkout wipes uncommitted edits), then the fetch/merge/push
   * core, then best-effort pruning. The backup is NEVER deleted on
   * success (7-day retention) and NO hard reset runs anywhere — the
   * return to preview is a plain checkout already inside the guard.
   *
   * @returns {Promise<{success: boolean, branch?: string, cancelled?: boolean, error?: string, code?: string}>}
   */
  async _runPublishMainFlow(projectPath, { auth, author, who, conflictStrategy, op }) {
    const ops = this._safetyOps();
    if (!this.gitSafety || !ops) {
      throw new Error('GitSafety indisponível — publicação em main recusada (backup obrigatório)');
    }

    // Task 7: original state BEFORE the WIP commit (first mutation).
    const originalBranch = (await this.git.currentBranch(projectPath, { cache: this._gitCache })) || BRANCH_PREVIEW;
    const originalHead = await this.git.resolveRef(projectPath, 'HEAD');

    // 1. WIP auto-commit FIRST: protects the dirty tree and stays on the
    //    LOCAL preview branch (never auto-promoted to main).
    const wipMessage = `WIP by ${who} at ${new Date().toISOString()}`;
    this.sendOutput('📝 Commitando alterações não salvas (WIP)...');
    await this._commitAll(projectPath, wipMessage, author);

    // 2. Mandatory blocking backup around the whole mutating core.
    //    Task 4 (backup dedupe): the created backupInfo is handed INTO
    //    the core so _safeResetToOrigin can reuse this backup instead of
    //    minting a 2nd branch for the same state (< 5 min, same HEAD,
    //    clean tree — conditions enforced in _assessAndBackup).
    //    Task 7 (auto-restore): the SAME backupInfo becomes the flow's
    //    restore target — preOpBackupName is this FIRST backup, never an
    //    intermediate _safeResetToOrigin branch.
    const { result } = await this.gitSafety.withMandatoryBackup(
      this._opsTreatMissingUpstreamAsUnpushed(ops, BRANCH_PREVIEW),
      require('fs'),
      projectPath,
      (backupInfo) => {
        if (op) {
          op.flowContext = {
            projectId: op.projectId,
            operationId: op.operationId,
            projectPath,
            targetBranch: BRANCH_MAIN,
            originalBranch,
            originalHead,
            preOpBackupName: backupInfo ? backupInfo.name : null,
            ...(author ? { author } : {}),
            ...(auth ? { auth } : {}),
          };
        }
        return this._publishMainCore(projectPath, {
          auth,
          signal: this.getAbortSignal(),
          author,
          conflictStrategy,
          op,
          recentBackup: backupInfo,
        });
      },
      { branch: BRANCH_PREVIEW, author }
    );

    if (result && result.conflictPending) {
      return this._mintConflictPending(projectPath, 'publish-main', result.conflictPending, {
        auth, author, who,
      }, op ? op.projectId : null);
    }

    if (result && result.cancelled) {
      return { success: false, cancelled: true, message: 'Operation cancelled by user' };
    }

    // 3. Best-effort pruning (failure never fails the publish).
    try {
      await this.gitSafety.pruneOldBackups(ops, require('fs'), projectPath);
    } catch (pruneErr) {
      this.logger.warn('Backup pruning failed (best-effort):', pruneErr.message);
    }

    return result;
  }

  /**
   * Publish-main core (Task 8): fetch main+preview (deepen best-effort),
   * sync local main to origin/main (backup-guarded, no raw hard reset),
   * merge origin/preview with PREVIEW-WINS, push force:false (typed
   * PUSH_REJECTED), then return to the preview working branch.
   *
   * Task 4: `recentBackup` carries the wrapping flow's backup context
   * into the _safeResetToOrigin calls (2nd-backup dedupe — skipped only
   * while it provably covers the current state).
   *
    * Direction contract (ANTI-INVERSION): in the merge main←preview,
    * ours=main, theirs=preview → -X theirs + _resolveBinarySide
    * keep PREVIEW winning conflicting hunks — the
    * OPPOSITE winner of the refresh flow (which merges preview into the
    * local working branch with -X ours).
   *
   * @returns {Promise<{success: boolean, branch?: string, cancelled?: boolean, error?: string, code?: string}>}
   */
  async _publishMainCore(projectPath, { auth, signal, author, conflictStrategy, op, recentBackup }) {
    if (this.isCancelRequested()) {
      return { success: false, cancelled: true, message: 'Operation cancelled by user' };
    }

    this._emitStage(op, 'fetching', `Buscando origin/${BRANCH_MAIN} e origin/${BRANCH_PREVIEW}...`);
    this.sendOutput(`📥 Buscando origin/${BRANCH_MAIN} e origin/${BRANCH_PREVIEW}...`);
    this._renewHeartbeat();
    await Promise.all([
      this._raceTimeout(
        this.git.fetch(projectPath, { remote: 'origin', ref: BRANCH_MAIN, singleBranch: true, depth: 1, ...(signal ? { signal } : {}), auth, ...(op ? { onProgress: (evt) => this._emitTransferProgress(op, evt) } : {}) }),
        this.STEP_TIMEOUT_FETCH_MS,
        `fetch origin/${BRANCH_MAIN}`,
      ),
      this._raceTimeout(
        this.git.fetch(projectPath, { remote: 'origin', ref: BRANCH_PREVIEW, singleBranch: true, depth: 1, ...(signal ? { signal } : {}), auth, ...(op ? { onProgress: (evt) => this._emitTransferProgress(op, evt) } : {}) }),
        this.STEP_TIMEOUT_FETCH_MS,
        `fetch origin/${BRANCH_PREVIEW}`,
      ),
    ]);
    this._gitCache = {};

    let originMainOid = null;
    try {
      originMainOid = await this.git.resolveRef(projectPath, `refs/remotes/origin/${BRANCH_MAIN}`);
    } catch (_e) { /* handled below */ }
    if (!originMainOid) {
      throw new GitFlowError(
        'MAIN_MISSING',
        `A branch remota origin/${BRANCH_MAIN} não existe. Crie a branch main no repositório remoto antes de publicar.`,
      );
    }
    const theirsOid = await this.git.resolveRef(projectPath, `refs/remotes/origin/${BRANCH_PREVIEW}`);

    // No-op push guard: preview identical to main remotely → nothing to
    // promote (the preflight normally blocks this earlier).
    if (theirsOid === originMainOid) {
      this.sendOutput('⚠️ Nada novo para publicar — preview e main estão idênticos no remoto.');
      return {
        success: false,
        code: 'NOTHING_TO_PUSH',
        error: 'Preview não tem mudanças além de main. Publique em preview primeiro.',
      };
    }

    // Local main := origin/main. Backup-guarded (this whole core runs
    // inside withMandatoryBackup); _safeResetOrCheckout creates the local
    // branch when missing — no raw hard reset anywhere. The flow's own
    // backup is passed as reuse context (Task 4): when it still covers
    // the current state, the 2nd backup branch is skipped.
    this.sendOutput(`🔄 Sincronizando ${BRANCH_MAIN} com origin/${BRANCH_MAIN}...`);
    await this._safeResetToOrigin(projectPath, `origin/${BRANCH_MAIN}`, { author, recentBackup });
    this._gitCache = {};

    // Deepen the depth:1 fetches so the merge-base exists (shallow tips
    // have no common history to merge from). Best-effort — the merge
    // below surfaces the real error if any.
    try {
      this._renewHeartbeat();
      await Promise.all([
        this._raceTimeout(
          this.git.fetch(projectPath, { remote: 'origin', ref: BRANCH_MAIN, singleBranch: true, ...(signal ? { signal } : {}), auth, ...(op ? { onProgress: (evt) => this._emitTransferProgress(op, evt) } : {}) }),
          this.STEP_TIMEOUT_FETCH_MS,
          `deepen fetch origin/${BRANCH_MAIN}`,
        ),
        this._raceTimeout(
          this.git.fetch(projectPath, { remote: 'origin', ref: BRANCH_PREVIEW, singleBranch: true, ...(signal ? { signal } : {}), auth, ...(op ? { onProgress: (evt) => this._emitTransferProgress(op, evt) } : {}) }),
          this.STEP_TIMEOUT_FETCH_MS,
          `deepen fetch origin/${BRANCH_PREVIEW}`,
        ),
      ]);
      this._gitCache = {};
    } catch (_deepenErr) { /* best-effort */ }

    if (this.isCancelRequested()) {
      return { success: false, cancelled: true, message: 'Operation cancelled by user' };
    }

    this._emitStage(op, 'merging', `Promovendo ${BRANCH_PREVIEW} → ${BRANCH_MAIN}...`);

    // Task 3: preview/main conflict mapping — ours = MAIN, theirs =
    // PREVIEW. MERGE_LOCAL keeps MAIN, MERGE_REMOTE keeps PREVIEW (the
    // historical auto winner). Real conflict on the auto path pauses the
    // flow for a user decision.
    if (!conflictStrategy) {
      const gate = await this._conflictGate(projectPath, `origin/${BRANCH_PREVIEW}`);
      if (gate) {
        // Best-effort cleanup: no signal (Task 6 decision) — the
        // conflictPending return must survive any cancel state.
        try {
          await this._raceTimeout(
            this.git.checkout(projectPath, BRANCH_PREVIEW),
            this.STEP_TIMEOUT_CHECKOUT_MS,
            `checkout ${BRANCH_PREVIEW}`,
          );
          this._gitCache = {};
        } catch (_e) { /* best-effort return to the working branch */ }
        return { conflictPending: gate };
      }
    }
    const strat = conflictStrategy ? this._conflictDriverFor(conflictStrategy) : null;

    this.sendOutput(`🔀 Promovendo ${BRANCH_PREVIEW} → ${BRANCH_MAIN} (preview vence conflitos)...`);
    try {
      await this._raceTimeout(
        this.git.merge(projectPath, `origin/${BRANCH_PREVIEW}`, {
          ours: BRANCH_MAIN,
          fastForward: false,
          // T5-1: stage clean merges + conflict stages in the index BEFORE
          // the legacy provider throws, so the binary fallback commit keeps the
          // remote's clean files (dugite ignores this key).
          abortOnConflict: false,
          ...(strat
            ? { strategy: strat.side }
            : { strategy: 'theirs' }),
          message: `Promote preview to main${conflictStrategy ? ` (${conflictStrategy})` : ''} — ${new Date().toISOString()}`,
          author,
          ...(signal ? { signal } : {}),
        }),
        this.STEP_TIMEOUT_MERGE_MS,
        `merge promote ${BRANCH_PREVIEW}→${BRANCH_MAIN}`,
      );
    } catch (mergeErr) {
      const conflictFiles = this._extractConflictFiles(mergeErr);
      if (!conflictFiles) {
        // Non-recoverable merge failure: restore main to the remote state
        // (backup-guarded) before propagating. Note: reuse context is NOT
        // passed here — by now HEAD has moved onto main/merge territory,
        // so a FRESH backup is the correct protection (Task 4).
        try {
          await this._safeResetToOrigin(projectPath, `origin/${BRANCH_MAIN}`, { author });
        } catch (_resetErr) { /* best-effort */ }
        throw mergeErr;
      }
      // Binary conflicts: bytes from the winning side of the strategy
      // (auto path = PREVIEW wins, theirs = origin/preview).
      this.sendOutput('⚠️ Conflito binário detectado — usando versão do preview.');
      const binaryOid = strat && strat.side === 'ours' ? originMainOid : theirsOid;
      for (const filepath of conflictFiles) {
        try {
          await this._resolveBinarySide(projectPath, filepath, binaryOid);
        } catch (resolveErr) {
          this.logger.warn(`Could not resolve binary ${filepath}: ${resolveErr.message}`);
        }
      }
      await this.git.commit(projectPath, `Promote preview to main (binary resolved) — ${new Date().toISOString()}`, {
        author,
        parent: [BRANCH_MAIN, `origin/${BRANCH_PREVIEW}`],
        ...(signal ? { signal } : {}),
      });
    }

    // the legacy provider merge does NOT touch the working tree — materialize
    // HEAD (main). Safe: this core runs inside withMandatoryBackup.
    await this._raceTimeout(
      this.git.checkout(projectPath, BRANCH_MAIN, { force: true, signal }),
      this.STEP_TIMEOUT_CHECKOUT_MS,
      `materialize ${BRANCH_MAIN}`,
    );
    this._gitCache = {};

    this._emitStage(op, 'pushing', `Publicando em ${BRANCH_MAIN}...`);
    this.sendOutput(`🚀 Publicando em ${BRANCH_MAIN}...`);
    try {
      await this._pushWithTransientRetry(projectPath, {
        remote: 'origin',
        branch: BRANCH_MAIN,
        remoteRef: BRANCH_MAIN,
        auth,
      }, { op, signal, label: BRANCH_MAIN });
    } catch (pushErr) {
      // Task 6 contract: ONE attempt, typed error, renderer guides the
      // update. Nothing local was lost (merge kept + backup retained).
      if (this._isPushRejected(pushErr)) {
        throw new GitFlowError(
          'PUSH_REJECTED',
          'O repositório remoto tem novidades em main. Atualize primeiro e depois publique novamente.',
          pushErr,
        );
      }
      throw pushErr;
    }
    this._gitCache = {};

    this.sendOutput(`✅ ${BRANCH_PREVIEW} promovido para ${BRANCH_MAIN}`);

    // Return to the preview working branch — a plain checkout (we are
    // still inside the withMandatoryBackup guard; the WIP commit and any
    // local-only commits stay untouched on preview). Deliberately NO
    // signal (Task 6 decision): the push already succeeded, so a cancel
    // arriving mid-checkout must neither kill the child nor flip this
    // into a cancelled result — same rationale as the post-push cleanup
    // in _publishCore.
    this._emitStage(op, 'finalizing', `Voltando para a branch ${BRANCH_PREVIEW}...`);
    this.sendOutput(`📥 Voltando para a branch ${BRANCH_PREVIEW}...`);
    await this._raceTimeout(
      this.git.checkout(projectPath, BRANCH_PREVIEW),
      this.STEP_TIMEOUT_CHECKOUT_MS,
      `checkout ${BRANCH_PREVIEW}`,
    );
    this._gitCache = {};

    return { success: true, branch: BRANCH_PREVIEW };
  }

  /**
   * Resolve a pending conflict decision (Task 3 — counterpart of the
   * CONFLICT_PENDING result minted by _mintConflictPending).
   *
   * Semantics:
   *  - `strategy = 'CANCEL'`: clean abort. NOTHING beyond what was already
   *    safe is touched — the WIP commit and the mandatory backup are KEPT
   *    (they are protection, not garbage); no merge runs; the token is
   *    consumed. Returns `{success:false, code:'CANCELLED'}`. This is the
   *    MODAL cancel and is completely independent of the in-flight
   *    operation cancel (requestCancel/AbortController): no lock is held
   *    while a decision is pending.
   *  - `strategy` in CONFLICT_STRATEGIES: consumes the token (single use),
   *    re-locks, re-runs the SAME guarded flow with the chosen strategy —
   *    the flow re-fetches (cheap depth:1), merges with the strategy's
   *    driver, materializes and pushes/materializes exactly like the
   *    automatic path would.
   *
   * Token security: tokens live ONLY in this handler's memory
   * (crypto.randomBytes), expire after RESUME_TOKEN_TTL_MS (15 min) and are
   * deleted on first use. Expired/unknown/reused tokens are rejected with
   * typed codes. A lock held by an unrelated operation does NOT consume the
   * token (retryable:true).
   *
   * @param {string} resumeToken - token from a CONFLICT_PENDING result
   * @param {string} strategy - CONFLICT_STRATEGIES member or 'CANCEL'
   * @returns {Promise<{success: boolean, code?: string, error?: string, message?: string, cancelled?: boolean, branch?: string, pushed?: boolean, retryable?: boolean}>}
   */
  async gitResolveConflict(resumeToken, strategy) {
    // Lazy purge of OTHER expired tokens; the requested one is judged by
    // the explicit TOKEN_EXPIRED branch below.
    for (const [key, entry] of this._pendingConflicts) {
      if (key !== resumeToken && Date.now() > entry.expiresAt) {
        this._pendingConflicts.delete(key);
      }
    }
    const entry = this._pendingConflicts.get(resumeToken);
    if (!entry) {
      return {
        success: false,
        code: 'INVALID_TOKEN',
        error: 'Token de retomada inválido, expirado ou já utilizado. Inicie a operação novamente.',
      };
    }
    if (Date.now() > entry.expiresAt) {
      this._pendingConflicts.delete(resumeToken);
      return {
        success: false,
        code: 'TOKEN_EXPIRED',
        error: 'O tempo para decidir expirou. Inicie a operação novamente.',
      };
    }
    if (strategy === 'CANCEL') {
      this._pendingConflicts.delete(resumeToken);
      this.sendOutput('🚫 Operação cancelada pelo usuário — nada foi mesclado; versão local e backup preservados.');
      return {
        success: false,
        code: 'CANCELLED',
        message: 'Operação cancelada — sua versão local e o backup permanecem intactos.',
      };
    }
    if (!CONFLICT_STRATEGIES.includes(strategy)) {
      return {
        success: false,
        code: 'INVALID_STRATEGY',
        error: `Estratégia inválida: ${strategy}. Use uma de ${CONFLICT_STRATEGIES.join(', ')} ou CANCEL.`,
      };
    }
    if (!this.acquireGitLock()) {
      return {
        success: false,
        retryable: true,
        error: 'Git operation already in progress. Please wait.',
      };
    }
    this._pendingConflicts.delete(resumeToken);
    // Resume = NEW operationId (not a continuation of the paused op).
    const op = this._beginOperation(
      entry.projectId ?? null,
      entry.flow === 'refresh' ? 'refresh' : entry.flow === 'publish-main' ? 'publish-main' : 'publish-preview',
    );
    try {
      this._gitCache = {};
      this._emitStage(op, 'preparing', `Retomando fluxo ${entry.flow} (estratégia ${strategy})...`);
      this.sendOutput(`🔀 Retomando fluxo ${entry.flow} com estratégia ${strategy}...`);
      if (entry.flow === 'publish') {
        const result = await this._runBackupGuardedPublish(entry.projectPath, entry.targetBranch, {
          // WIP-style message: protects any edits made while the modal was
          // open (commit-first ordering, same as the flow's own WIP).
          commitMessage: `WIP (conflict resume ${strategy}) at ${new Date().toISOString()}`,
          auth: entry.auth,
          author: entry.author,
          conflictStrategy: strategy,
          op,
        });
        return this._emitTerminalFromResult(
          op,
          await this._restoreOnFailure(op, entry.projectPath, result)
        );
      }
      if (entry.flow === 'refresh') {
        const result = await this._runRefreshFlow(entry.projectPath, {
          auth: entry.auth,
          author: entry.author,
          who: entry.who,
          conflictStrategy: strategy,
          op,
        });
        return this._emitTerminalFromResult(
          op,
          await this._restoreOnFailure(op, entry.projectPath, result)
        );
      }
      const result = await this._runPublishMainFlow(entry.projectPath, {
        auth: entry.auth,
        author: entry.author,
        who: entry.who,
        conflictStrategy: strategy,
        op,
      });
      return this._emitTerminalFromResult(
        op,
        await this._restoreOnFailure(op, entry.projectPath, result)
      );
    } catch (error) {
      this.logger.error('Error in gitResolveConflict:', error);
      const failResult = this._publishErrorToResult(error);
      // Task 7: auto-restore runs INSIDE the lock, BEFORE the terminal
      // event (so the terminal can carry `restored`).
      return this._emitTerminalFromResult(
        op,
        await this._restoreOnFailure(op, entry.projectPath, failResult, error)
      );
    } finally {
      this._gitCache = {};
      this.releaseGitLock();
    }
  }

  async gitListRemoteBranches(projectPath) {
    try {
      this.sendOutput('🔍 Buscando branches remotas...');

      // Get auth token for private repo support
      const token = await this.gitOps.getGitHubToken();
      const auth = token ? { token } : undefined;

      const url = await this.git.getConfig(projectPath, 'remote.origin.url', {
        cache: this._gitCache
      });

      const listServerRefsConfig = {
        url,
        cache: this._gitCache,
      };

      if (auth) {
        listServerRefsConfig.auth = auth;
      }

      const refs = await this.git.listServerRefs(url, listServerRefsConfig);

      const branches = refs
        .filter(ref => ref.ref.startsWith('refs/heads/'))
        .map(ref => ref.ref.replace('refs/heads/', ''))
        .filter(name => name !== 'HEAD');

      // Determine default branch from HEAD symref or fallback
      const headRef = refs.find(r => r.ref === 'HEAD');
      const defaultBranch = headRef?.target
        ? headRef.target.replace('refs/heads/', '')
        : branches.find(b => ['main', 'master'].includes(b)) || branches[0] || 'main';

      return { success: true, branches, defaultBranch };
    } catch (error) {
      this.logger.error('Error listing remote branches:', error);
      if (!error.message?.includes('auth') && !(await this.gitOps.getGitHubToken())) {
        throw new Error('Autenticação necessária para repositórios privados');
      }
      throw error;
    }
  }

  /**
   * Register all Git operations IPC handlers
   */
  registerHandlers() {
    this.logger.info('🔧 Registering Git operations IPC handlers');

    /**
     * List branches
     */
    ipcMain.handle('git:list-branches', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const result = await this.gitListBranches(projectPath);
        return { success: true, branches: result.branches, currentBranch: result.current };
      } catch (error) {
        this.logger.error('Error in git:list-branches handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Create branch
     */
    ipcMain.handle('git:create-branch', async (event, projectId, branchName) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        await this.gitCreateBranch(projectPath, branchName);
        return { success: true, branchName };
      } catch (error) {
        this.logger.error('Error in git:create-branch handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Checkout branch
     */
    ipcMain.handle('git:checkout-branch', async (event, projectId, branchName) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        await this.gitCheckoutBranch(projectPath, branchName);
        return { success: true, branchName };
      } catch (error) {
        this.logger.error('Error in git:checkout-branch handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Get current branch
     */
    ipcMain.handle('git:get-current-branch', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const currentBranch = await this.gitGetCurrentBranch(projectPath);
        return { success: true, currentBranch };
      } catch (error) {
        this.logger.error('Error in git:get-current-branch handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Get repository info
     */
    ipcMain.handle('git:get-repository-info', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const repoInfo = await this.gitGetRepositoryInfo(projectPath);
        return { success: true, ...repoInfo };
      } catch (error) {
        this.logger.error('Error in git:get-repository-info handler:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('git:check-status', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        return await this.gitCheckStatus(projectPath);
      } catch (error) {
        this.logger.error('Error in git:check-status handler:', error);
        return { success: false, isDirty: false, fileCount: 0, files: [], error: error.message };
      }
    });

    ipcMain.handle('git:check-unpushed', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        return await this.gitCheckUnpushed(projectPath);
      } catch (error) {
        this.logger.error('Error in git:check-unpushed handler:', error);
        return { success: false, hasUnpushed: false, error: error.message };
      }
    });

    /**
     * Raw (sanitized) git command journal of one operation — read-only
     * diagnostics for publish/update failures (publish-update-resilience
     * Task 3). Entries live 30 min past the operation's terminal event.
     */
    ipcMain.handle('git:get-operation-log', async (event, operationId) => {
      try {
        if (!this.operationJournal || typeof operationId !== 'string' || !operationId) {
          return { success: false, code: 'LOG_NOT_FOUND', error: 'Log de operação não encontrado.' };
        }
        const entries = this.operationJournal.getEntries(operationId);
        if (entries === null) {
          return {
            success: false,
            code: 'LOG_NOT_FOUND',
            error: 'Log de operação não encontrado (expirado ou operationId desconhecido).',
          };
        }
        return { success: true, entries };
      } catch (error) {
        this.logger.error('Error in git:get-operation-log handler:', error);
        return { success: false, code: 'LOG_NOT_FOUND', error: error.message };
      }
    });

    ipcMain.handle('git:pull-from-preview', async (event, projectId, commitMessage) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const result = await this.gitPullFromPreview(projectPath, commitMessage || null);
        return result;
      } catch (error) {
        this.logger.error('Error in git:pull-from-preview handler:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('git:push-to-branch', async (event, projectId, targetBranch, commitMessage) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const result = await this.gitPushToBranch(projectPath, targetBranch, commitMessage || null, projectId);
        return result;
      } catch (error) {
        this.logger.error('Error in git:push-to-branch handler:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('git:refresh', async (event, projectId, force) => {
      try {
        return await this.gitRefresh(projectId, !!force);
      } catch (error) {
        this.logger.error('Error in git:refresh handler:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('git:publish-preview', async (event, projectId, commitMessage) => {
      try {
        return await this.gitPublishPreview(projectId, commitMessage);
      } catch (error) {
        this.logger.error('Error in git:publish-preview handler:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('git:publish-main', async (event, projectId) => {
      try {
        return await this.gitPublishMain(projectId);
      } catch (error) {
        this.logger.error('Error in git:publish-main handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Resolve a pending conflict decision (counterpart of CONFLICT_PENDING).
     * Invoked with (resumeToken, 'CANCEL') or (resumeToken, strategy) where
     * strategy ∈ {MERGE_LOCAL, MERGE_REMOTE, FULL_LOCAL, FULL_REMOTE}.
     * Result contract mirrors the flows' own result shapes; typed codes:
     * CANCELLED, INVALID_TOKEN, TOKEN_EXPIRED, INVALID_STRATEGY.
     */
    ipcMain.handle('git:resolve-conflict', async (event, resumeToken, strategy) => {
      try {
        return await this.gitResolveConflict(resumeToken, strategy);
      } catch (error) {
        this.logger.error('Error in git:resolve-conflict handler:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Preflight check for publishing to main — runs runPreflightForMain
     * without performing the actual publish. Used by the renderer setup
     * modal so the user sees precedence errors before opening the exec modal.
     */
    ipcMain.handle('git:check-publish-main', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        if (this.gitPreflight && this.permissionHandlers) {
          return await this.gitPreflight.runPreflightForMain(projectId, projectPath, this.permissionHandlers);
        }
        return { canProceed: true, checks: [], warnings: [], errors: [] };
      } catch (error) {
        this.logger.error('Error in git:check-publish-main:', error);
        return {
          canProceed: false,
          checks: [],
          warnings: [],
          errors: [{ code: 'PREFLIGHT_ERROR', message: error.message }],
        };
      }
    });

    /**
     * List remote branches
     */
    ipcMain.handle('git:list-remote-branches', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        return await this.gitListRemoteBranches(projectPath);
      } catch (error) {
        this.logger.error('Error in git:list-remote-branches handler:', error);
        return { success: false, error: error.message };
      }
    });

    // Security: raw git module never leaked to renderer — only these 3 channels.
    ipcMain.handle('git:backup-list', async (event, projectId) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const fs = require('fs');
        const backups = this.gitSafety
          ? await this.gitSafety.listBackups(this._safetyOps(), fs, projectPath)
          : [];
        return { success: true, backups };
      } catch (error) {
        this.logger.error('Error in git:backup-list:', error);
        return { success: false, error: error.message, backups: [] };
      }
    });

    ipcMain.handle('git:backup-restore', async (event, projectId, backupBranch) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const fs = require('fs');
        if (!this.gitSafety) {
          throw new Error('GitSafety unavailable');
        }
        await this.gitSafety.restoreBackup(this._safetyOps(), fs, projectPath, backupBranch);
        return { success: true };
      } catch (error) {
        this.logger.error('Error in git:backup-restore:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('git:backup-delete', async (event, projectId, backupBranch) => {
      try {
        const projectPath = await this.getProjectPath(projectId);
        const fs = require('fs');
        if (!this.gitSafety) {
          throw new Error('GitSafety unavailable');
        }
        await this.gitSafety.deleteBackup(this._safetyOps(), fs, projectPath, backupBranch);
        return { success: true };
      } catch (error) {
        this.logger.error('Error in git:backup-delete:', error);
        return { success: false, error: error.message };
      }
    });

    /**
     * Cancel current Git operation.
     *
     * RECOVERY CONTRACT (Task 5): cancelling NEVER deletes backup
     * branches. If the operation was interrupted mid-merge/reset, the
     * repository is restorable from any retained `backup/*` branch via
     * `GitSafety.recoverFromBackup(ops, fs, projectPath, backupBranch,
     * workBranch)` — which performs `writeRef` of the work branch to the
     * backup tip + force checkout (pattern at GitProvider.js:601-604) and
     * keeps the backup for retry. Backups expire only through the 7-day
     * retention pruning (`GitSafety.pruneOldBackups`).
     */
    ipcMain.handle('git:cancel-operation', async () => {
      this.logger.info('Cancel operation requested via IPC');
      this.requestCancel();
      return { success: true, message: 'Cancellation requested' };
    });

    this.logger.info('✅ Git operations IPC handlers registered');
  }

  /**
   * Unregister all Git operations IPC handlers
   */
  unregisterHandlers() {
    this.logger.info('🔧 Unregistering Git operations IPC handlers');
    
    ipcMain.removeHandler('git:list-branches');
    ipcMain.removeHandler('git:create-branch');
    ipcMain.removeHandler('git:checkout-branch');
    ipcMain.removeHandler('git:get-current-branch');
    ipcMain.removeHandler('git:get-repository-info');
    ipcMain.removeHandler('git:check-status');
    ipcMain.removeHandler('git:check-unpushed');
    ipcMain.removeHandler('git:get-operation-log');
    ipcMain.removeHandler('git:pull-from-preview');
    ipcMain.removeHandler('git:push-to-branch');
    ipcMain.removeHandler('git:refresh');
    ipcMain.removeHandler('git:publish-preview');
    ipcMain.removeHandler('git:publish-main');
    ipcMain.removeHandler('git:check-publish-main');
    ipcMain.removeHandler('git:list-remote-branches');
    ipcMain.removeHandler('git:cancel-operation');
    ipcMain.removeHandler('git:backup-list');
    ipcMain.removeHandler('git:backup-restore');
    ipcMain.removeHandler('git:backup-delete');
    
    this.logger.info('✅ Git operations IPC handlers unregistered');
  }
}

module.exports = { GitHandlers, GitFlowError, parseTransferPercentage };