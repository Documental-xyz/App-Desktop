/**
 * @fileoverview GitService — thin facade over the active GitProvider
 * (main process only).
 *
 * Obtains the provider via `createGitProvider()` (GIT_PROVIDER-driven,
 * no silent fallback) and exposes the provider contract operations as
 * pure delegation — this layer holds NO git logic of its own. Timeouts,
 * locking, retry and AbortController management stay with the callers
 * (e.g. src/ipc/git.js), which own operation orchestration.
 *
 * @since 2.0.0
 */

'use strict';

const { createGitProvider } = require('./GitProviderFactory');

/**
 * Facade for the active git provider.
 *
 * Consumers inject this (same DI pattern as GitOperations in
 * src/ipc/git.js); an explicit `provider` wins for tests, otherwise the
 * configured provider is created lazily on first use so that merely
 * constructing the facade never requires the git runtime.
 *
 * @constructor
 */
class GitService {
  /**
   * @param {Object} [options]
   * @param {import('./GitProvider')} [options.provider] - Pre-built provider
   *   (dependency injection for tests; defaults to createGitProvider()).
   */
  constructor({ provider } = {}) {
    /** @type {import('./GitProvider')} */
    this._provider = provider || null;
  }

  /**
   * Resolve (and cache) the active provider instance.
   * @returns {import('./GitProvider')}
   * @private
   */
  _resolve() {
    if (!this._provider) {
      this._provider = createGitProvider();
    }
    return this._provider;
  }

  // ─── Network operations ─────────────────────────────────────────────────────

  /**
   * Clone a repository.
   * @param {string} url - Remote URL
   * @param {string} path - Local destination directory
   * @param {Object} [opts]
   * @returns {Promise<void>}
   */
  clone(url, path, opts) { return this._resolve().clone(url, path, opts); }

  /**
   * Fetch from the remote.
   * @param {string} path - Local repository directory
   * @param {Object} [opts]
   * @returns {Promise<import('./GitTypes').FetchResult>}
   */
  fetch(path, opts) { return this._resolve().fetch(path, opts); }

  /**
   * Pull from the remote.
   * @param {string} path - Local repository directory
   * @param {Object} [opts]
   * @returns {Promise<void>}
   */
  pull(path, opts) { return this._resolve().pull(path, opts); }

  /**
   * Push local commits to the remote.
   * @param {string} path - Local repository directory
   * @param {Object} [opts]
   * @returns {Promise<void>}
   */
  push(path, opts) { return this._resolve().push(path, opts); }

  /**
   * Get info about a remote repository.
   * @param {string} url - Remote URL
   * @param {Object} [opts]
   * @returns {Promise<import('./GitTypes').RemoteInfo>}
   */
  getRemoteInfo(url, opts) { return this._resolve().getRemoteInfo(url, opts); }

  /**
   * List refs advertised by a remote server (ls-remote).
   * @param {string} url - Remote URL
   * @param {Object} [opts]
   * @returns {Promise<import('./GitTypes').Ref[]>}
   */
  listServerRefs(url, opts) { return this._resolve().listServerRefs(url, opts); }

  /**
   * Check whether a ref can be fast-forwarded onto a target.
   * @param {string} path - Local repository directory
   * @param {Object} [opts]
   * @returns {Promise<boolean>}
   */
  canFastForward(path, opts) { return this._resolve().canFastForward(path, opts); }

  // ─── Local operations + reads ───────────────────────────────────────────────

  /**
   * Stage file(s).
   * @param {string} path - Local repository directory
   * @param {string|string[]} files - File path(s) relative to the repo root
   * @param {Object} [opts]
   * @returns {Promise<void>}
   */
  add(path, files, opts) { return this._resolve().add(path, files, opts); }

  /**
   * Remove file(s) from the index.
   * @param {string} path - Local repository directory
   * @param {string|string[]} files - File path(s) relative to the repo root
   * @param {Object} [opts]
   * @returns {Promise<void>}
   */
  remove(path, files, opts) { return this._resolve().remove(path, files, opts); }

  /**
   * Create a commit.
   * @param {string} path - Local repository directory
   * @param {string} message - Commit message
   * @param {Object} [opts] - e.g. `{ author }`, `{ parent }`
   * @returns {Promise<string>} Commit OID
   */
  commit(path, message, opts) { return this._resolve().commit(path, message, opts); }

  /**
   * Create a branch.
   * @param {string} path - Local repository directory
   * @param {string} ref - Branch name
   * @param {Object} [opts] - e.g. `{ object, checkout, force }`
   * @returns {Promise<void>}
   */
  branch(path, ref, opts) { return this._resolve().branch(path, ref, opts); }

  /**
   * Delete a branch.
   * @param {string} path - Local repository directory
   * @param {string} ref - Branch name to delete
   * @param {Object} [opts]
   * @returns {Promise<void>}
   */
  deleteBranch(path, ref, opts) { return this._resolve().deleteBranch(path, ref, opts); }

  /**
   * Checkout a ref.
   * @param {string} path - Local repository directory
   * @param {string} ref - Ref to check out
   * @param {Object} [opts] - e.g. `{ force, noBranch }`
   * @returns {Promise<void>}
   */
  checkout(path, ref, opts) { return this._resolve().checkout(path, ref, opts); }

  /**
   * Merge a ref into HEAD.
   * @param {string} path - Local repository directory
   * @param {string} theirRef - Ref to merge into HEAD
   * @param {Object} [opts] - e.g. `{ ours, fastForward, mergeDriver, message, author }`
   * @returns {Promise<void>}
   */
  merge(path, theirRef, opts) { return this._resolve().merge(path, theirRef, opts); }

  /**
   * Fast-forward a branch to a remote ref.
   * @param {string} path - Local repository directory
   * @param {Object} [opts] - e.g. `{ ref }`
   * @returns {Promise<void>}
   */
  fastForward(path, opts) { return this._resolve().fastForward(path, opts); }

  /**
   * Write a ref.
   * @param {string} path - Local repository directory
   * @param {string} ref - Full ref name (e.g. 'refs/heads/main')
   * @param {string} oid - Commit OID
   * @param {Object} [opts] - e.g. `{ force }`
   * @returns {Promise<void>}
   */
  writeRef(path, ref, oid, opts) { return this._resolve().writeRef(path, ref, oid, opts); }

  /**
   * Get the working-tree status matrix.
   * @param {string} path - Local repository directory
   * @param {Object} [opts] - e.g. `{ cache }`
   * @returns {Promise<Array<[string, number, number, number]>>}
   */
  statusMatrix(path, opts) { return this._resolve().statusMatrix(path, opts); }

  /**
   * Get the current branch name.
   * @param {string} path - Local repository directory
   * @param {Object} [opts] - e.g. `{ cache }`
   * @returns {Promise<string|undefined>}
   */
  currentBranch(path, opts) { return this._resolve().currentBranch(path, opts); }

  /**
   * List local (or remote, via `{ remote }`) branches.
   * @param {string} path - Local repository directory
   * @param {Object} [opts] - e.g. `{ remote: 'origin', cache }`
   * @returns {Promise<string[]>}
   */
  listBranches(path, opts) { return this._resolve().listBranches(path, opts); }

  /**
   * List all refs in the repository.
   * @param {string} path - Local repository directory
   * @param {Object} [opts]
   * @returns {Promise<string[]>}
   */
  listRefs(path, opts) { return this._resolve().listRefs(path, opts); }

  /**
   * Resolve a ref to an OID.
   * @param {string} path - Local repository directory
   * @param {string} ref - Ref to resolve
   * @param {Object} [opts] - e.g. `{ cache }`
   * @returns {Promise<string>}
   */
  resolveRef(path, ref, opts) { return this._resolve().resolveRef(path, ref, opts); }

  /**
   * Read a commit object.
   * @param {string} path - Local repository directory
   * @param {string} oid - Commit OID
   * @param {Object} [opts] - e.g. `{ cache }`
   * @returns {Promise<{ oid: string, commit: object, payload: string }>}
   */
  readCommit(path, oid, opts) { return this._resolve().readCommit(path, oid, opts); }

  /**
   * Read a blob.
   * @param {string} path - Local repository directory
   * @param {string} oid - Commit/tree OID containing the file
   * @param {Object} [opts] - e.g. `{ filepath }`
   * @returns {Promise<{ oid: string, blob: Uint8Array }>}
   */
  readBlob(path, oid, opts) { return this._resolve().readBlob(path, oid, opts); }

  /**
   * Read a config value.
   * @param {string} path - Local repository directory
   * @param {string} configPath - Config key (e.g. 'remote.origin.url')
   * @param {Object} [opts] - e.g. `{ cache }`
   * @returns {Promise<string|string[]|undefined>}
   */
  getConfig(path, configPath, opts) { return this._resolve().getConfig(path, configPath, opts); }

  /**
   * Write a config value.
   * @param {string} path - Local repository directory
   * @param {string} configPath - Config key
   * @param {string} value - Config value
   * @param {Object} [opts]
   * @returns {Promise<void>}
   */
  setConfig(path, configPath, value, opts) { return this._resolve().setConfig(path, configPath, value, opts); }
}

module.exports = { GitService };
