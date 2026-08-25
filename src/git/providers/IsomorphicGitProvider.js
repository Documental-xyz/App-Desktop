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

// ─── Module-level loading (provider boundary — do not duplicate elsewhere) ──
// iso-git and its http transport are loaded LAZILY via dynamic import().
// This is deliberate (T11): vitest's vi.mock() intercepts import() (but NOT
// CommonJS require()) from transformed source files, so consumers migrated
// to GitService keep seeing the test mocks — exactly what the previous
// `await import('isomorphic-git')` in src/ipc/git.js did. In production the
// dynamic import of the CJS package resolves to the same cached module
// object as require() (named exports are live bindings to module.exports).
const fs = require('fs');

/** @type {Object|null} cached isomorphic-git namespace */
let _gitModule = null;
/** @type {Object|null} cached isomorphic-git http transport */
let _httpModule = null;

/**
 * Load (and cache) the isomorphic-git module namespace.
 * @returns {Promise<Object>}
 * @private
 */
async function loadGit() {
  if (!_gitModule) {
    _gitModule = await import('isomorphic-git');
  }
  return _gitModule;
}

/**
 * Load (and cache) the isomorphic-git http/node transport. Handles both the
 * real module (namespace or `.default` carrying `request`) and test mocks
 * (`{ default: {} }`).
 * @returns {Promise<Object>}
 * @private
 */
async function loadHttp() {
  if (!_httpModule) {
    _httpModule = unwrapHttp(await import('isomorphic-git/http/node'));
  }
  return _httpModule;
}

/**
 * Unwrap a dynamic-import namespace to the http transport object. Prefers
 * `.default` (CJS interop), but even PROBING `.default` throws on vitest
 * mock namespaces whose factory omitted it — hence the try/catch.
 * @param {Object} m - Imported module namespace (or module itself)
 * @returns {Object}
 */
function unwrapHttp(m) {
  try {
    if (m && m.default) {
      return m.default;
    }
  } catch (_e) {
    // vi.mock namespace without a `default` export — use the namespace as-is
  }
  return m;
}

const PROVIDER_NAME = 'isomorphic-git';

// App identity used when commit() gets no author and the repo config has
// none (mirrors git.js:1081).
const DEFAULT_AUTHOR = { name: 'documental', email: 'documental@app' };

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
  // No credentials offered — no onAuth key at all (call sites that
  // conditionally attach auth must keep the key absent, not undefined).
  return {};
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
async function wrap(provider, operation, fn) {
  let git;
  let http;
  try {
    [git, http] = await Promise.all([provider._gitModule(), provider._httpModule()]);
    return await fn(git, http);
  } catch (err) {
    if (err instanceof GitError) {
      throw err;
    }
    const gitError = new GitError({
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
    // Preserve isomorphic-git's structured error fields (code, data — e.g.
    // MergeConflictError.data lists conflicted files) so consumers' error
    // routing (git.js conflict/push-rejected checks) keeps working across
    // the GitError boundary.
    if (err && err.code !== undefined) gitError.code = err.code;
    if (err && err.data !== undefined) gitError.data = err.data;
    throw gitError;
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
  /**
   * @param {Object} [options]
   * @param {Function} [options.loadGit] - Override for the iso-git module loader.
   * @param {Function} [options.loadHttp] - Override for the http/node loader.
   */
  constructor({ loadGit, loadHttp } = {}) {
    /**
     * Module-source overrides. vi.mock() only intercepts imports in
     * vitest-transformed files; a consumer reached via CommonJS `require`
     * chains acquires iso-git through import() in its OWN transformed file
     * (mock-visible) and injects that acquisition here.
     * @type {Function|undefined}
     */
    this._loadGitOverride = loadGit;
    this._loadHttpOverride = loadHttp;
  }

  /** @returns {Promise<Object>} iso-git module (mock-aware in tests) */
  _gitModule() {
    return this._loadGitOverride ? this._loadGitOverride() : loadGit();
  }

  /** @returns {Promise<Object>} http/node transport (unwrapped) */
  async _httpModule() {
    return this._loadHttpOverride
      ? unwrapHttp(await this._loadHttpOverride())
      : loadHttp();
  }

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
    return wrap(this, 'clone', (git, http) => git.clone({
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
      auth, signal, singleBranch = true, depth, refspec, ...rest
    } = opts;
    return wrap(this, 'fetch', (git, http) => git.fetch({
      fs,
      http,
      dir: path,
      remote: 'origin',
      singleBranch,
      ...(depth !== undefined ? { depth } : {}),
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
    return wrap(this, 'pull', (git, http) => git.pull({
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
      auth, signal, remote = 'origin', branch, remoteRef,       force = false, ...rest
    } = opts;
    return wrap(this, 'push', (git, http) => git.push({
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
    const { auth, ...rest } = opts;
    return wrap(this, 'getRemoteInfo', (git, http) => git.getRemoteInfo({
      http,
      url,
      ...buildAuth(url, auth),
      ...rest,
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
    const { auth, ...rest } = opts;
    return wrap(this, 'listServerRefs', (git, http) => git.listServerRefs({
      http,
      url,
      ...buildAuth(url, auth),
      ...rest,
    }));
  }

  /**
   * Check whether a ref can be fast-forwarded onto a target without a
   * merge commit, i.e. whether `ref` is an ANCESTOR of `target`.
   *
   * F3-D1: isomorphic-git exports NO `canFastForward` — forwarding the
   * call verbatim always threw ("git.canFastForward is not a function"),
   * so every caller fell back to the merge path (the post-recovery
   * multi-merge-base breakage). The real ancestry API is `isDescendent`.
   *
   * @param {string} path - Local repository directory
   * @param {{ ref?: string, target?: string } & Record<string, unknown>} [opts]
   * @returns {Promise<boolean>}
   */
  async canFastForward(path, opts = {}) {
    const { ref, target, ...rest } = opts;
    return wrap(this, 'canFastForward', async (git) => {
      const ancestorOid = await git.resolveRef({ fs, dir: path, ref });
      const descendantOid = await git.resolveRef({
        fs,
        dir: path,
        ref: target === undefined ? 'HEAD' : target,
      });
      if (ancestorOid === descendantOid) {
        return true;
      }
      return git.isDescendent({
        fs,
        dir: path,
        oid: descendantOid,
        ancestor: ancestorOid,
        ...rest,
      });
    });
  }

  // ─── Local operations + reads (T10) ─────────────────────────────────────────
  //
  // Semantics MOVED from the current call sites (raw output parity — no
  // normalization of isomorphic-git results):
  //   - add/remove batching: git.js:500-502 (_commitAll), gitSafety.js:199-201
  //     (_createBackup), gitMergeDriver.js:79 (resolveBinaryTheirs)
  //   - commit: git.js:524 (message+author), git.js:1316-1321 (binary-resolved
  //     merge commit with explicit `parent`), gitSafety.js:221-226 (backup)
  //   - branch: git.js:666/731, gitOperations.js:258/307,
  //     gitSafety.js:160 (backup: checkout:false, force:false)
  //   - deleteBranch: git.js:1281/1334/1744 (temp-branch cleanup)
  //   - checkout: git.js:155/697/721/1283/1333/1746, gitOperations.js:268/321,
  //     projectCreation.js:396/403 (force:true), gitSafety.js:135/188/243
  //     (force true/false respectively) — `force`/`noBranch` are forwarded
  //     ONLY when provided (omission matters to iso-git)
  //   - merge: git.js:1293-1301/1756-1764/1997 (ours/theirs, fastForward:false,
  //     optional mergeDriver: theirsMergeDriver, message, author) — the whole
  //     options object is forwarded untouched so the mergeDriver contract
  //     (gitMergeDriver.js) keeps working verbatim
  //   - fastForward: git.js:1067 (ref + onAuth) — iso-git fastForward does a
  //     fetch under the hood, so http is always attached; onAuth from opts
  //     overrides the built-in auth plumbing (rest spreads after)
  //   - writeRef: git.js:148-154 / gitSafety.js:128-134 (refs/heads/<branch>,
  //     value: oid, force: true)
  //   - statusMatrix: git.js:408/480/884/1500, gitSafety.js:104 — returns the
  //     RAW rows [filepath, head, workdir, stage] exactly as iso-git produces
  //   - currentBranch: git.js:560/763/785, gitSafety.js:80/185/353 (cache opt)
  //   - listBranches: git.js:593, gitOperations.js:249/294/346,
  //     projectCreation.js:420-421 (remote: 'origin' variant)
  //   - listRefs: git.js:566
  //   - resolveRef: git.js:146/827/853/1538/1541/1721, gitSafety.js:81/88/127/310
  //   - readCommit: git.js:836/861, gitSafety.js:322, projectCreation.js:479
  //   - readBlob: gitMergeDriver.js:67 (oid + filepath)
  //   - getConfig/setConfig: git.js:808-813 (remote.origin.url + cache),
  //     git.js:738-739 (branch.<name>.remote/merge), gitOperations.js:177-190
  //     (user.name/user.email), 314-315, 601-602 (core.*), 625
  //
  // `cache` (the iso-git stat cache callers like git.js pass as
  // `this._gitCache`) and any other extra option flow through `...rest`
  // untouched — this provider never filters or transforms options/results.

  /**
   * Stage file(s) (hash + object store + index update). Contract:
   * `add(path, files)` where files is one path or an array of paths
   * relative to the repo root (iso-git's add is single-file, so an array
   * is staged per-entry). Extra options (e.g. cache) flow via opts.
   *
   * @param {string} path - Local repository directory
   * @param {string|string[]} files - File path(s) relative to the repo root
   * @param {Record<string, unknown>} [opts] - Extra iso-git options (cache…)
   * @returns {Promise<void>}
   */
  async add(path, files, opts = {}) {
    const list = Array.isArray(files) ? files : [files];
    const { ...rest } = opts;
    return wrap(this, 'add', async (git) => {
      for (const filepath of list) {
        await git.add({ fs, dir: path, filepath, ...rest });
      }
    });
  }

  /**
   * Remove file(s) from the index (stage deletions). Contract:
   * `remove(path, files)` — same array handling as add().
   *
   * @param {string} path - Local repository directory
   * @param {string|string[]} files - File path(s) relative to the repo root
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async remove(path, files, opts = {}) {
    const list = Array.isArray(files) ? files : [files];
    const { ...rest } = opts;
    return wrap(this, 'remove', async (git) => {
      for (const filepath of list) {
        await git.remove({ fs, dir: path, filepath, ...rest });
      }
    });
  }

  /**
   * Create a commit. Contract: `commit(path, message, opts?)` with
   * optional `author` (and any iso-git extra, e.g. `parent` for the
   * binary-resolved merge commit at git.js:1316-1321) in opts.
   *
   * When no author is supplied (opts or repo config), iso-git throws
   * MissingNameError; the app identity from git.js:1081
   * ('documental' <documental@app>) is used as fallback so the optional
   * `author` in the contract really is optional.
   *
   * @param {string} path - Local repository directory
   * @param {string} message - Commit message
   * @param {{ author?: { name?: string, email?: string } } & Record<string, unknown>} [opts]
   * @returns {Promise<string>} Commit OID (40-char SHA-1)
   */
  async commit(path, message, opts = {}) {
    const { author, ...rest } = opts;
    const run = (git, a) => git.commit({ fs, dir: path, message, ...(a ? { author: a } : {}), ...rest });
    return wrap(this, 'commit', async (git) => {
      try {
        return await run(git, author);
      } catch (err) {
        if (!author && err?.code === 'MissingNameError') {
          return run(git, DEFAULT_AUTHOR);
        }
        throw err;
      }
    });
  }

  /**
   * Create a branch. Moved from git.js:666/731, gitOperations.js:258/307,
   * gitSafety.js:160: `object` (start point, e.g. 'origin/<name>'),
   * `checkout: true` (create+switch) and `force` are forwarded only when
   * provided — omission semantics preserved (backup flow relies on
   * force:false/checkout:false being sent exactly).
   *
   * @param {string} path - Local repository directory
   * @param {string} ref - Branch name
   * @param {{ object?: string, checkout?: boolean, force?: boolean } & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async branch(path, ref, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'branch', (git) => git.branch({ fs, dir: path, ref, ...rest }));
  }

  /**
   * Delete a branch. Moved from the temp-branch cleanup paths
   * (git.js:1281/1334/1744 — callers wrap in try/catch for "not existent").
   *
   * @param {string} path - Local repository directory
   * @param {string} ref - Branch name to delete
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async deleteBranch(path, ref, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'deleteBranch', (git) => git.deleteBranch({ fs, dir: path, ref, ...rest }));
  }

  /**
   * Checkout a ref (branch, remote branch or commit). Moved from
   * git.js:155/697/1283/1746, gitSafety.js:135/188, projectCreation.js:396:
   * `force` and `noBranch` are forwarded ONLY when the caller provides
   * them — iso-git behavior differs between "absent" and "undefined".
   *
   * @param {string} path - Local repository directory
   * @param {string} ref - Ref to check out
   * @param {{ force?: boolean, noBranch?: boolean } & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async checkout(path, ref, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'checkout', (git) => git.checkout({ fs, dir: path, ref, ...rest }));
  }

  /**
   * Merge a ref into HEAD (contract: `merge(path, theirRef, opts?)`).
   * Moved from git.js:1293-1301/1756-1764/1997: opts carry `ours`,
   * `fastForward: false`, optional `mergeDriver` (the gitMergeDriver
   * theirs callback contract), `message`, `author` — forwarded untouched
   * so the mergeDriver contract keeps working verbatim. An explicit
   * `theirs` in opts overrides the positional theirRef (rest spreads
   * after). MergeConflictError surfaces with its original code/data via
   * wrap()'s cause chain.
   *
   * @param {string} path - Local repository directory
   * @param {string} theirRef - Ref to merge into HEAD
   * @param {{ ours?: string, theirs?: string, fastForward?: boolean, mergeDriver?: Function, message?: string, author?: object } & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async merge(path, theirRef, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'merge', (git) => git.merge({ fs, dir: path, theirs: theirRef, ...rest }));
  }

  /**
   * Fast-forward a branch to a remote ref. Moved from git.js:1067 (ref +
   * onAuth). iso-git's fastForward performs a fetch, so `http` is always
   * attached; an `onAuth` provided via opts overrides the built-in GitHub
   * guard (rest spreads after the auth plumbing, mirroring the network
   * methods above).
   *
   * @param {string} path - Local repository directory
   * @param {{ ref?: string, auth?: AuthInfo, signal?: AbortSignal } & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async fastForward(path, opts = {}) {
    const { auth, signal, ...rest } = opts;
    return wrap(this, 'fastForward', (git, http) => git.fastForward({
      fs,
      http,
      dir: path,
      ...(signal ? { signal } : {}),
      ...this._authForRemote(path, auth),
      ...rest,
    }));
  }

  /**
   * Write a ref. Contract: `writeRef(path, ref, oid)` — moved from
   * git.js:148-154, gitSafety.js:128-134 (`refs/heads/<branch>` + oid +
   * `force: true`, which flows via opts).
   *
   * @param {string} path - Local repository directory
   * @param {string} ref - Full ref name (e.g. 'refs/heads/main')
   * @param {string} oid - Commit OID to point the ref at
   * @param {{ force?: boolean } & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async writeRef(path, ref, oid, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'writeRef', (git) => git.writeRef({ fs, dir: path, ref, value: oid, ...rest }));
  }

  /**
   * Get the working-tree state matrix. Returns the RAW isomorphic-git
   * output — rows of `[filepath, headRefCount, workdirRefCount,
   * stageRefCount]` (0=absent, 1=present HEAD/tree variant) with NO
   * filtering or normalization (call sites filter themselves).
   *
   * @param {string} path - Local repository directory
   * @param {Record<string, unknown>} [opts] - e.g. `{ cache }`, `filter`
   * @returns {Promise<Array<[string, number, number, number]>>}
   */
  async statusMatrix(path, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'statusMatrix', (git) => git.statusMatrix({ fs, dir: path, ...rest }));
  }

  /**
   * Get the current branch name (moved from git.js:560/763/785,
   * gitSafety.js:80/185/353 — `cache` and `fullname` flow via opts).
   *
   * @param {string} path - Local repository directory
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<string|undefined>} Branch name (undefined when detached)
   */
  async currentBranch(path, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'currentBranch', (git) => git.currentBranch({ fs, dir: path, ...rest }));
  }

  /**
   * List local branches — or remote ones when `{ remote: 'origin' }`
   * (moved from git.js:593, gitOperations.js:249/294/346,
   * projectCreation.js:420-421). Returns the RAW string array.
   *
   * @param {string} path - Local repository directory
   * @param {{ remote?: string } & Record<string, unknown>} [opts]
   * @returns {Promise<string[]>}
   */
  async listBranches(path, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'listBranches', (git) => git.listBranches({ fs, dir: path, ...rest }));
  }

  /**
   * List all refs in the repository (moved from git.js:566). RAW output.
   *
   * @param {string} path - Local repository directory
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<string[]>} Ref paths (e.g. 'refs/heads/master')
   */
  async listRefs(path, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'listRefs', (git) => git.listRefs({ fs, dir: path, ...rest }));
  }

  /**
   * Resolve a ref to an OID (moved from git.js:146/827/1538/1721,
   * gitSafety.js:81/88/127/310 — supports 'HEAD', 'origin/x',
   * 'refs/remotes/origin/x', full ref paths).
   *
   * @param {string} path - Local repository directory
   * @param {string} ref - Ref to resolve
   * @param {Record<string, unknown>} [opts] - e.g. `{ cache }`, `{ depth }`
   * @returns {Promise<string>} 40-char commit OID
   */
  async resolveRef(path, ref, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'resolveRef', (git) => git.resolveRef({ fs, dir: path, ref, ...rest }));
  }

  /**
   * Read a commit object (moved from git.js:836/861, gitSafety.js:322,
   * projectCreation.js:479). RAW `{ oid, commit, payload }` output.
   *
   * @param {string} path - Local repository directory
   * @param {string} oid - Commit OID
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<{ oid: string, commit: object, payload: string }>}
   */
  async readCommit(path, oid, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'readCommit', (git) => git.readCommit({ fs, dir: path, oid, ...rest }));
  }

  /**
   * Read a blob (moved from gitMergeDriver.js:67 — oid + filepath for the
   * binary theirs fallback). RAW `{ oid, blob }` output (blob is Uint8Array).
   *
   * @param {string} path - Local repository directory
   * @param {string} oid - Commit/tree OID containing the file
   * @param {{ filepath: string } & Record<string, unknown>} opts
   * @returns {Promise<{ oid: string, blob: Uint8Array }>}
   */
  async readBlob(path, oid, opts) {
    return wrap(this, 'readBlob', (git) => git.readBlob({ fs, dir: path, oid, ...opts }));
  }

  /**
   * Read a config value (moved from git.js:808-813 `remote.origin.url` with
   * cache, gitOperations.js:625, projects.js:270). Returns `undefined` when
   * unset (iso-git behavior — no defaults injected).
   *
   * @param {string} path - Local repository directory
   * @param {string} configPath - Config key (e.g. 'remote.origin.url')
   * @param {Record<string, unknown>} [opts] - e.g. `{ cache }`, `{ all: true }`
   * @returns {Promise<string|string[]|undefined>}
   */
  async getConfig(path, configPath, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'getConfig', (git) => git.getConfig({ fs, dir: path, path: configPath, ...rest }));
  }

  /**
   * Write a config value (moved from git.js:738-739
   * `branch.<name>.remote`/`.merge`, gitOperations.js:177-190 user config,
   * 601-602 core.*).
   *
   * @param {string} path - Local repository directory
   * @param {string} configPath - Config key
   * @param {string} value - Config value
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async setConfig(path, configPath, value, opts = {}) {
    const { ...rest } = opts;
    return wrap(this, 'setConfig', (git) => git.setConfig({ fs, dir: path, path: configPath, value, ...rest }));
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
    if (!auth || !auth.token) {
      // No credentials — no onAuth key at all (parity with call sites that
      // attach onAuth only when a token exists).
      return {};
    }
    // Return an object whose onAuth resolves the remote URL lazily — the
    // remote URL is only known at call time, and buildAuth is sync-safe.
    const onAuth = async () => {
      let url = null;
      try {
        const remotes = await this._gitModule().then((git) => git.listRemotes({ fs, dir: path }));
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
