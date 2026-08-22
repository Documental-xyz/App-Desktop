/**
 * @fileoverview IsomorphicGitProvider — network operations (clone, fetch,
 * pull, push, getRemoteInfo, listServerRefs) over `isomorphic-git`.
 *
 * This file (together with the local-ops additions from T10) is the ONLY
 * place in the codebase allowed to `require('isomorphic-git')` and
 * `require('isomorphic-git/http/node')` — it is the provider-layer
 * boundary (plan checkbox 9; PRD §6.2–6.3).
 *
 * Semantics MOVED from the current call sites (not rewritten):
 *   - shallow fetch: `singleBranch: true, depth: 1` (src/ipc/git.js:1009,
 *     1520, 1707, 1955/1960; src/ipc/gitPreflight.js:369-381, 570-584)
 *   - clone: `singleBranch: true, depth: 10` (src/ipc/projects.js:63-75;
 *     src/ipc/projectCreation.js:314-325)
 *   - push: `remote: 'origin', force: false` + optional remoteRef
 *     (src/ipc/git.js:1361, 1690, 1732, 1792, 2057)
 *   - getRemoteInfo (src/ipc/projectCreation.js:141-145)
 *   - listServerRefs (src/ipc/git.js ~2145 ls-remote path)
 *   - GitHub-only token attach: host guard replicating
 *     projectCreation.js:270-274 — token is ONLY attached when the remote
 *     host is github.com; non-github hosts (incl. file://) get NO
 *     credentials from onAuth.
 *
 * Timeout/retry stays ABOVE this interface (gitFlowTypes/_raceTimeout/
 * _pushWithRetry); we only forward the optional `signal`.
 * All rejections from isomorphic-git are rethrown as GitError — raw
 * library errors never leak across the boundary.
 *
 * @implements {import('../GitProvider')}
 * @since 1.0.0
 */

'use strict';

const GitError = require('../GitError');

// ─── Module-level requires (provider boundary — do not duplicate elsewhere) ──
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const fs = require('fs');

const PROVIDER_NAME = 'isomorphic-git';

/**
 * @typedef {import('../GitTypes').AuthInfo} AuthInfo
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Whether a remote URL points at github.com (case-insensitive host check).
 * Replicates the guard in projectCreation.js:270-274, but via URL parsing
 * so any scheme/path variation is handled uniformly. Non-http(s) URLs
 * (e.g. file://) never match.
 *
 * @param {string} url - Remote URL
 * @returns {boolean}
 * @private
 */
function isGithubUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      parsed.host.toLowerCase() === 'github.com';
  } catch (_e) {
    return false;
  }
}

/**
 * Build the isomorphic-git auth plumbing for a remote URL.
 *
 * AuthInfo `{token}` is mapped to GitHub OAuth basic auth
 * (`{username: token, password: 'x-oauth-basic'}`) — but ONLY when the
 * host is github.com. For any other host, onAuth returns no credentials
 * (the remote either needs none or must fail without leaking a GitHub
 * token to a third-party server).
 *
 * @param {string} url - Remote URL
 * @param {AuthInfo} [auth] - Token auth info
 * @returns {{ onAuth: () => ({username: string, password: string}|undefined) }|{}}
 * @private
 */
function buildAuth(url, auth) {
  if (auth && auth.token && isGithubUrl(url)) {
    return { onAuth: () => ({ username: auth.token, password: 'x-oauth-basic' }) };
  }
  // No credentials offered (also mirrors call sites: onAuth: () => undefined).
  return { onAuth: () => undefined };
}

/**
 * Wrap a provider call so isomorphic-git rejections become GitError with
 * operation/provider context. Never lets raw library errors escape.
 *
 * @template T
 * @param {string} operation - Operation name for GitError
 * @param {() => Promise<T>} fn - Thunk running the isomorphic-git call
 * @returns {Promise<T>}
 * @private
 */
async function wrap(operation, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GitError) {
      throw err;
    }
    throw new GitError({
      operation,
      provider: PROVIDER_NAME,
      // isomorphic-git errors carry numeric/string codes (HttpError.data,
      // ENOENT, etc.) — no process exit codes here.
      exitCode: typeof err?.code === 'number' ? err.code : undefined,
      stderr: err?.data
        ? (typeof err.data === 'string' ? err.data : (err.data.message || err.message))
        : err?.message,
      cause: err,
    });
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * GitProvider implementation backed by isomorphic-git. Network operations
 * only in this file; local operations are added by T10 on the same class.
 *
 * @constructor
 * @implements {GitProvider}
 */
class IsomorphicGitProvider {
  // ─── Network operations ─────────────────────────────────────────────────────

  /**
   * Clone a repository. Defaults moved from src/ipc/projects.js:63-75 and
   * projectCreation.js:314-325: `singleBranch: true, depth: 10`, GitHub
   * token only for github.com URLs. Extra opts (ref, noCheckout, ...) are
   * passed through so callers keep the empty-clone-race / mkdir-race
   * handling from projectCreation.
   *
   * @param {string} url - Remote URL (HTTPS)
   * @param {string} path - Local destination directory
   * @param {import('../GitTypes').CloneOptions & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async clone(url, path, opts = {}) {
    const {
      auth, signal, noCheckout, singleBranch = true, depth = 10, ...rest
    } = opts;
    return wrap('clone', () => git.clone({
      fs,
      http,
      dir: path,
      url,
      singleBranch,
      depth,
      ...(noCheckout !== undefined ? { noCheckout } : {}),
      ...(signal ? { signal } : {}),
      ...buildAuth(url, auth),
      ...rest,
    }));
  }

  /**
   * Fetch from the remote. App-wide shallow semantics (git.js:1009/1520/
   * 1707/1955-1960, gitPreflight.js:369-381): `singleBranch: true,
   * depth: 1`, remote 'origin' — unless the caller overrides via opts.
   *
   * @param {string} path - Local repository directory
   * @param {import('../GitTypes').FetchOptions & Record<string, unknown>} [opts]
   * @returns {Promise<import('../GitTypes').FetchResult>}
   */
  async fetch(path, opts = {}) {
    const {
      auth, signal, singleBranch = true, depth = 1, refspec, ...rest
    } = opts;
    return wrap('fetch', () => git.fetch({
      fs,
      http,
      dir: path,
      remote: 'origin',
      singleBranch,
      depth,
      ...(refspec ? { refspec } : {}),
      ...(signal ? { signal } : {}),
      // Remote URL unknown here — token attach decided via remote URL below.
      ...this._authForRemote(path, auth),
      ...rest,
    }));
  }

  /**
   * Pull from the remote (fallback path; fetch+merge is preferred).
   *
   * @param {string} path - Local repository directory
   * @param {import('../GitTypes').PullOptions & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async pull(path, opts = {}) {
    const { auth, signal, fastForwardOnly, ...rest } = opts;
    return wrap('pull', () => git.pull({
      fs,
      http,
      dir: path,
      ...(fastForwardOnly !== undefined ? { fastForwardOnly } : {}),
      ...(signal ? { signal } : {}),
      ...this._authForRemote(path, auth),
      ...rest,
    }));
  }

  /**
   * Push local commits to the remote. Moved from git.js:1361/1690/1732/
   * 1792/2057: remote 'origin', force false, optional remoteRef (push
   * local branch to a differently-named remote branch — the temp-branch
   * publish flow), signal forwarded.
   *
   * @param {string} path - Local repository directory
   * @param {import('../GitTypes').PushOptions & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async push(path, opts = {}) {
    const {
      auth, signal, remote = 'origin', branch, remoteRef, force = false, ...rest
    } = opts;
    return wrap('push', () => git.push({
      fs,
      http,
      dir: path,
      remote,
      ...(branch ? { ref: branch } : {}),
      ...(remoteRef ? { remoteRef } : {}),
      force,
      ...(signal ? { signal } : {}),
      ...this._authForRemote(path, auth, remote),
      ...rest,
    }));
  }

  /**
   * Get info (capabilities, refs) about a remote repository. Moved from
   * projectCreation.js:141-145 (_probeRemoteRefs).
   *
   * @param {string} url - Remote URL
   * @param {{ auth?: AuthInfo }} [opts]
   * @returns {Promise<import('../GitTypes').RemoteInfo>}
   */
  async getRemoteInfo(url, opts = {}) {
    const { auth } = opts;
    return wrap('getRemoteInfo', () => git.getRemoteInfo({
      http,
      url,
      ...buildAuth(url, auth),
    }));
  }

  /**
   * List refs advertised by a remote server (ls-remote). Moved from the
   * remote-branch listing path in git.js (~2145).
   *
   * @param {string} url - Remote URL
   * @param {{ auth?: AuthInfo }} [opts]
   * @returns {Promise<import('../GitTypes').Ref[]>}
   */
  async listServerRefs(url, opts = {}) {
    const { auth } = opts;
    return wrap('listServerRefs', () => git.listServerRefs({
      http,
      url,
      ...buildAuth(url, auth),
    }));
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  /**
   * Resolve the auth plumbing for a repo-local operation (fetch/pull/push)
   * by reading the remote's URL from config, then applying the GitHub-only
   * token guard. When no auth is provided, mirrors call sites with
   * `onAuth: () => undefined`.
   *
   * @param {string} path - Local repository directory
   * @param {AuthInfo} [auth]
   * @param {string} [remote='origin']
   * @returns {{ onAuth: Function }} Options fragment for spread into the call.
   * @private
   */
  _authForRemote(path, auth, remote = 'origin') {
    // Return an object whose onAuth resolves the remote URL lazily — the
    // remote URL is only known at call time, and buildAuth is sync-safe.
    const onAuth = async () => {
      if (!auth || !auth.token) {
        return undefined;
      }
      let url = null;
      try {
        const remotes = await git.listRemotes({ fs, dir: path });
        url = (remotes.find((r) => r.remote === remote) || {}).url;
      } catch (_e) {
        url = null;
      }
      if (!url || !isGithubUrl(url)) {
        return undefined;
      }
      return { username: auth.token, password: 'x-oauth-basic' };
    };
    return { onAuth };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
// Named export (factory accepts `m.IsomorphicGitProvider || m`).
module.exports = { IsomorphicGitProvider };
