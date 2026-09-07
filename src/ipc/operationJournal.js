/**
 * @fileoverview Per-operation raw output journal — publish-update-
 * resilience Task 3 ("Journal de operação — saída bruta sanitizada do
 * git").
 *
 * In-memory ring buffer (Map operationId → entries) capturing EVERY git
 * command executed by DugiteProvider._run during an operation, with the
 * RAW output SANITIZED BEFORE STORING, so the user can diagnose publish
 * failures with the original git output (plan requirement 2).
 *
 * Design decisions (see .omo/notepads/publish-update-resilience):
 *   - ATTRIBUTION: _run does not know the operationId, and threading it
 *     through every provider call (or an AsyncLocalStorage) would be
 *     intrusivo demais. Pragmatic solution: GitHandlers sets the
 *     CURRENT operation in _beginOperation (born together with the
 *     single git lock — 1 lock = 1 operation, so current-operation is
 *     safe UNDER the lock) and clears it at the terminal event. _run
 *     notifies recordCommand(null, entry), which inherits the current
 *     operation. Commands outside any operation (project clone, UI
 *     listBranches) land in a small disposable UNATTRIBUTED buffer.
 *   - SANITIZE AT WRITE TIME: entries are sanitized the moment they are
 *     recorded (GitError.sanitizeCommandOutput — URL-embedded
 *     credentials user-preserving, Authorization headers, GH/GITHUB_TOKEN
 *     env values, standalone token patterns). Nothing raw is ever held,
 *     and read paths (IPC) need no trust boundary.
 *   - EXPIRY: entries survive 30 min past the operation's terminal event
 *     (setTimeout, unref'd) for post-mortem inspection via the
 *     git:get-operation-log IPC; sweepExpired() (injected clock) is the
 *     backstop, plus a hard lifetime cap so never-terminalized
 *     operations cannot leak memory.
 *   - NEVER PERSISTED TO DISK (plan guardrail) — memory only.
 *
 * Pure module: NO electron dependency (singleton wired by GitHandlers).
 *
 * @since 1.0.0
 */

'use strict';

const { sanitizeCommandOutput } = require('../git/GitError');

/** Default post-terminal retention (30 min). */
const JOURNAL_TTL_MS = 30 * 60 * 1000;
/** Default ring capacity per operation. */
const JOURNAL_MAX_ENTRIES = 500;
/** Hard cap on a never-terminalized operation's lifetime (leak guard). */
const JOURNAL_MAX_OPERATION_LIFETIME_MS = 2 * 60 * 60 * 1000;
/** Disposable buffer for commands outside any attributed operation. */
const UNATTRIBUTED_MAX_ENTRIES = 50;

/**
 * @typedef {Object} JournalEntry
 * @property {number} seq - 1-based sequence within the operation (ring
 *   overflow discards the OLDEST entries, so seq identifies the true
 *   command order)
 * @property {number} timestamp - Epoch ms when the command completed
 * @property {string[]} args - Sanitized git argv (array, shell-free)
 * @property {number|null} exitCode - Command exit code (null when the
 *   git binary itself failed to launch)
 * @property {string} stdout - Sanitized raw stdout
 * @property {string} stderr - Sanitized raw stderr
 * @property {number|null} durationMs - Wall-clock duration
 */

class OperationJournal {
  /**
   * @param {Object} [options]
   * @param {number} [options.ttlMs=JOURNAL_TTL_MS] - Post-terminal retention
   * @param {number} [options.maxEntries=JOURNAL_MAX_ENTRIES] - Ring cap per operation
   * @param {() => number} [options.now] - Clock injection (tests)
   * @param {(fn: () => void, ms: number) => Object} [options.setTimeoutFn] - Timer injection (tests)
   * @param {(timer: Object) => void} [options.clearTimeoutFn] - Timer injection (tests)
   */
  constructor({ ttlMs = JOURNAL_TTL_MS, maxEntries = JOURNAL_MAX_ENTRIES, now, setTimeoutFn, clearTimeoutFn } = {}) {
    this._ttlMs = ttlMs;
    this._maxEntries = maxEntries;
    this._now = now || (() => Date.now());
    // Resolved lazily so vitest fake timers (installed AFTER construction)
    // still intercept the expiry timers.
    this._setTimeoutFn = setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeoutFn = clearTimeoutFn || ((timer) => clearTimeout(timer));
    /** @type {Map<string, {entries: JournalEntry[], seq: number, meta: object|null, createdAt: number, terminalAt: number|null, timer: Object|null}>} */
    this._operations = new Map();
    /** @type {string|null} operationId set by setCurrentOperation (under the git lock) */
    this._currentOperationId = null;
    /** @type {JournalEntry[]} disposable ring — commands outside any operation */
    this._unattributed = [];
  }

  /**
   * Register an operation (idempotent). Called by setCurrentOperation
   * via GitHandlers._beginOperation, so an operation with ZERO commands
   * (e.g. missing token) still yields an empty, readable journal.
   * @param {string} operationId
   * @param {object} [meta] - { projectId, flow } diagnostics context
   */
  beginEntry(operationId, meta) {
    if (!operationId) return;
    let rec = this._operations.get(operationId);
    if (!rec) {
      rec = { entries: [], seq: 0, meta: meta || null, createdAt: this._now(), terminalAt: null, timer: null };
      this._operations.set(operationId, rec);
    } else if (meta) {
      rec.meta = { ...(rec.meta || {}), ...meta };
    }
  }

  /**
   * Set the operation that recordCommand(null, …) attributes to. Called
   * in _beginOperation (born with the single git lock) — safe under the
   * lock; cleared by markTerminal.
   * @param {string} operationId
   * @param {object} [meta]
   */
  setCurrentOperation(operationId, meta) {
    if (operationId) {
      this.beginEntry(operationId, meta);
    }
    this._currentOperationId = operationId || null;
  }

  /** @returns {string|null} the current attributed operationId */
  getCurrentOperationId() {
    return this._currentOperationId;
  }

  /**
   * Record ONE executed git command, sanitized BEFORE storing. A null
   * operationId inherits the current operation; with none set, the entry
   * goes to the disposable unattributed buffer.
   * @param {string|null} operationId
   * @param {{args?: string[], exitCode?: number|null, stdout?: string, stderr?: string, durationMs?: number|null}} entry
   */
  recordCommand(operationId, entry) {
    const source = entry || {};
    const args = Array.isArray(source.args)
      ? source.args.map((a) => sanitizeCommandOutput(String(a)))
      : [];
    const sanitized = {
      args,
      exitCode: typeof source.exitCode === 'number' ? source.exitCode : null,
      stdout: sanitizeCommandOutput(source.stdout) ?? '',
      stderr: sanitizeCommandOutput(source.stderr) ?? '',
      durationMs: typeof source.durationMs === 'number' && source.durationMs >= 0
        ? source.durationMs
        : null,
    };

    const targetId = operationId || this._currentOperationId;
    if (!targetId) {
      this._unattributed.push({ seq: 0, timestamp: this._now(), ...sanitized });
      if (this._unattributed.length > UNATTRIBUTED_MAX_ENTRIES) {
        this._unattributed.splice(0, this._unattributed.length - UNATTRIBUTED_MAX_ENTRIES);
      }
      return;
    }

    let rec = this._operations.get(targetId);
    if (!rec) {
      rec = { entries: [], seq: 0, meta: null, createdAt: this._now(), terminalAt: null, timer: null };
      this._operations.set(targetId, rec);
    }
    rec.seq += 1;
    rec.entries.push({ seq: rec.seq, timestamp: this._now(), ...sanitized });
    if (rec.entries.length > this._maxEntries) {
      rec.entries.splice(0, rec.entries.length - this._maxEntries);
    }
  }

  /**
   * @param {string} operationId
   * @returns {JournalEntry[]|null} copy of the entries, or null when the
   *   operation is unknown/expired (IPC maps this to LOG_NOT_FOUND)
   */
  getEntries(operationId) {
    const rec = operationId ? this._operations.get(operationId) : null;
    if (!rec) return null;
    return rec.entries.slice();
  }

  /**
   * @returns {JournalEntry[]} copy of the disposable buffer (commands run
   *   outside any attributed operation — diagnostics only, never exposed
   *   via IPC)
   */
  getUnattributedEntries() {
    return this._unattributed.slice();
  }

  /**
   * Mark the operation terminal: arms the TTL expiry timer and clears
   * the current-operation pointer (only if it still points here).
   * Called from GitHandlers._emitTerminal — light by design.
   * @param {string} operationId
   */
  markTerminal(operationId) {
    const rec = operationId ? this._operations.get(operationId) : null;
    if (!rec || rec.terminalAt !== null) return;
    rec.terminalAt = this._now();
    this._armExpiry(operationId, rec);
    if (this._currentOperationId === operationId) {
      this._currentOperationId = null;
    }
  }

  /** @private */
  _armExpiry(operationId, rec) {
    if (rec.timer) return;
    const timer = this._setTimeoutFn(() => {
      rec.timer = null;
      this._operations.delete(operationId);
    }, this._ttlMs);
    rec.timer = timer || null;
    if (timer && typeof timer.unref === 'function') {
      timer.unref(); // never hold the Electron main process open
    }
  }

  /**
   * Drop one operation immediately (cancels its expiry timer).
   * @param {string} operationId
   */
  dispose(operationId) {
    const rec = operationId ? this._operations.get(operationId) : null;
    if (!rec) return;
    if (rec.timer) {
      this._clearTimeoutFn(rec.timer);
      rec.timer = null;
    }
    this._operations.delete(operationId);
    if (this._currentOperationId === operationId) {
      this._currentOperationId = null;
    }
  }

  /**
   * Backstop for the expiry timers (crash-safe): drops terminalized
   * operations past the TTL and ANY operation older than the hard
   * lifetime cap (leak guard for never-terminalized entries).
   */
  sweepExpired() {
    const at = this._now();
    for (const [id, rec] of this._operations) {
      const terminalExpired = rec.terminalAt !== null && at - rec.terminalAt >= this._ttlMs;
      const lifetimeExpired = at - rec.createdAt >= JOURNAL_MAX_OPERATION_LIFETIME_MS;
      if (terminalExpired || lifetimeExpired) {
        this.dispose(id);
      }
    }
  }

  /** Drop EVERYTHING (tests / shutdown). */
  reset() {
    for (const rec of this._operations.values()) {
      if (rec.timer) {
        this._clearTimeoutFn(rec.timer);
        rec.timer = null;
      }
    }
    this._operations.clear();
    this._unattributed = [];
    this._currentOperationId = null;
  }
}

/** Process-wide singleton wired by GitHandlers (one journal per app). */
const journal = new OperationJournal();

module.exports = {
  journal,
  OperationJournal,
  JOURNAL_TTL_MS,
  JOURNAL_MAX_ENTRIES,
  JOURNAL_MAX_OPERATION_LIFETIME_MS,
};
