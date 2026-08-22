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
 *   - Instead, a temporary helper script (mode 0600, in the OS temp
 *     dir) is written and exposed via `env.GIT_ASKPASS`. Git invokes it
 *     with the prompt ("Username for ...:" / "Password for ...:") and
 *     the script answers `x-oauth-basic` / the token. The token itself
 *     reaches the helper through a process-env var (inherited by the
 *     git process and its children) — not embedded in the script, not
 *     in argv, not in any URL.
 *   - GIT_ASKPASS is set to `sh <path>` (git runs askpass via the
 *     shell), so the script needs only read permission → strict 0600.
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
 * (never embedded in the file). POSIX `sh` — git runs GIT_ASKPASS
 * through the shell, and we point GIT_ASKPASS at `sh <file>` so the
 * file itself needs no execute bit (0600 is enough).
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
 * Create the temporary askpass helper (mode 0600, unique name in the
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
  // 0600: owner read/write only. Invoked as `sh <file>` so no exec bit
  // is required — the file is strict data, not an executable.
  fs.writeFileSync(helperPath, ASKPASS_SCRIPT, { mode: 0o600 });
  return {
    env: {
      GIT_ASKPASS: `sh "${helperPath}"`,
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
   * @param {string} repoPath - Local repository directory
   * @param {import('../GitTypes').PushOptions & Record<string, unknown>} [opts]
   * @returns {Promise<void>}
   */
  async push(repoPath, opts = {}) {
    const {
      auth, signal, remote = 'origin', branch, remoteRef, force = false,
    } = opts;
    let refspec = null;
    if (branch && remoteRef) {
      refspec = `refs/heads/${branch}:refs/heads/${remoteRef}`;
    } else if (branch) {
      refspec = `refs/heads/${branch}`;
    } else if (remoteRef) {
      // Mirror iso-git: remoteRef alone targets the current branch.
      refspec = `:refs/heads/${remoteRef}`;
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
