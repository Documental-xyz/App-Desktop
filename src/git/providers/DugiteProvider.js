/**
 * @fileoverview DugiteProvider — network operations (clone, fetch, pull,
 * push, getRemoteInfo, listServerRefs) over the bundled Git shipped with
 * `dugite`.
 *
 * This file is one of the ONLY places allowed to `require('dugite')` —
 * it is the provider-layer boundary (plan checkbox 15; PRD §6.2–6.3).
 * Local operations are added to this same class by T16.
 *
 * Semantics mirrored from IsomorphicGitProvider (T9/T10), which moved
 * them verbatim from the call sites:
 *   - shallow fetch: `singleBranch: true, depth: 1`
 *     (src/ipc/git.js:1009/1520/1707/1955-1960; gitPreflight.js:369-381)
 *   - clone: `singleBranch: true, depth: 10`
 *     (src/ipc/projects.js:63-75; projectCreation.js:314-325)
 *   - push: remote 'origin', force false, optional remoteRef →
 *     `git push <remote> refs/heads/<branch>:refs/heads/<remoteRef>`
 *     (src/ipc/git.js:1361/1690/1732/1792/2057)
 *   - GitHub-only token guard: the token is attached ONLY when the
 *     remote host is github.com (https), replicating
 *     projectCreation.js:270-274. For repo-local ops the remote URL is
 *     read via `git config --get remote.<name>.url` BEFORE deciding.
 *
 * AUTH MODEL (GIT_ASKPASS):
 *   - dugite exec passes argv straight to `execFile(gitBinary, args)` —
 *     argv is visible in `ps`, so the token NEVER goes there and NEVER
 *     goes into the URL or logs.
 *   - Instead, a temporary helper script (mode 0755, shebang `#!/bin/sh`,
 *     unique name in the OS temp dir) is written and exposed via
 *     `env.GIT_ASKPASS` as the PLAIN absolute path — git execs the
 *     GIT_ASKPASS value DIRECTLY (execvp, no shell; a real-user log
 *     showed `cannot exec 'sh "<path>"'` when the value was wrapped in
 *     a shell quoting) — so the file must be executable and carry its
 *     own interpreter line. Git invokes it with the prompt ("Username
 *     for ...:" / "Password for ...:") and the script answers the
 *     token / `x-oauth-basic`. The token itself reaches the helper
 *     through a process-env var (inherited by the git process and its
 *     children) — not embedded in the script, not in argv, not in any
 *     URL.
 *   - The helper file is DELETED in a `finally` after every operation.
 *   - `GIT_TERMINAL_PROMPT: '0'` guarantees git fails instead of
 *     hanging on a terminal prompt (message classifies as 'auth').
 *
 * ENVIRONMENT (T8 learning): dugite's `exec` internally calls
 * `setupEnvironment(options.env)`, which merges our custom env on top
 * of the full bundled-Git contract (GIT_EXEC_PATH, GIT_CONFIG_SYSTEM,
 * GIT_TEMPLATE_DIR, PREFIX, GIT_SSL_CAINFO). This is what makes local
 * transports (file:/// or plain-path remotes) work — git can spawn
 * git-upload-pack/git-receive-pack. No manual env assembly here.
 *
 * CLONE OUTPUT SIZE: dugite v3 `exec` defaults `maxBuffer` to
 * `Infinity` (node_modules/dugite/build/lib/exec.js), so large clone
 * output cannot truncate/fail the call — we use `exec` (not `spawn`)
 * and document that choice here.
 *
 * CANCELLATION (difference vs isomorphic-git, T9): dugite forwards
 * `options.signal` to `execFile`, which KILLS the child git process on
 * abort. iso-git's http/node transport does NOT honor an in-flight
 * AbortSignal — the timeout race above the provider must stay (T11/T12),
 * but with dugite the kill is real.
 *
 * ERRORS: dugite v3 resolves `{stdout, stderr, exitCode}` even when
 * `exitCode !== 0` (does NOT throw). Every call checks exitCode and
 * throws `GitError` with the raw stderr (the GitError constructor
 * sanitizes tokens out) — `GitError.classifyError` maps git CLI
 * patterns: 'Authentication failed'/'could not read Username'→auth,
 * 'non-fast-forward'/'rejected'→conflict, 'Could not resolve host'/
 * 'Connection'→network.
 *
 * @implements {import('../GitProvider')}
 * @since 1.0.0
 */

'use strict';

const { exec } = require('dugite');
const GitError = require('../GitError');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PROVIDER_NAME = 'dugite';

// App identity used when commit() gets no author and the repo config has
// none — identical to IsomorphicGitProvider's DEFAULT_AUTHOR (T10, which
// mirrors git.js:1081).
const DEFAULT_AUTHOR = { name: 'documental', email: 'documental@app' };

/**
 * Env var the askpass helper reads the token from. The variable exists
 * only in the environment of the single git operation being run.
 * @type {string}
 */
const ASKPASS_TOKEN_ENV = 'SMC_GIT_ASKPASS_TOKEN';

/**
 * @typedef {import('../GitTypes').AuthInfo} AuthInfo
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Whether a remote URL points at github.com (case-insensitive host
 * check). Identical guard to IsomorphicGitProvider.isGithubUrl —
 * non-http(s) URLs (file://, local paths) never match, so a GitHub
 * token is never offered to third-party/local remotes.
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
    // Not a parseable URL — e.g. a local path remote ('/tmp/repo.git').
    return false;
  }
}

/**
 * Body of the askpass helper. Reads the token from the environment
 * (never embedded in the file). POSIX `sh` — the script MUST start
 * with a `#!/bin/sh` shebang because git execs the GIT_ASKPASS value
 * DIRECTLY (execvp, no shell), so the file is a real executable.
 *
 * @type {string}
 */
const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  `case "$1" in`,
  `  *[Pp]assword*) printf '%s' 'x-oauth-basic' ;;`,
  `  *) printf '%s' "$${ASKPASS_TOKEN_ENV}" ;;`,
  `esac`,
  '',
].join('\n');

/**
 * Create the temporary askpass helper (mode 0755, unique name in the
 * OS temp dir). Returns the env fragment to merge into the dugite exec
 * env plus a `cleanup()` that removes the file.
 *
 * @param {string} token - GitHub OAuth/PAT token (env-only, never argv)
 * @returns {{ env: Object, cleanup: () => void }}
 * @private
 */
function createAskpass(token) {
  const helperPath = path.join(
    os.tmpdir(),
    `git-askpass-${process.pid}-${crypto.randomBytes(6).toString('hex')}.sh`
  );
  // 0755 + shebang: git execs the GIT_ASKPASS value DIRECTLY
  // (execvp, no shell), so the helper must be a standalone
  // executable. The token is NOT in the file — only its env var name.
  fs.writeFileSync(helperPath, ASKPASS_SCRIPT, { mode: 0o755 });
  return {
    env: {
      GIT_ASKPASS: helperPath,
      GIT_TERMINAL_PROMPT: '0',
      [ASKPASS_TOKEN_ENV]: token,
    },
    cleanup() {
      try {
        fs.unlinkSync(helperPath);
      } catch (_e) {
        // Already gone / unreadable — best-effort removal.
      }
    },
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * GitProvider implementation backed by the dugite-bundled Git CLI.
 * Network operations only in this file; local operations are added by
 * T16 on the same class.
 *
 * @constructor
 * @implements {GitProvider}
 */
class DugiteProvider {
  // ─── Network operations ─────────────────────────────────────────────────────

  /**
   * Clone a repository. Defaults moved from src/ipc/projects.js:63-75
   * and projectCreation.js:314-325: `singleBranch: true, depth: 10`.
   *
   * @param {string} url - Remote URL (HTTPS)
   * @param {string} destPath - Local destination directory
   * @param {import('../GitTypes').CloneOptions & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async clone(url, destPath, opts = {}) {
    const {
      auth, signal, noCheckout = false, singleBranch = true, depth = 10,
    } = opts;
    const args = ['clone', '--origin', 'origin'];
    if (singleBranch) {
      args.push('--single-branch');
    }
    if (depth !== undefined) {
      args.push('--depth', String(depth));
    }
    if (noCheckout) {
      args.push('--no-checkout');
    }
    args.push('--', url, destPath);
    await this._run('clone', args, undefined, { url, auth, signal });
  }

  /**
   * Fetch from the remote. App-wide shallow semantics: `singleBranch:
   * true, depth: 1`, remote 'origin' — unless overridden via opts.
   *
   * @param {string} repoPath - Local repository directory
   * @param {import('../GitTypes').FetchOptions & Record<string, unknown>} [opts]
   * @returns {Promise<import('../GitTypes').FetchResult>}
   */
  async fetch(repoPath, opts = {}) {
    const {
      auth, signal, singleBranch = true, depth = 1, refspec, remote = 'origin',
      branch,
    } = opts;
    const args = ['fetch'];
    if (depth !== undefined) {
      args.push('--depth', String(depth));
    }
    args.push(remote);
    if (refspec) {
      args.push(refspec);
    } else if (singleBranch) {
      // `--single-branch` is a clone-only flag; for fetch the iso-git
      // semantics translate to an explicit refspec for the one branch
      // being tracked (configured by clone --single-branch).
      const name = branch || await this._currentBranchName(repoPath);
      if (name) {
        args.push(`+refs/heads/${name}:refs/remotes/${remote}/${name}`);
      }
      // No branch resolvable (empty repo/detached) → fetch configured
      // refspecs as-is.
    }
    await this._run('fetch', args, repoPath, { repoPath, remote, auth, signal });
    // dugite has no structured FetchResult equivalent; iso-git's
    // optional fields (defaultBranch/fetchHead/pruned) are all
    // optional in the contract — resolve a bare result.
    return {};
  }

  /**
   * Pull from the remote (fallback path; fetch+merge is preferred).
   *
   * @param {string} repoPath - Local repository directory
   * @param {import('../GitTypes').PullOptions & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async pull(repoPath, opts = {}) {
    const {
      auth, signal, fastForwardOnly = false, remote = 'origin',
    } = opts;
    const args = ['pull'];
    if (fastForwardOnly) {
      args.push('--ff-only');
    }
    args.push(remote);
    await this._run('pull', args, repoPath, { repoPath, remote, auth, signal });
  }

  /**
   * Push local commits to the remote. Moved from git.js:1361/1690/1732/
   * 1792/2057: remote 'origin', force false, optional remoteRef (push
   * local branch to a differently-named remote branch — the temp-branch
   * publish flow) → `refs/heads/<branch>:refs/heads/<remoteRef>`.
   *
   * `ref` is accepted as an alias of `branch` — `_pushWithRetry`
   * (gitOperations.js) sends `ref` (iso-git's key) and the contract
   * must not silently drop it. A refspec starting with `:` is a DELETE
   * in the git CLI, so `remoteRef` without a branch resolves the
   * current branch first (iso-git semantics: push HEAD to remoteRef);
   * `HEAD` is used as the source when no branch is checked out.
   *
   * @param {string} repoPath - Local repository directory
   * @param {import('../GitTypes').PushOptions & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async push(repoPath, opts = {}) {
    const {
      auth, signal, remote = 'origin', branch, ref, remoteRef, force = false,
    } = opts;
    const src = branch ?? ref;
    let refspec = null;
    if (src && remoteRef) {
      refspec = `refs/heads/${src}:refs/heads/${remoteRef}`;
    } else if (src) {
      refspec = `refs/heads/${src}`;
    } else if (remoteRef) {
      // Never `:refs/heads/<remoteRef>` — that is branch DELETION in
      // the git CLI. iso-git pushes the current branch instead.
      const current = await this._currentBranchName(repoPath);
      const source = current ? `refs/heads/${current}` : 'HEAD';
      refspec = `${source}:refs/heads/${remoteRef}`;
    }
    const args = ['push'];
    if (force) {
      args.push('--force');
    }
    args.push(remote);
    if (refspec) {
      args.push(refspec);
    }
    await this._run('push', args, repoPath, { repoPath, remote, auth, signal });
  }

  /**
   * Get info (refs) about a remote repository via `git ls-remote`.
   * Moved from projectCreation.js:141-145 (_probeRemoteRefs).
   *
   * @param {string} url - Remote URL
   * @param {{ auth?: AuthInfo, signal?: AbortSignal }} [opts]
   * @returns {Promise<import('../GitTypes').RemoteInfo>}
   */
  async getRemoteInfo(url, opts = {}) {
    const { auth, signal } = opts;
    const stdout = await this._runLsRemote(url, { url, auth, signal });
    /** @type {Object.<string, {oid: string}>} */
    const refs = {};
    for (const [ref, oid] of parseLsRemote(stdout)) {
      refs[ref] = { oid };
    }
    return { refs };
  }

  /**
   * List refs advertised by a remote server via `git ls-remote`.
   * Moved from the remote-branch listing path in git.js (~2145).
   *
   * @param {string} url - Remote URL
   * @param {{ auth?: AuthInfo, signal?: AbortSignal }} [opts]
   * @returns {Promise<import('../GitTypes').Ref[]>}
   */
  async listServerRefs(url, opts = {}) {
    const { auth, signal } = opts;
    const stdout = await this._runLsRemote(url, { url, auth, signal });
    return [...parseLsRemote(stdout)].map(([ref, oid]) => ({ ref, oid }));
  }

  // ─── Local operations + reads (T16) ─────────────────────────────────────────
  //
  // Signatures + return formats MIRROR IsomorphicGitProvider (T10) — the
  // dual-provider suite (T18) runs the same checks against both providers,
  // so parity of contract is king. Local ops never need auth: no askpass,
  // no remote resolution — `_run` is called with `{ repoPath, signal }`
  // only (auth is only honored when `ctx.auth.token` exists, which local
  // callers never pass).

  /**
   * Stage file(s). Contract parity with T10: `add(path, files)` where
   * files is one path or an array of paths relative to the repo root.
   * Translation: single `git add -- <files...>` (iso-git stages
   * per-entry; one CLI call is equivalent).
   *
   * @param {string} path - Local repository directory
   * @param {string|string[]} files - File path(s) relative to the repo root
   * @param {Record<string, unknown>} [opts] - Extra options (ignored — no iso-git cache equivalent)
   * @returns {Promise<void>}
   */
  async add(path, files, _opts = {}) {
    const list = Array.isArray(files) ? files : [files];
    await this._run('add', ['add', '--', ...list], path, { repoPath: path });
  }

  /**
   * Remove file(s) from the index, KEEPING the working-directory copy —
   * iso-git 1.38.4 `remove` is index-only (empirically [1,1,0] in the
   * status matrix; the dual-provider suite pins that contract). CLI:
   * `git rm --cached -f --` (`-f` because staged-but-modified files
   * would otherwise be rejected — iso-git has no such guard).
   *
   * @param {string} path - Local repository directory
   * @param {string|string[]} files - File path(s) relative to the repo root
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async remove(path, files, _opts = {}) {
    const list = Array.isArray(files) ? files : [files];
    await this._run(
      'remove',
      ['rm', '--cached', '-f', '--', ...list],
      path,
      { repoPath: path }
    );
  }

  /**
   * Create a commit. Contract parity with T10: `commit(path, message,
   * opts?)`; the returned OID comes from a second `git rev-parse HEAD`
   * call. Author handling mirrors iso-git's MissingNameError fallback:
   * first try the repo's own config; when git reports a missing
   * identity, retry with the app identity
   * ('documental' <documental@app> — git.js:1081, same as T10).
   *
   * @param {string} path - Local repository directory
   * @param {string} message - Commit message
   * @param {{ author?: { name?: string, email?: string } } & Record<string, unknown>} [opts]
   * @returns {Promise<string>} Commit OID (40-char SHA-1)
   */
  async commit(path, message, opts = {}) {
    const { author } = opts;
    const identity = [];
    if (author && author.name) {
      identity.push('-c', `user.name=${author.name}`);
    }
    if (author && author.email) {
      identity.push('-c', `user.email=${author.email}`);
    }
    const run = (extra) => this._run(
      'commit',
      [...extra, 'commit', '-m', message],
      path,
      { repoPath: path }
    );
    if (!author && identity.length === 0) {
      // Parity with T10's MissingNameError fallback: iso-git reads ONLY
      // the repo-local config, so a global user.name must NOT win — when
      // the local config has no identity, use the app identity.
      const name = await this.getConfig(path, 'user.name');
      const email = await this.getConfig(path, 'user.email');
      if (!name || !email) {
        identity.push(
          '-c', `user.name=${DEFAULT_AUTHOR.name}`,
          '-c', `user.email=${DEFAULT_AUTHOR.email}`
        );
      }
    }
    await run(identity);
    return this._run('commit', ['rev-parse', 'HEAD'], path, { repoPath: path })
      .then((out) => out.trim());
  }

  /**
   * Create a branch. Contract parity with T10's `branch(path, ref, opts?)`
   * (iso-git `object` = start point, `force`, `checkout: true` =
   * create + switch). Translation: `git branch [--force] <ref> [object]`,
   * followed by `git checkout <ref>` when `opts.checkout` is true.
   *
   * @param {string} path - Local repository directory
   * @param {string} ref - Branch name
   * @param {{ object?: string, checkout?: boolean, force?: boolean } & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async branch(path, ref, opts = {}) {
    const { object, checkout, force } = opts;
    const args = ['branch'];
    if (force) {
      args.push('--force');
    }
    args.push(ref);
    if (object) {
      args.push(object);
    }
    await this._run('branch', args, path, { repoPath: path });
    if (checkout) {
      await this._run('checkout', ['checkout', ref], path, { repoPath: path });
    }
  }

  /**
   * Delete a branch. `git branch -D` — iso-git's deleteBranch deletes
   * even when the branch is not merged, so `-D` is the parity choice
   * (`-d` would refuse).
   *
   * @param {string} path - Local repository directory
   * @param {string} ref - Branch name to delete
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async deleteBranch(path, ref, _opts = {}) {
    await this._run('deleteBranch', ['branch', '-D', ref], path, { repoPath: path });
  }

  /**
   * Checkout a ref. Contract parity with T10's `checkout(path, ref,
   * opts?)`. Translation notes (iso-git → CLI, honest mapping):
   *   - `force` → `git checkout -f`
   *   - `createBranch` (GitTypes CheckoutOptions) → `git checkout -b`
   *   - `noBranch: true` → iso-git semantics here are "point the ref at
   *     HEAD's commit without moving HEAD or the worktree", which is
   *     exactly `git branch <ref>` (documented translation — iso-git
   *     checkout with noBranch creates the branch but checks out
   *     nothing).
   *
   * @param {string} path - Local repository directory
   * @param {string} ref - Ref to check out
   * @param {{ force?: boolean, createBranch?: string, noBranch?: boolean } & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async checkout(path, ref, opts = {}) {
    const { force, createBranch, noBranch } = opts;
    if (noBranch) {
      await this._run('checkout', ['branch', ref], path, { repoPath: path });
      return;
    }
    const args = ['checkout'];
    if (force) {
      args.push('-f');
    }
    if (createBranch) {
      args.push('-b', createBranch);
    }
    args.push(ref);
    await this._run('checkout', args, path, { repoPath: path });
  }

  /**
   * Merge a ref into HEAD. Contract parity with T10's `merge(path,
   * theirRef, opts?)`; returns MergeResult (T10 returns the raw iso-git
   * merge oid — the contract shape is `{oid, alreadyMerged, fastForward}`).
   *
   * Translation:
   *   - `strategy: 'theirs'|'ours'` (GitTypes MergeOptions) → `-X theirs|ours`
   *   - legacy iso-git booleans `ours: true` / `theirs: true` (git.js
   *     call sites) → same `-X` mapping; a STRING `theirs` in opts
   *     overrides the positional theirRef (rest-spread parity with T10)
   *   - `mergeDriver` (a JS callback such as oursMergeDriver /
   *     theirsMergeDriver): a callback cannot cross a CLI boundary, so
   *     the driver's INTENT is translated to the equivalent native
   *     flag (`git merge -X ours` / `-X theirs`). Intent detection
   *     (contract with src/ipc/gitMergeDriver.js, git-sync-strategy
   *     Task 3):
   *       1. `mergeDriver.direction === 'ours' | 'theirs'` marker, OR
   *       2. the named exports `oursMergeDriver` / `theirsMergeDriver`,
   *          detected via the function's `name` (reference comparison
   *          would require importing the ipc layer from the provider
   *          layer — a dependency inversion; the name check survives
   *          CJS require and vitest's transforms).
   *     Any OTHER callback is an untranslatable custom driver → the
   *     merge FAILS EXPLICITLY before `git merge` runs (never silently
   *     degraded to `-X theirs` as the old code did).
   *
   *     Residual divergences vs isomorphic-git drivers (documented,
   *     accepted at hunk granularity):
   *       - `-X ours|theirs` operates per conflicting hunk exactly like
   *         the JS drivers (non-conflicting changes from both sides are
   *         always kept), BUT delete/modify conflicts are NOT resolved
   *         by `-X` (git leaves them conflicted → errorType 'conflict')
   *         whereas the iso-git drivers resolve them to the winning
   *         side's content (including deletion, contents[2] = '').
   *       - dugite's merge also rewrites the working tree (git CLI
   *         semantics); iso-git write ops leave the worktree stale —
   *         callers must read the committed tree, not the files.
   *   - `fastForward: false` (git.js merge call sites) → `--no-ff`
   *
   * Conflicts: exitCode ≠ 0 with CONFLICT in stderr → GitError whose
   * stderr contains "merge conflict"-class text → errorType 'conflict'
   * (GitError.classifyError). oid is only set when a merge COMMIT was
   * created (absent on fast-forward / already-up-to-date, per GitTypes).
   *
   * @param {string} path - Local repository directory
   * @param {string} theirRef - Ref to merge into HEAD
   * @param {{ strategy?: 'theirs'|'ours'|'ort', ours?: boolean, theirs?: boolean|string, fastForward?: boolean, mergeDriver?: Function, message?: string } & Record<string, unknown>} [opts]
   * @returns {Promise<import('../GitTypes').MergeResult>}
   */
  /**
   * Resolve a JS mergeDriver callback's INTENT to a native `-X` favor.
   * Detection contract (see merge JSDoc): `direction` marker property
   * first, then the canonical names oursMergeDriver/theirsMergeDriver.
   * Returns 'ours' | 'theirs' | null (null = no recognizable intent).
   * @param {Function} driver
   * @returns {'ours'|'theirs'|null}
   */
  static mergeDriverFavor(driver) {
    if (driver && (driver.direction === 'ours' || driver.direction === 'theirs')) {
      return driver.direction;
    }
    if (typeof driver?.name === 'string') {
      if (driver.name === 'oursMergeDriver') return 'ours';
      if (driver.name === 'theirsMergeDriver') return 'theirs';
    }
    return null;
  }

  async merge(path, theirRef, opts = {}) {
    const { strategy, ours, theirs, fastForward, mergeDriver, message } = opts;
    const ref = typeof theirs === 'string' ? theirs : theirRef;
    const args = ['merge', '--no-edit'];
    const favor = strategy === 'theirs' || strategy === 'ours'
      ? strategy
      : (theirs === true ? 'theirs' : (ours === true ? 'ours' : null));
    if (favor) {
      args.push('-X', favor);
    } else if (mergeDriver) {
      // Untranslatable custom driver: fail EXPLICITLY — never silently
      // degrade to a default strategy (would invert ours/theirs intent).
      const driverFavor = DugiteProvider.mergeDriverFavor(mergeDriver);
      if (!driverFavor) {
        throw new GitError({
          operation: 'merge',
          provider: PROVIDER_NAME,
          exitCode: 1,
          stderr:
            `unsupported mergeDriver callback "${mergeDriver?.name || 'anonymous'}": ` +
            'dugite can only translate drivers whose intent is ours/theirs ' +
            "(marker property direction: 'ours'|'theirs' or the named " +
            'exports oursMergeDriver/theirsMergeDriver); refusing to run ' +
            'the merge with a wrong default strategy',
        });
      }
      args.push('-X', driverFavor);
    }
    if (fastForward === false) {
      args.push('--no-ff');
    }
    if (message) {
      args.push('-m', message);
    }
    args.push(ref);
    const stdout = await this._run('merge', args, path, { repoPath: path });
    if (/Already up to date/i.test(stdout)) {
      return { alreadyMerged: true };
    }
    if (/Fast-forward/i.test(stdout)) {
      return { fastForward: true };
    }
    const oid = (await this._run(
      'merge',
      ['rev-parse', 'HEAD'],
      path,
      { repoPath: path }
    )).trim();
    return { oid };
  }

  /**
   * Fast-forward a branch to a ref (default: the current branch's
   * upstream `@{u}`). Contract: boolean — true when a fast-forward
   * happened, false when already up to date (iso-git fastForward throws
   * on non-ff; here a non-ff "Not possible to fast-forward" surfaces as
   * GitError → errorType 'conflict', mirroring that behavior).
   *
   * NOTE (difference): iso-git's fastForward performs a FETCH first;
   * this CLI translation only moves the local ref — callers fetch
   * separately (the app always does fetch+ff via the provider).
   *
   * @param {string} path - Local repository directory
   * @param {{ ref?: string, signal?: AbortSignal } & Record<string, unknown>} [opts]
   * @returns {Promise<boolean>} True if fast-forwarded; false if already up to date
   */
  async fastForward(path, opts = {}) {
    const { ref, signal } = opts;
    const args = ['merge', '--ff-only', ref || '@{u}'];
    let stdout;
    try {
      stdout = await this._run('fastForward', args, path, { repoPath: path, signal });
    } catch (err) {
      if (/Already up to date/i.test(err?.stderr || '')) {
        return false;
      }
      throw err;
    }
    return !/Already up to date/i.test(stdout);
  }

  /**
   * Write a ref. Contract parity with T10's `writeRef(path, ref, oid,
   * opts?)` (iso-git `value`). Translation: `git update-ref <ref> <oid>`;
   * `force: true` adds `--no-deref` (writing through symrefs is exactly
   * what iso-git's non-force mode forbids).
   *
   * @param {string} path - Local repository directory
   * @param {string} ref - Full ref name (e.g. 'refs/heads/main')
   * @param {string} oid - Commit OID to point the ref at
   * @param {{ force?: boolean } & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async writeRef(path, ref, oid, opts = {}) {
    const { force } = opts;
    const args = ['update-ref', ref, oid];
    if (force) {
      args.push('--no-deref');
    }
    await this._run('writeRef', args, path, { repoPath: path });
  }

  /**
   * Get the working-tree state matrix — REAL parity with isomorphic-git's
   * statusMatrix (T17). Rows `[filepath, head, workdir, stage]`.
   *
   * iso-git builds rows from the OIDs of the three trees (HEAD, WORKDIR,
   * STAGE) via `entry = [undefined, headOid, workdirOid, stageOid];
   * entry.map(v => entry.indexOf(v))` — so a value is the rank of the
   * first equal OID in the triple: 0 = absent, 1/2 = distinct present
   * OIDs, and 3 can occur (e.g. staged add + workdir-deleted →
   * `[file,0,0,3]`; modify/modify conflict → `[file,1,2,3]`). This
   * implementation reconstructs the same triple from git plumbing:
   *
   *   - head:   `git ls-tree -r -z HEAD`   (unborn HEAD → empty tree,
   *     mirroring iso-git's getHeadTree returning [] on NotFoundError)
   *   - stage: `git ls-files -s -z`        (first entry per path = the
   *     LOWEST stage — iso-git's GitIndex._addEntry keeps the first
   *     index entry per path, and index entries are sorted by stage,
   *     so conflicted paths report the stage-1/base OID)
   *   - workdir: `git status --porcelain=v2 -z -uall --no-renames`
   *     tells presence/cleanliness (`-uall` because porcelain's default
   *     collapses untracked directories while iso-git lists each file;
   *     `--no-renames` because iso-git has no rename detection — a
   *     rename is delete+add there). Clean-vs-index files reuse the
   *     stage OID (iso-git's stat-cache shortcut); files with workdir
   *     changes get their real blob OID via `git hash-object` (batched);
   *     paths absent from both HEAD and index reuse iso-git's '42'
   *     placeholder (any OID works — only equality matters).
   *
   * Ignored files are skipped (iso-git's default `ignored: false`).
   * `filter`/`filepaths` opts are not supported (callers don't use them).
   *
   * @param {string} path - Local repository directory
   * @param {Record<string, unknown>} [opts] - Ignored (no cache/filter equivalent)
   * @returns {Promise<Array<[string, number, number, number]>>}
   */
  async statusMatrix(path, _opts = {}) {
    // ls-tree on an unborn HEAD exits 128 ("Not a valid object name") —
    // that is the empty-tree case, not an error. Everything else throws.
    const headPromise = this._run(
      'statusMatrix',
      ['ls-tree', '-r', '-z', 'HEAD'],
      path,
      { repoPath: path }
    ).catch((err) => {
      const msg = `${err?.stderr || ''}\n${err?.message || ''}`;
      if (/Not a valid object name|unknown revision|ambiguous argument/i.test(msg)) {
        return '';
      }
      throw err;
    });
    const [headOut, indexOut, statusOut] = await Promise.all([
      headPromise,
      this._run('statusMatrix', ['ls-files', '-s', '-z'], path, { repoPath: path }),
      this._run(
        'statusMatrix',
        ['status', '--porcelain=v2', '-z', '-uall', '--no-renames'],
        path,
        { repoPath: path }
      ),
    ]);

    // path → HEAD blob OID ('<mode> <type> <oid>\t<path>')
    const headMap = new Map();
    for (const entry of String(headOut || '').split('\0')) {
      if (!entry) continue;
      const [meta, filepath] = entry.split('\t');
      const oid = meta.split(' ')[2];
      if (oid && filepath) headMap.set(filepath, oid);
    }

    // path → index OID, FIRST entry per path wins ('<mode> <oid> <stage>\t<path>').
    // ls-files output is sorted (path, then stage) → first = lowest stage.
    const indexMap = new Map();
    for (const entry of String(indexOut || '').split('\0')) {
      if (!entry) continue;
      const [meta, filepath] = entry.split('\t');
      if (!indexMap.has(filepath)) {
        indexMap.set(filepath, meta.split(' ')[1]);
      }
    }

    // path → porcelain workdir facts
    const statusMap = parsePorcelainV2Workdir(statusOut);

    // Union of all paths across the three trees.
    const allPaths = new Set([
      ...headMap.keys(),
      ...indexMap.keys(),
      ...statusMap.keys(),
    ]);

    // paths whose workdir content must be hashed (modified/conflicted)
    const toHash = [];
    /** @type {Map<string, string|undefined>} filepath → workdir OID */
    const workdirOids = new Map();

    for (const filepath of allPaths) {
      const info = statusMap.get(filepath);
      if (info && info.absentFromWorkdir) {
        workdirOids.set(filepath, undefined);
        continue;
      }
      if (!info && !indexMap.has(filepath)) {
        // Not in status, not in index → not in the workdir. (A HEAD-only
        // path whose staged deletion+workdir deletion happened between
        // the two plumbing calls — porcelain would list it otherwise.)
        workdirOids.set(filepath, undefined);
        continue;
      }
      const headOid = headMap.get(filepath);
      const stageOid = indexMap.get(filepath);
      if (headOid === undefined && stageOid === undefined) {
        // iso-git placeholder ('42') — any OID works, only equality matters.
        workdirOids.set(filepath, '42');
        continue;
      }
      if (info && info.cleanVsIndex) {
        // workdir content matches the index → stat-cache shortcut
        workdirOids.set(filepath, stageOid);
        continue;
      }
      // Modified (or conflicted — iso-git hashes: conflicted stage
      // entries carry zeroed stats so compareStats never hits) → real OID.
      toHash.push(filepath);
    }

    // Batch hash: `git hash-object -- p1 p2 ...` (no -w: compute only,
    // object is not written). Output lines map 1:1 to the arg order.
    if (toHash.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < toHash.length; i += CHUNK) {
        const chunk = toHash.slice(i, i + CHUNK);
        const stdout = await this._run(
          'statusMatrix',
          ['hash-object', '--', ...chunk],
          path,
          { repoPath: path }
        );
        const oids = String(stdout || '').split('\n').filter(Boolean);
        if (oids.length !== chunk.length) {
          throw new GitError({
            operation: 'statusMatrix',
            provider: PROVIDER_NAME,
            exitCode: 1,
            stderr: `hash-object returned ${oids.length} oids for ${chunk.length} paths`,
          });
        }
        chunk.forEach((p, j) => workdirOids.set(p, oids[j]));
      }
    }

    // iso-git row construction: [filepath, ...entry.indexOf ranks]
    /** @type {Array<[string, number, number, number]>} */
    const rows = [];
    for (const filepath of allPaths) {
      const entry = [
        undefined,
        headMap.get(filepath),
        workdirOids.get(filepath),
        indexMap.get(filepath),
      ];
      const result = entry.map((value) => entry.indexOf(value));
      result.shift();
      rows.push([filepath, ...result]);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return rows;
  }

  /**
   * Get the current branch name. Parity with T10: null when detached or
   * in a repo with no commits yet (rev-parse --abbrev-ref HEAD fails on
   * an unborn branch).
   *
   * @param {string} path - Local repository directory
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<string|null>}
   */
  async currentBranch(path, _opts = {}) {
    return this._currentBranchName(path);
  }

  /**
   * List branches — local short names, or remote-tracking short names
   * (`origin/<name>`) when `{ remote: 'origin' }` is passed, matching
   * iso-git's listBranches output format (T10 parity: plain string
   * array).
   *
   * @param {string} path - Local repository directory
   * @param {{ remote?: string } & Record<string, unknown>} [opts]
   * @returns {Promise<string[]>}
   */
  async listBranches(path, opts = {}) {
    const { remote } = opts;
    const args = remote
      ? ['for-each-ref', `refs/remotes/${remote}`, '--format=%(refname:short)']
      : ['for-each-ref', 'refs/heads', '--format=%(refname:short)'];
    const stdout = await this._run('listBranches', args, path, { repoPath: path });
    return String(stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /**
   * List all refs in the repository (full refnames, e.g.
   * 'refs/heads/main'). T10 parity: plain string array.
   *
   * @param {string} path - Local repository directory
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<string[]>}
   */
  async listRefs(path, _opts = {}) {
    const stdout = await this._run(
      'listRefs',
      ['for-each-ref', '--format=%(refname)'],
      path,
      { repoPath: path }
    );
    return String(stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /**
   * Resolve a ref to a commit OID. Translation: `git rev-parse
   * <ref>^{commit}` (peels annotated tags to the commit — documented
   * divergence: iso-git's resolveRef returns the tag object OID without
   * peeling). Error parity with T10: unresolvable refs throw GitError.
   *
   * @param {string} path - Local repository directory
   * @param {string} ref - Ref name, branch, or commit-ish
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<string>} 40-char commit OID
   */
  async resolveRef(path, ref, _opts = {}) {
    const out = await this._run(
      'resolveRef',
      ['rev-parse', `${ref}^{commit}`],
      path,
      { repoPath: path }
    );
    return out.trim();
  }

  /**
   * Read a commit object. Returns the SAME object shape as
   * isomorphic-git's readCommit (T10 parity):
   * `{oid, commit: {message, tree, parent[], author, committer},
   * payload}` where author/committer are
   * `{name, email, timestamp, timezoneOffset}` (timezoneOffset in
   * MINUTES, sign-inverted vs the raw '+0100' string — iso-git's
   * parseTimezoneOffset convention) and message keeps its trailing \n.
   * Translation: `git cat-file commit <oid>` + parse.
   *
   * @param {string} path - Local repository directory
   * @param {string} oid - Commit OID
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<{oid: string, commit: {message: string, tree: string, parent: string[], author: object, committer: object}, payload: string}>}
   */
  async readCommit(path, oid, _opts = {}) {
    const raw = await this._run(
      'readCommit',
      ['cat-file', 'commit', oid],
      path,
      { repoPath: path }
    );
    return parseCommitObject(oid, raw);
  }

  /**
   * Read a blob. iso-git semantics (gitMergeDriver.js:67): `oid` is a
   * commit/tree OID and `opts.filepath` selects the file inside it —
   * translated as `git rev-parse <oid>:<filepath>` then
   * `git cat-file blob`. Without `filepath`, `oid` is treated as the
   * blob OID itself. Returns `{oid, blob}` with blob as a Buffer
   * (a Uint8Array subclass — T10 returns Uint8Array).
   *
   * @param {string} path - Local repository directory
   * @param {string} oid - Blob OID, or commit/tree OID when filepath is given
   * @param {{ filepath?: string } & Record<string, unknown>} [opts]
   * @returns {Promise<{oid: string, blob: Buffer}>}
   */
  async readBlob(path, oid, opts = {}) {
    const { filepath } = opts || {};
    let blobOid = oid;
    if (filepath) {
      blobOid = (await this._run(
        'readBlob',
        ['rev-parse', `${oid}:${filepath}`],
        path,
        { repoPath: path }
      )).trim();
    }
    const blob = await this._run(
      'readBlob',
      ['cat-file', 'blob', blobOid],
      path,
      { repoPath: path }
    );
    return { oid: blobOid, blob: Buffer.from(blob, 'binary') };
  }

  /**
   * Read a config value from the REPO-LOCAL config only (`--local` —
   * parity with iso-git, which reads .git/config and never the global
   * config). Returns null when unset (exit code 1 is "not found", not
   * an error). `all: true` returns the multi-valued array.
   *
   * @param {string} path - Local repository directory
   * @param {string} configPath - Config key (e.g. 'remote.origin.url')
   * @param {{ all?: boolean } & Record<string, unknown>} [opts]
   * @returns {Promise<string|string[]|null>}
   */
  async getConfig(path, configPath, opts = {}) {
    const { all } = opts;
    const args = ['config', '--local', '--get'];
    if (all) {
      args.push('--all');
    }
    args.push(configPath);
    let result;
    try {
      result = await exec(args, path, { env: {} });
    } catch (err) {
      throw new GitError({
        operation: 'getConfig',
        provider: PROVIDER_NAME,
        stderr: err?.message,
        cause: err,
      });
    }
    if (result.exitCode !== 0) {
      // exit 1 = key not set in the local config
      return null;
    }
    const values = String(result.stdout || '')
      .split('\n')
      .filter((l) => l !== '');
    if (all) {
      return values;
    }
    return values.length > 0 ? values[0] : null;
  }

  /**
   * Write a config value to the repo-local config (parity with
   * iso-git's setConfig, which writes .git/config).
   *
   * @param {string} path - Local repository directory
   * @param {string} configPath - Config key
   * @param {string} value - Config value
   * @param {Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async setConfig(path, configPath, value, _opts = {}) {
    await this._run(
      'setConfig',
      ['config', '--local', configPath, String(value)],
      path,
      { repoPath: path }
    );
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  /**
   * Run `git ls-remote -- <url>` and return raw stdout.
   *
   * @param {string} url - Remote URL
   * @param {{ url: string, auth?: AuthInfo, signal?: AbortSignal }} ctx
   * @returns {Promise<string>}
   * @private
   */
  async _runLsRemote(url, ctx) {
    return this._run('ls-remote', ['ls-remote', '--', url], undefined, ctx);
  }

  /**
   * Execute git with dugite. Args are ALWAYS an array (never a shell
   * string). Throws GitError on exitCode !== 0 (dugite v3 resolves
   * non-zero exits instead of rejecting — PRD §8).
   *
   * Auth injection: when `ctx.auth.token` exists AND the operation's
   * remote URL is github.com (for repo-local ops the remote URL is
   * resolved from `git config` first), a GIT_ASKPASS helper is created,
   * merged into the dugite env (on top of setupEnvironment's bundled-Git
   * contract), and DELETED in `finally`.
   *
   * @param {import('../GitTypes').GitOperation} operation - For GitError
   * @param {string[]} args - Git argv (array, shell-free)
   * @param {string|undefined} cwd - Working dir (undefined for clone/ls-remote)
   * @param {{ url?: string, repoPath?: string, remote?: string, auth?: AuthInfo, signal?: AbortSignal }} ctx
   * @returns {Promise<string>} stdout
   * @private
   */
  async _run(operation, args, cwd, ctx) {
    const { url, repoPath, remote, auth, signal } = ctx;
    // GIT_TERMINAL_PROMPT=0 always: network ops must fail, never hang
    // on an interactive prompt ('terminal prompts disabled' → 'auth').
    const env = { GIT_TERMINAL_PROMPT: '0' };
    let askpass = null;

    try {
      if (auth && auth.token) {
        let targetUrl = url || null;
        if (!targetUrl && repoPath && remote) {
          targetUrl = await this._getRemoteUrl(repoPath, remote);
        }
        if (targetUrl && isGithubUrl(targetUrl)) {
          askpass = createAskpass(auth.token);
          Object.assign(env, askpass.env);
        }
      }

      let result;
      try {
        // dugite merges `env` over setupEnvironment() (full bundled-Git
        // env incl. GIT_EXEC_PATH — required for local transports, T8).
        // `signal` is forwarded to execFile → real child-process kill.
        // maxBuffer defaults to Infinity in dugite v3 → clone-safe.
        result = await exec(args, cwd || os.tmpdir(), {
          env,
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        // dugite rejected (git binary failed to launch — ENOENT etc.).
        throw new GitError({
          operation,
          provider: PROVIDER_NAME,
          stderr: err?.message,
          cause: err,
        });
      }

      if (result.exitCode !== 0) {
        // Non-zero exit does NOT throw on its own in dugite v3.
        throw new GitError({
          operation,
          provider: PROVIDER_NAME,
          exitCode: result.exitCode,
          stderr: result.stderr || result.stdout,
        });
      }
      return result.stdout;
    } finally {
      if (askpass) {
        askpass.cleanup();
      }
    }
  }

  /**
   * Current branch name via `git rev-parse --abbrev-ref HEAD`.
   * Non-throwing: returns null on failure/detached HEAD ('HEAD').
   * The full `currentBranch` contract op is implemented by T16.
   *
   * @param {string} repoPath - Local repository directory
   * @returns {Promise<string|null>}
   * @private
   */
  async _currentBranchName(repoPath) {
    try {
      const result = await exec(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        repoPath,
        { env: {} }
      );
      if (result.exitCode !== 0) {
        return null;
      }
      const name = result.stdout.trim();
      return name && name !== 'HEAD' ? name : null;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Read a remote's URL from the repo config
   * (`git config --get remote.<name>.url`). Non-throwing: returns null
   * when unset (exitCode 1) or on any failure.
   *
   * @param {string} repoPath - Local repository directory
   * @param {string} remote - Remote name
   * @returns {Promise<string|null>}
   * @private
   */
  async _getRemoteUrl(repoPath, remote) {
    try {
      const result = await exec(
        ['config', '--get', `remote.${remote}.url`],
        repoPath,
        { env: {} }
      );
      if (result.exitCode !== 0) {
        return null;
      }
      return result.stdout.trim() || null;
    } catch (_e) {
      return null;
    }
  }
}

/**
 * Parse `git cat-file commit <oid>` raw object into the isomorphic-git
 * readCommit shape: `{oid, commit: {message, tree, parent[], author,
 * committer}, payload}`. Author/committer keep iso-git's
 * parseAuthor/parseTimezoneOffset convention (timestamp in seconds,
 * timezoneOffset in minutes, sign-inverted vs the raw '+0100' string,
 * 0 preserved as 0).
 *
 * @param {string} oid - Commit OID (echoed into the result)
 * @param {string} raw - Raw `git cat-file commit` output
 * @returns {{oid: string, commit: object, payload: string}}
 * @private
 */
function parseCommitObject(oid, raw) {
  const text = String(raw || '');
  const sep = text.indexOf('\n\n');
  const header = sep === -1 ? text : text.slice(0, sep);
  // message = body after the header block; payload = the RAW object
  // (headers included) — both match isomorphic-git's readCommit output.
  const message = sep === -1 ? '' : text.slice(sep + 2);
  const payload = text;
  let tree = '';
  const parents = [];
  let author = null;
  let committer = null;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5).trim();
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7).trim());
    } else if (line.startsWith('author ')) {
      author = parsePerson(line.slice(7));
    } else if (line.startsWith('committer ')) {
      committer = parsePerson(line.slice(10));
    }
  }
  return {
    oid,
    commit: {
      message,
      tree,
      parent: parents,
      author: author || { name: '', email: '', timestamp: 0, timezoneOffset: 0 },
      committer: committer || author ||
        { name: '', email: '', timestamp: 0, timezoneOffset: 0 },
    },
    payload,
  };
}

/**
 * Parse an `author ...`/`committer ...` value ("Name <email> 1234567
 * +0100") exactly like iso-git's parseAuthor: regex
 * /^(.*) <(.*)> (.*) (.*)$/, timestamp Number(...), timezoneOffset via
 * the sign-inverted-minutes convention.
 *
 * @param {string} value - Raw person line value
 * @returns {{name: string, email: string, timestamp: number, timezoneOffset: number}}
 * @private
 */
function parsePerson(value) {
  const m = String(value || '').match(/^(.*) <(.*)> (.*) (.*)$/);
  if (!m) {
    return { name: String(value || ''), email: '', timestamp: 0, timezoneOffset: 0 };
  }
  const [, name, email, timestamp, offset] = m;
  return {
    name,
    email,
    timestamp: Number(timestamp),
    timezoneOffset: parseTimezoneOffset(offset),
  };
}

/**
 * iso-git's parseTimezoneOffset: '+0100' → -60, '-0300' → 180,
 * '+0000'/'-0000' → 0.
 *
 * @param {string} offset - Raw '+HHMM'/'-HHMM' string
 * @returns {number} Offset in minutes
 * @private
 */
function parseTimezoneOffset(offset) {
  const m = String(offset || '').match(/([+-])(\d\d)(\d\d)/);
  if (!m) {
    return 0;
  }
  const [, sign, hours, minutes] = m;
  const total = (sign === '+' ? 1 : -1) * (Number(hours) * 60 + Number(minutes));
  return total === 0 ? 0 : -total;
}

/**
 * Extract per-path workdir facts from `git status --porcelain=v2 -z
 * -uall --no-renames` output:
 *
 *   - `1 <XY>`: Y==='D' → deleted from workdir; Y unmodified ('.'/' ')
 *     → workdir clean vs index; otherwise workdir differs from index.
 *   - `2 <XY>` (rename dest): same Y logic; the NUL + origPath token
 *     that follows a `2` record is consumed here (origPath only matters
 *     for rename detection, which --no-renames disables).
 *   - `u <XY>`: unmerged. `mW` (field 7) is the workdir mode — '0'
 *     means no workdir file (e.g. DD/DU conflicts). Otherwise the
 *     workdir holds conflict content that must be hashed.
 *   - `?`: untracked (present, no index counterpart).
 *   - `!`: ignored — not listed without --ignored, skipped anyway.
 *
 * @param {string} stdout - Raw porcelain v2 NUL-separated output
 * @returns {Map<string, {absentFromWorkdir: boolean, cleanVsIndex: boolean}>}
 * @private
 */
function parsePorcelainV2Workdir(stdout) {
  const tokens = String(stdout || '').split('\0');
  /** @type {Map<string, {absentFromWorkdir: boolean, cleanVsIndex: boolean}>} */
  const facts = new Map();
  const set = (filepath, absentFromWorkdir, cleanVsIndex) =>
    facts.set(filepath, { absentFromWorkdir, cleanVsIndex });
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.startsWith('#')) {
      continue;
    }
    if (entry.startsWith('? ')) {
      set(entry.slice(2), false, false);
      continue;
    }
    if (entry.startsWith('! ')) {
      continue;
    }
    const fields = entry.split(' ');
    const kind = fields[0];
    const y = fields[1] ? fields[1][1] : '';
    const unmod = (c) => c === ' ' || c === '.';
    if (kind === '1') {
      set(fields.slice(8).join(' '), y === 'D', unmod(y));
    } else if (kind === '2') {
      // `2` records are followed by a NUL + origPath token — consume it.
      set(fields.slice(9).join(' '), y === 'D', unmod(y));
      i++;
    } else if (kind === 'u') {
      set(fields.slice(10).join(' '), fields[6] === '0', false);
    }
  }
  return facts;
}

/**
 * Parse `git ls-remote` output: lines of `<oid>\t<ref>`. Advisory lines
 * (e.g. "Warning: Permanently added ...") lack the tab and are skipped.
 *
 * @param {string} stdout - Raw ls-remote stdout
 * @returns {Array<[string, string]>} [ref, oid] pairs
 * @private
 */
function parseLsRemote(stdout) {
  const pairs = [];
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const idx = trimmed.indexOf('\t');
    if (idx <= 0) {
      continue;
    }
    const oid = trimmed.slice(0, idx);
    const ref = trimmed.slice(idx + 1);
    // Dereferenced tag lines end in ^{} — keep them; callers filter.
    if (/^[0-9a-f]{40}$/.test(oid) || /^[0-9a-f]{64}$/.test(oid)) {
      pairs.push([ref, oid]);
    }
  }
  return pairs;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
// Named export (factory accepts `m.DugiteProvider || m`). Local ops
// (T16) extend this same class in this same file.
module.exports = { DugiteProvider };
