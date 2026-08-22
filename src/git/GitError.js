/**
 * @fileoverview Normalized error type for the GitProvider abstraction.
 * Carries operation/provider context, a SANITIZED stderr (tokens removed),
 * and a normalized errorType ('timeout'|'auth'|'network'|'conflict'|'unknown')
 * so retry/backoff logic works uniformly across providers (PRD §26).
 * @since 1.0.0
 */

'use strict';

// ─── Token sanitization ───────────────────────────────────────────────────────

/**
 * Patterns that may leak credentials into git output. Git can echo remote
 * URLs (which must never contain tokens, but defense-in-depth applies —
 * PRD §25) and error text.
 */
const TOKEN_PATTERNS = [
  // https://user:password@host/... (full userinfo)
  /https?:\/\/[^\s:@/]+:[^\s@]+@/g,
  // https://<token>@host/... (bare token as userinfo)
  /https?:\/\/[A-Za-z0-9_.-]+@/g,
  // <token>:x-oauth-basic (GitHub OAuth basic auth pair)
  /[A-Za-z0-9_-]{8,}:x-oauth-basic/g,
  // x-oauth-basic:<token> (reversed pair)
  /x-oauth-basic:[A-Za-z0-9_-]{8,}/g,
  // long alphanumeric tokens passed standalone (ghp_/gho_/github_pat_ or 40+ hex)
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|[A-Fa-f0-9]{40})\b/g,
];

/**
 * Remove credential-like substrings from git output before it is stored in
 * an error (or logged). Replaces matches with `[REDACTED]`.
 *
 * @param {string} [text] - Raw stderr/stdout potentially containing tokens
 * @returns {string|undefined} Sanitized text, or undefined if input was undefined
 */
function sanitize(text) {
  if (text === undefined || text === null) {
    return undefined;
  }
  let out = String(text);
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

// ─── Error type classification ────────────────────────────────────────────────

/**
 * @typedef {'timeout'|'auth'|'network'|'conflict'|'unknown'} ErrorType
 */

/** @type {Array<[RegExp, ErrorType]>} Message/code → errorType rules, in priority order */
const CLASSIFICATION_RULES = [
  // network: DNS/connectivity failures (Node syscalls or git text)
  [/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/i, 'network'],
  [/could not resolve host|network (error|is unreachable)|connection (refused|reset|timed out)|failed to connect|unable to access/i, 'network'],
  // auth: credentials rejected
  [/\b401\b|\b403\b|authentication failed|authentication required|invalid username or password|not authorized|permission denied|access denied|terminal prompts disabled/i, 'auth'],
  // conflict: server refuses update
  [/non-fast-forward|fetch first|rejected|cannot lock ref|already exists|merge conflict|divergent branches/i, 'conflict'],
  // timeout: cancellation/abort
  [/AbortError|aborted|operation timed out|timeout|timed out/i, 'timeout'],
];

/**
 * Classify a raw error (Error object, string, or dugite result fields) into
 * a normalized ErrorType by inspecting message/code/exitCode/stderr.
 *
 * @static
 * @param {Error|string|{ message?: string, code?: string|number, stderr?: string, exitCode?: number }} raw
 * @returns {ErrorType}
 */
function classifyError(raw) {
  if (!raw) {
    return 'unknown';
  }
  const parts = [];
  if (typeof raw === 'string') {
    parts.push(raw);
  } else if (raw instanceof Error) {
    parts.push(raw.message || '', raw.code ? String(raw.code) : '', raw.name || '');
  } else {
    parts.push(raw.message || '', raw.code !== undefined ? String(raw.code) : '', raw.stderr || '');
  }
  const haystack = parts.join(' ');
  for (const [pattern, type] of CLASSIFICATION_RULES) {
    if (pattern.test(haystack)) {
      return type;
    }
  }
  return 'unknown';
}

// ─── GitError ─────────────────────────────────────────────────────────────────

/**
 * Normalized git operation failure. `stderr` (and `message` when derived
 * from stderr) is sanitized: tokens are replaced with `[REDACTED]` and
 * never propagate to logs or the renderer.
 *
 * @extends Error
 */
class GitError extends Error {
  /**
   * @param {Object} info
   * @param {import('./GitTypes').GitOperation} info.operation - Operation that failed
   * @param {import('./GitTypes').ProviderName} info.provider - Provider that raised the error
   * @param {number} [info.exitCode] - Process exit code (dugite); exit code ≠ 0 does not throw in dugite v3
   * @param {string} [info.stderr] - Raw stderr (sanitized before storage)
   * @param {unknown} [info.cause] - Original error, if any
   * @param {import('./GitTypes').AuthInfo} [info.auth] - Auth used (token NEVER stored)
   */
  constructor({ operation, provider, exitCode, stderr, cause, auth }) {
    const safeStderr = sanitize(stderr);
    super(
      `git ${operation} failed on ${provider}` +
        (exitCode !== undefined ? ` (exit ${exitCode})` : '') +
        (safeStderr ? `: ${safeStderr}` : '')
    );
    this.name = 'GitError';
    /** @type {import('./GitTypes').GitOperation} */
    this.operation = operation;
    /** @type {import('./GitTypes').ProviderName} */
    this.provider = provider;
    /** @type {number|undefined} */
    this.exitCode = exitCode;
    /** @type {string|undefined} Sanitized stderr — tokens removed */
    this.stderr = safeStderr;
    /** @type {unknown} */
    this.cause = cause;
    /** @type {import('./GitTypes').AuthInfo|undefined} Intentionally undefined — auth is never retained */
    this.auth = undefined; // eslint-disable-line no-unused-vars
    /** @type {ErrorType} */
    this.errorType = classifyError({ stderr, exitCode, message: cause instanceof Error ? cause.message : '' });
  }
}

// Static helper on the class (also exported standalone for convenience).
GitError.classifyError = classifyError;
GitError.sanitize = sanitize;

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = GitError;
module.exports.GitError = GitError;
module.exports.classifyError = classifyError;
module.exports.sanitize = sanitize;
