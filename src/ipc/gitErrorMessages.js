/**
 * @fileoverview Friendly-error mapping for git flow failures (Task 5,
 * publish-update-resilience).
 *
 * Maps the GitError classification ('large_file'|'timeout'|'auth'|
 * 'network'|'conflict'|'unknown') to i18n KEY NAMES plus an inline EN
 * fallback for the window where a locale does not carry the key yet
 * (T12 adds the keys to the three locales: en, pt-BR, es).
 *
 * The flow failure results only carry the ADDITIVE fields
 * `{errorClass, errorTitleKey, errorHintKey, offendingFiles?}` — typed
 * codes (PUSH_REJECTED, PUSH_FORBIDDEN, …) keep their display priority in
 * the renderer (T11 consumes these fields for the banner).
 *
 * @since 1.0.0
 */

'use strict';

const {
  classifyError,
  extractOffendingFiles,
} = require('../git/GitError.js');

// ─── errorClass → friendly message mapping ────────────────────────────────────

/**
 * @typedef {Object} GitErrorMessageEntry
 * @property {string} titleKey - i18n key for the headline (main.* hierarchy)
 * @property {string} hintKey - i18n key for the actionable hint
 * @property {'error'|'warning'} severity - banner severity for T11
 * @property {string} fallbackTitle - inline EN fallback when the key is absent
 * @property {string} fallbackHint - inline EN fallback when the key is absent
 */

/** @type {Record<string, GitErrorMessageEntry>} */
const GIT_ERROR_MESSAGES = {
  large_file: {
    titleKey: 'main.git_exec_error_large_file_title',
    hintKey: 'main.git_exec_error_large_file_hint',
    severity: 'error',
    fallbackTitle: 'File too large for GitHub',
    fallbackHint:
      'GitHub blocks files larger than 100 MB. Remove or shrink the offending file(s), or track them with Git LFS (https://git-lfs.github.com), then publish again. Nothing was lost — your commits are safe.',
  },
  timeout: {
    titleKey: 'main.git_exec_error_timeout_title',
    hintKey: 'main.git_exec_error_timeout_hint',
    severity: 'warning',
    fallbackTitle: 'Connection timed out',
    fallbackHint:
      'The operation timed out. Check your internet connection and try again — nothing was lost.',
  },
  auth: {
    titleKey: 'main.git_exec_error_auth_title',
    hintKey: 'main.git_exec_error_auth_hint',
    severity: 'error',
    fallbackTitle: 'Authentication failed',
    fallbackHint:
      'GitHub rejected the credentials. Sign in again and retry — nothing was lost.',
  },
  network: {
    titleKey: 'main.git_exec_error_network_title',
    hintKey: 'main.git_exec_error_network_hint',
    severity: 'warning',
    fallbackTitle: 'Network problem',
    fallbackHint:
      'GitHub could not be reached. Check your internet connection and try again — nothing was lost.',
  },
  conflict: {
    titleKey: 'main.git_exec_error_conflict_title',
    hintKey: 'main.git_exec_error_conflict_hint',
    severity: 'warning',
    fallbackTitle: 'The remote branch has new commits',
    fallbackHint:
      'Refresh first to integrate the remote changes, then publish again — nothing was lost.',
  },
  unknown: {
    titleKey: 'main.git_exec_error_generic_title',
    hintKey: 'main.git_exec_error_generic_hint',
    severity: 'error',
    fallbackTitle: 'Git operation failed',
    fallbackHint:
      'The operation failed unexpectedly. You can try again — nothing was lost.',
  },
};

/**
 * Mapping entry for an errorClass (unknown entry as the safe fallback for
 * anything unexpected).
 *
 * @param {string} errorClass
 * @returns {GitErrorMessageEntry}
 */
function getGitErrorMessage(errorClass) {
  return GIT_ERROR_MESSAGES[errorClass] || GIT_ERROR_MESSAGES.unknown;
}

// ─── Failure-result enrichment ────────────────────────────────────────────────

/**
 * Flatten an error (walking the cause chain) into the dugite-result shape
 * classifyError understands: GitFlowError/GitSafetyError wrap the provider
 * GitError as `cause`, and the raw stderr only exists on the innermost one.
 *
 * @param {Error|string|object} raw
 * @returns {Error|string|{message: string, stderr: string, code: *, exitCode: *}}
 */
function flattenForClassification(raw) {
  if (!raw || typeof raw === 'string') {
    return raw;
  }
  const messages = [];
  const stderrs = [];
  let code;
  let exitCode;
  let current = raw;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    if (current.message) {
      messages.push(current.message);
    }
    if (current.stderr) {
      stderrs.push(current.stderr);
    }
    if (code === undefined && current.code !== undefined) {
      code = current.code;
    }
    if (exitCode === undefined && current.exitCode !== undefined) {
      exitCode = current.exitCode;
    }
    current = current.cause;
  }
  return { message: messages.join(' '), stderr: stderrs.join('\n'), code, exitCode };
}

/**
 * Additive classification fields for a flow failure result.
 * Never overwrites the existing code/error — the typed codes keep their
 * display priority; these fields ride alongside for T8 (retry) and T11 (UI).
 *
 * @param {Error|string|object} raw - the caught error
 * @returns {{errorClass: string, errorTitleKey: string, errorHintKey: string, offendingFiles?: string[]}}
 */
function buildGitErrorDetail(raw) {
  const flattened = flattenForClassification(raw);
  const errorClass = classifyError(flattened);
  const entry = getGitErrorMessage(errorClass);
  const detail = {
    errorClass,
    errorTitleKey: entry.titleKey,
    errorHintKey: entry.hintKey,
  };
  const stderrSource =
    (flattened && typeof flattened === 'object' && flattened.stderr) || '';
  const offendingFiles = extractOffendingFiles(stderrSource);
  if (offendingFiles.length > 0) {
    detail.offendingFiles = offendingFiles;
  }
  return detail;
}

/**
 * Enrich a `{success:false, code?, error}` flow-failure result with the
 * classification fields. Purely ADDITIVE (typed codes and the existing
 * error string are preserved verbatim); classification failures can never
 * break the failure result.
 *
 * @param {object} result - assembled failure result
 * @param {Error|string|object} raw - the caught error
 * @returns {object} result with `{errorClass, errorTitleKey, errorHintKey, offendingFiles?}`
 */
function enrichFailureResult(result, raw) {
  if (!result || result.success !== false) {
    return result;
  }
  try {
    return { ...result, ...buildGitErrorDetail(raw) };
  } catch (_classificationError) {
    return result;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  GIT_ERROR_MESSAGES,
  getGitErrorMessage,
  buildGitErrorDetail,
  enrichFailureResult,
};
