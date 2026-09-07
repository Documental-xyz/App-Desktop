/**
 * @fileoverview Normalized error type for the GitProvider abstraction.
 * Carries operation/provider context, a SANITIZED stderr (tokens removed),
 * and a normalized errorType
 * ('timeout'|'auth'|'network'|'conflict'|'large_file'|'unknown')
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
// The list is split in two groups (publish-update-resilience Task 3)
// so the operation journal can reuse the SAME patterns without
// duplicating them: errors blanket-redact URL credentials, while
// sanitizeCommandOutput() masks them user-preserving first and then
// applies only the standalone token group.
const URL_CREDENTIAL_PATTERNS = [
  // https://user:password@host/... (full userinfo)
  /https?:\/\/[^\s:@/]+:[^\s@]+@/g,
  // https://<token>@host/... (bare token as userinfo)
  /https?:\/\/[A-Za-z0-9_.-]+@/g,
];

const TOKEN_PATTERNS = [
  // <token>:x-oauth-basic (GitHub OAuth basic auth pair)
  /[A-Za-z0-9_-]{8,}:x-oauth-basic/g,
  // x-oauth-basic:<token> (reversed pair)
  /x-oauth-basic:[A-Za-z0-9_-]{8,}/g,
  // long alphanumeric tokens passed standalone (ghp_/gho_/github_pat_ or 40+ hex)
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|[A-Fa-f0-9]{40})\b/g,
];

// Full list in the ORIGINAL pattern order — sanitize() behavior unchanged.
const ALL_TOKEN_PATTERNS = [...URL_CREDENTIAL_PATTERNS, ...TOKEN_PATTERNS];

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
  for (const pattern of ALL_TOKEN_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

// Journal-layer masks (publish-update-resilience Task 3). They run BEFORE
// the token patterns; the user-preserving 'user:***@' output must NOT be
// re-matched by any later pattern (verified: ':'/'*' break the userinfo
// character classes above), otherwise the username would be lost.
const URL_USERINFO_RE = /(https?:\/\/)([^\s:@/'"]+):([^\s@/'"]+)@/g;
const URL_BARE_TOKEN_RE = /(https?:\/\/)[A-Za-z0-9_.-]+@/g;
const AUTH_HEADER_RE = /\b(authorization\s*:\s*)([^\r\n]+)/gi;
const TOKEN_ENV_RE = /\b((?:GH|GITHUB)_TOKEN)(\s*[=:]\s*)(\S+)/gi;

/**
 * Layered sanitizer for RAW git command output that is about to be
 * STORED (operation journal — sanitize at write time, never at read
 * time). Extends sanitize() with:
 *   - https://user:token@host → https://user:***@host (user preserved)
 *   - https://token@host → https://***@host (bare-token userinfo)
 *   - Authorization: <anything> → Authorization: ***
 *   - GH_TOKEN=… / GITHUB_TOKEN: … values → ***
 * then applies the SAME standalone token patterns as sanitize().
 *
 * @param {string} [text] - Raw argv element / stdout / stderr
 * @returns {string|undefined} Sanitized text, or undefined if input was
 *   undefined/null (parity with sanitize())
 */
function sanitizeCommandOutput(text) {
  if (text === undefined || text === null) {
    return undefined;
  }
  let out = String(text);
  out = out.replace(URL_USERINFO_RE, '$1$2:***@');
  out = out.replace(URL_BARE_TOKEN_RE, '$1***@');
  out = out.replace(AUTH_HEADER_RE, '$1***');
  out = out.replace(TOKEN_ENV_RE, '$1$2***');
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

// ─── Error type classification ────────────────────────────────────────────────

/**
 * @typedef {'timeout'|'auth'|'network'|'conflict'|'large_file'|'unknown'} ErrorType
 */

/**
 * Message/code → errorType rules, in priority order (first match wins).
 *
 * Precedence (Task 5 of publish-update-resilience):
 *  1. large_file — GitHub server-side size policy. MUST precede conflict:
 *     GH large-file stderr contains "[remote rejected]", which the bare
 *     `rejected` conflict pattern would otherwise swallow.
 *  2. auth — unambiguous credential rejections (401/403 win over the broad
 *     network wording "unable to access … 403").
 *  3. timeout — explicit timeout wording wins over network: a connection
 *     that timed out (ETIMEDOUT, "Connection timed out", curl 28) is the
 *     more actionable diagnosis and stays retriable.
 *  4. network — DNS/connectivity failures (Node syscalls or git text).
 *  5. conflict — server refuses the update.
 *
 * Exit codes are AUXILIARY only (128 fatal / 129 usage never invent a
 * class) — granularity comes from the stderr text, never the exit code.
 *
 * @type {Array<[RegExp, ErrorType]>}
 */
const CLASSIFICATION_RULES = [
  // large_file: GitHub pre-receive size policy (GH001/GH002) + the generic
  // "too large" remote rejection. The remote-rejected+too-large pairs are
  // matched on the SAME LINE to avoid classifying unrelated "too large" text.
  [/exceeds (?:github'?s )?(?:file size limit|the maximum allowed size)|this file is larger than|GH00[12]|remote[ -]rejected[^\n]*too[ _-]?large|too[ _-]?large[^\n]*remote[ -]rejected/i, 'large_file'],
  // auth: credentials rejected (refined — could-not-read-Username prompt)
  [/\b40[13]\b|authentication (?:failed|required)|invalid username or (?:password|token|access token)|could not read username|terminal prompts disabled|not authorized|permission denied|access denied/i, 'auth'],
  // timeout: explicit timeout wording / cancellation abort (refined — owns
  // ETIMEDOUT and "connection timed out"; checked before network)
  [/\bAbortError\b|\baborted\b|ETIMEDOUT|timed[ -]?out|timeout/i, 'timeout'],
  // network: DNS/connectivity failures (refined — early EOF / RPC failed /
  // connection closed; timeout patterns live above)
  [/ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|could not resolve host|network (?:error|is unreachable)|connection (?:refused|reset)|connection was closed|early EOF|RPC failed|failed to connect|unable to access/i, 'network'],
  // conflict: server refuses update (unchanged)
  [/non-fast-forward|fetch first|rejected|cannot lock ref|already exists|merge conflict|divergent branches/i, 'conflict'],
];

/**
 * Classify a raw error (Error object, string, or dugite result fields) into
 * a normalized ErrorType by inspecting message/code/exitCode/stderr.
 * Exit codes are AUXILIARY evidence only — the class always comes from the
 * stderr/message text (see CLASSIFICATION_RULES precedence notes).
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

// ─── Offending-file extraction (large_file) ───────────────────────────────────

/**
 * GitHub pre-receive rejections NAME the offending files:
 *   remote: error: File assets/videos/demo.mp4 is 150.28 MB; this exceeds
 *   GitHub's file size limit of 100.00 MB
 * The path is everything between "File" and the " is <size> MB" clause.
 * Input is SANITIZED first (paths reach the renderer — Task 11).
 *
 * @param {string} [stderr]
 * @returns {string[]} unique offending paths, [] when not extractable
 */
const OFFENDING_FILE_RE = /(?:^|\n)[ \t]*(?:remote:[ \t]*)?error:[ \t]*File[ \t]+(.+?)[ \t]+is[ \t]+[\d.]+[ \t]*[KMG]i?B\b/gi;

/**
 * Extract the file paths GitHub blamed for a large-file push rejection.
 *
 * @param {string} [stderr] - Raw or sanitized git stderr
 * @returns {string[]} deduped paths ([] when stderr carries none)
 */
function extractOffendingFiles(stderr) {
  if (!stderr) {
    return [];
  }
  const safe = sanitize(stderr) || '';
  const out = [];
  for (const match of safe.matchAll(OFFENDING_FILE_RE)) {
    const file = match[1].trim().replace(/^['"]|['"]$/g, '');
    if (file && !out.includes(file)) {
      out.push(file);
    }
  }
  return out;
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
GitError.sanitizeCommandOutput = sanitizeCommandOutput;
GitError.extractOffendingFiles = extractOffendingFiles;

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = GitError;
module.exports.GitError = GitError;
module.exports.classifyError = classifyError;
module.exports.sanitize = sanitize;
module.exports.sanitizeCommandOutput = sanitizeCommandOutput;
module.exports.extractOffendingFiles = extractOffendingFiles;
