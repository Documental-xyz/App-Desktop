'use strict';
/**
 * @fileoverview Shared cross-platform path utilities for renderer pages.
 *
 * IPC-first: when window.electronAPI.joinPath / normalizePath are available
 * (packaged app / electron loadFile), every call delegates to the main
 * process (src/main/services/fileService.js — path.join / path.normalize),
 * so rendered paths always match the host OS exactly.
 *
 * Hardened browser fallback (dev-in-browser only, when electronAPI is
 * absent): detects Windows-drive paths (/^[A-Za-z]:[\\/]/) and keeps
 * backslash separators for them, while joining/normalizing everything else
 * with POSIX separators. A console.warn fires once per page load so the
 * fallback is never silently active.
 *
 * Plain browser global (loads as a classic <script>, assigns
 * window.Documental.PathUtils) with a CommonJS export guard for unit
 * tests — same hybrid pattern as shared/i18n-apply.js. No build step.
 * @author Documental Team
 * @since 1.0.0
 */

/** Matches Windows drive-absolute paths: "C:\…" or "C:/…" */
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/**
 * Whether the given value looks like a Windows drive-absolute path
 * ("C:\Users" / "C:/Users"). Drive-RELATIVE ("C:Users") is not covered —
 * it is not produced by this app.
 * @param {unknown} p Candidate path.
 * @returns {boolean} True when p is a string starting with a drive letter.
 */
function isWindowsDrivePath(p) {
  return typeof p === 'string' && WINDOWS_DRIVE_RE.test(p);
}

/**
 * Trim trailing separators from a joined/normalized path while preserving
 * roots ("C:\" stays "C:\", "/" stays "/").
 * @param {string} p Path with a single-separator style already applied.
 * @param {'\\'|'/'} sep Separator style of p.
 * @returns {string} Path without trailing separators (root preserved).
 */
function trimTrailingSeparators(p, sep) {
  if (sep === '\\') {
    if (/^[A-Za-z]:\\$/.test(p)) return p; // drive root "C:\"
    return p.replace(/\\+$/, '');
  }
  if (p === '/') return p; // posix root
  return p.replace(/\/+$/, '');
}

/**
 * Fallback join (no electronAPI). Mirrors path.join semantics closely
 * enough for display: empty segments are ignored, duplicate separators
 * collapse, trailing separators are trimmed. Windows-drive inputs are
 * joined with "\" (separators unified to "\"), everything else with "/".
 * @param {unknown[]} segments Path segments.
 * @returns {string} Joined path.
 */
function fallbackJoinSync(segments) {
  const parts = [];
  for (const segment of segments) {
    if (typeof segment === 'string' && segment !== '') parts.push(segment);
  }
  if (parts.length === 0) return '';
  if (isWindowsDrivePath(parts[0])) {
    const joined = parts.join('\\').replace(/[\\/]+/g, '\\');
    return trimTrailingSeparators(joined, '\\');
  }
  const joined = parts.join('/').replace(/\/+/g, '/');
  return trimTrailingSeparators(joined, '/');
}

/**
 * Fallback normalize (no electronAPI). Windows-drive paths KEEP their
 * backslashes (separators unified to "\", trailing trimmed) — never
 * POSIX-ized. Everything else keeps "/" style (backslashes converted,
 * duplicates collapsed, trailing trimmed).
 * @param {string} filePath Path to normalize.
 * @returns {string} Normalized path.
 */
function fallbackNormalizeSync(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return filePath;
  if (isWindowsDrivePath(filePath)) {
    const normalized = filePath.replace(/[\\/]+/g, '\\');
    return trimTrailingSeparators(normalized, '\\');
  }
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
  return trimTrailingSeparators(normalized, '/');
}

/**
 * Create a PathUtils instance. `env` exists so unit tests can inject a fake
 * `window` (with or without electronAPI) and a warn spy; production callers
 * get the default instance bound to the real global window.
 * @param {{window?: {electronAPI?: object}, warn?: Function}} [env]
 *   Optional environment: fake window and/or warn function for tests.
 * @returns {{join: (async (...segments: string[]) => Promise<string>),
 *   normalize: (async (filePath: string) => Promise<string>)}}
 *   Async join/normalize utilities (same contract the inline PathUtils had).
 */
function createPathUtils(env) {
  env = env || {};
  let warned = false;

  function getWindow() {
    if (env.window) return env.window;
    if (typeof window !== 'undefined') return window;
    return {};
  }

  function warnOnce() {
    if (warned) return;
    warned = true;
    const warn =
      typeof env.warn === 'function'
        ? env.warn
        : typeof console !== 'undefined' && typeof console.warn === 'function'
          ? console.warn
          : null;
    if (warn) {
      warn(
        '[Documental][PathUtils] electronAPI unavailable — using browser ' +
          'fallback path handling (dev mode only). Paths may not match the host OS.'
      );
    }
  }

  return {
    join: async (...segments) => {
      const api = getWindow().electronAPI;
      if (api && typeof api.joinPath === 'function') {
        return api.joinPath(...segments);
      }
      warnOnce();
      return fallbackJoinSync(segments);
    },
    normalize: async (filePath) => {
      const api = getWindow().electronAPI;
      if (api && typeof api.normalizePath === 'function') {
        return api.normalizePath(filePath);
      }
      warnOnce();
      return fallbackNormalizeSync(filePath);
    }
  };
}

/** Default instance bound to the real window (or an empty env in Node). */
const PathUtils = createPathUtils();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PathUtils,
    createPathUtils,
    isWindowsDrivePath,
    fallbackJoinSync,
    fallbackNormalizeSync
  };
}
if (typeof window !== 'undefined') {
  window.Documental = window.Documental || {};
  window.Documental.PathUtils = PathUtils;
}
