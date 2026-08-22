/**
 * @fileoverview GitProvider interface contract (JSDoc, ~24 operations).
 * Implementations: IsomorphicGitProvider (default during migration) and
 * DugiteProvider (target). Providers must never leak their underlying
 * library types across this boundary.
 * @see .omo/plans/prd-dugite-migration.md §6.2–6.3
 * @since 1.0.0
 */

'use strict';

/**
 * Abstraction over a git backend covering every operation the app uses
 * today (inventory in PRD §6.1). All methods are async and resolve with
 * normalized result objects; failures reject with a
 * `GitError` (src/git/GitError.js) carrying a sanitized `stderr` and a
 * normalized `errorType` ('timeout'|'auth'|'network'|'conflict'|'unknown').
 *
 * Timeout/retry layers (`src/ipc/gitFlowTypes.js`, `_raceTimeout`,
 * `_pushWithRetry`) sit ABOVE this interface — implementations only need
 * to honor the optional `signal` where the backend supports it.
 *
 * @interface GitProvider
 */

// ─── Network operations ───────────────────────────────────────────────────────

/**
 * Clone a repository into `path`.
 * @function
 * @name GitProvider#clone
 * @param {string} url - Remote URL (HTTPS, GitHub)
 * @param {string} path - Local destination directory
 * @param {CloneOptions} [opts]
 * @returns {Promise<void>}
 */

/**
 * Fetch from the remote. The app always fetches shallow
 * (`singleBranch: true, depth: 1`) unless overridden.
 * @function
 * @name GitProvider#fetch
 * @param {string} path - Local repository directory
 * @param {FetchOptions} [opts]
 * @returns {Promise<FetchResult>}
 */

/**
 * Pull from the remote (fallback path; fetch+merge is preferred).
 * @function
 * @name GitProvider#pull
 * @param {string} path - Local repository directory
 * @param {PullOptions} [opts]
 * @returns {Promise<void>}
 */

/**
 * Push local commits to the remote.
 * @function
 * @name GitProvider#push
 * @param {string} path - Local repository directory
 * @param {PushOptions} [opts]
 * @returns {Promise<void>}
 */

/**
 * Get info (capabilities, refs) about a remote repository.
 * @function
 * @name GitProvider#getRemoteInfo
 * @param {string} url - Remote URL
 * @param {{ auth?: AuthInfo }} [opts]
 * @returns {Promise<RemoteInfo>}
 */

/**
 * List refs advertised by a remote server (ls-remote).
 * @function
 * @name GitProvider#listServerRefs
 * @param {string} url - Remote URL
 * @param {{ auth?: AuthInfo }} [opts]
 * @returns {Promise<Ref[]>}
 */

// ─── Local write operations ───────────────────────────────────────────────────

/**
 * Stage files.
 * @function
 * @name GitProvider#add
 * @param {string} path - Local repository directory
 * @param {string[]} files - File paths relative to the repo root
 * @returns {Promise<void>}
 */

/**
 * Unstage/remove files from the index (and working tree, like `git rm`).
 * @function
 * @name GitProvider#remove
 * @param {string} path - Local repository directory
 * @param {string[]} files - File paths relative to the repo root
 * @returns {Promise<void>}
 */

/**
 * Create a commit on HEAD.
 * @function
 * @name GitProvider#commit
 * @param {string} path - Local repository directory
 * @param {string} message - Commit message
 * @param {{ author?: { name?: string, email?: string } }} [opts]
 * @returns {Promise<string>} Commit OID (resolves with the new commit SHA-1)
 */

/**
 * Create a branch.
 * @function
 * @name GitProvider#branch
 * @param {string} path - Local repository directory
 * @param {string} name - New branch name
 * @param {BranchOptions} [opts]
 * @returns {Promise<void>}
 */

/**
 * Delete a branch.
 * @function
 * @name GitProvider#deleteBranch
 * @param {string} path - Local repository directory
 * @param {string} name - Branch to delete
 * @returns {Promise<void>}
 */

/**
 * Check out a ref (optionally creating a branch).
 * @function
 * @name GitProvider#checkout
 * @param {string} path - Local repository directory
 * @param {string} ref - Ref, branch or commit to check out
 * @param {CheckoutOptions} [opts]
 * @returns {Promise<void>}
 */

/**
 * Merge `theirRef` into the current branch. With dugite this maps to
 * `git merge [-X theirs|ours]` natively (the custom merge driver in
 * `src/ipc/gitMergeDriver.js` becomes dead code — PRD §6.3).
 * @function
 * @name GitProvider#merge
 * @param {string} path - Local repository directory
 * @param {string} theirRef - Ref to merge into HEAD
 * @param {MergeOptions} [opts]
 * @returns {Promise<MergeResult>}
 */

/**
 * Fast-forward the current branch to the fetched ref, if possible.
 * @function
 * @name GitProvider#fastForward
 * @param {string} path - Local repository directory
 * @param {{ ref?: string, auth?: AuthInfo, signal?: AbortSignal }} [opts]
 * @returns {Promise<boolean>} True if a fast-forward happened; false if already up to date
 */

/**
 * Write a ref directly (e.g. to move a branch pointer).
 * @function
 * @name GitProvider#writeRef
 * @param {string} path - Local repository directory
 * @param {string} ref - Full ref name (e.g. 'refs/heads/main')
 * @param {string} oid - Commit OID to point the ref at
 * @returns {Promise<void>}
 */

// ─── Read / status operations ─────────────────────────────────────────────────

/**
 * Status matrix: rows of [file, headStatus, workdirStatus, stageStatus]
 * with statuses 0=absent, 1=present, 2=modified. Dugite derives this from
 * `git status --porcelain=v2 -z --branch`; rename detection semantics may
 * differ and are pinned by the common test suite (PRD §6.3).
 * @function
 * @name GitProvider#statusMatrix
 * @param {string} path - Local repository directory
 * @returns {Promise<StatusRow[]>}
 */

/**
 * Current branch name.
 * @function
 * @name GitProvider#currentBranch
 * @param {string} path - Local repository directory
 * @returns {Promise<string|null>} Branch name, or null when detached/empty
 */

/**
 * List local (and optionally remote-tracking) branches.
 * @function
 * @name GitProvider#listBranches
 * @param {string} path - Local repository directory
 * @returns {Promise<BranchInfo[]>}
 */

/**
 * List all refs in the repository.
 * @function
 * @name GitProvider#listRefs
 * @param {string} path - Local repository directory
 * @returns {Promise<Ref[]>}
 */

/**
 * Resolve a ref to its commit OID.
 * @function
 * @name GitProvider#resolveRef
 * @param {string} path - Local repository directory
 * @param {string} ref - Ref name, branch, or commit-ish
 * @returns {Promise<string>} Resolved commit OID
 */

/**
 * Read a commit object.
 * @function
 * @name GitProvider#readCommit
 * @param {string} path - Local repository directory
 * @param {string} oid - Commit OID
 * @returns {Promise<CommitObject>}
 */

/**
 * Read a blob object.
 * @function
 * @name GitProvider#readBlob
 * @param {string} path - Local repository directory
 * @param {string} oid - Blob OID
 * @returns {Promise<{ oid: string, blob: Uint8Array }>} Blob object with raw contents
 */

/**
 * Read a config value.
 * @function
 * @name GitProvider#getConfig
 * @param {string} path - Local repository directory
 * @param {string} key - Config key (e.g. 'user.name')
 * @returns {Promise<string|null>} Config value, or null when unset
 */

/**
 * Write a config value.
 * @function
 * @name GitProvider#setConfig
 * @param {string} path - Local repository directory
 * @param {string} key - Config key (e.g. 'user.email')
 * @param {string} value - Config value
 * @returns {Promise<void>}
 */

// ─── Exports ──────────────────────────────────────────────────────────────────
// Interface contract only (JSDoc) — no runtime implementation.
module.exports = {};
