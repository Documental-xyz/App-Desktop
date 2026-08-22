/**
 * @fileoverview JSDoc type contracts for the GitProvider abstraction.
 * Pure CommonJS — no TypeScript, no runtime code, types only (plus GitError
 * lives in src/git/GitError.js).
 * @see .omo/plans/prd-dugite-migration.md §6.2–6.3
 * @since 1.0.0
 */

'use strict';

// ─── JSDoc Type Definitions ───────────────────────────────────────────────────

/**
 * Authentication info. The app authenticates exclusively via GitHub
 * OAuth/PAT over HTTPS (`{username: token, password: 'x-oauth-basic'}`),
 * so this reduces to a single token (PRD §24).
 *
 * @typedef {Object} AuthInfo
 * @property {string} token - GitHub OAuth/PAT token
 */

/**
 * @typedef {Object} FetchOptions
 * @property {boolean} [singleBranch=false] - Fetch only a single branch (shallow-fetch semantics)
 * @property {number} [depth] - Shallow fetch depth (app uses 1)
 * @property {string} [refspec] - Optional refspec to fetch
 * @property {AuthInfo} [auth] - Credentials for the remote
 * @property {AbortSignal} [signal] - Abort/cancellation signal (dugite: kills child process)
 */

/**
 * @typedef {Object} PushOptions
 * @property {string} [remote='origin'] - Remote name to push to
 * @property {string} [branch] - Branch to push (defaults to current)
 * @property {boolean} [force=false] - Force push
 * @property {AuthInfo} [auth] - Credentials for the remote
 * @property {AbortSignal} [signal] - Abort/cancellation signal
 */

/**
 * @typedef {Object} CloneOptions
 * @property {boolean} [noCheckout=false] - Clone without checking out HEAD
 * @property {boolean} [singleBranch=false] - Clone only a single branch
 * @property {number} [depth] - Shallow clone depth (e.g. 1)
 * @property {AuthInfo} [auth] - Credentials for the remote
 * @property {AbortSignal} [signal] - Abort/cancellation signal
 */

/**
 * @typedef {Object} PullOptions
 * @property {boolean} [fastForwardOnly=false] - Fail instead of creating a merge commit
 * @property {AuthInfo} [auth] - Credentials for the remote
 * @property {AbortSignal} [signal] - Abort/cancellation signal
 */

/**
 * @typedef {Object} MergeOptions
 * @property {'theirs'|'ours'|'ort'} [strategy='ort'] - Merge strategy /
 *        favor side on conflict (dugite maps to `git merge -X theirs|ours`)
 * @property {AbortSignal} [signal] - Abort/cancellation signal
 */

/**
 * @typedef {Object} BranchOptions
 * @property {boolean} [checkout=false] - Check out the new branch immediately
 * @property {string} [from] - Ref/commit to branch from (defaults to HEAD)
 */

/**
 * @typedef {Object} CheckoutOptions
 * @property {string} [createBranch] - Create this branch before checking it out
 */

/**
 * A single row of the status matrix, mirroring isomorphic-git semantics:
 * [filePath, headStatus, workdirStatus, stageStatus] where statuses are
 * 0=absent, 1=present, 2=modified (dugite derives from `git status --porcelain=v2 -z`).
 *
 * @typedef {[string, number, number, number]} StatusRow
 */

/**
 * @typedef {Object} BranchInfo
 * @property {string} name - Branch name (no refs/heads/ prefix)
 * @property {string} [oid] - Commit OID the branch points to
 * @property {boolean} [isRemote=false] - True for remote-tracking branches
 */

/**
 * @typedef {Object} Ref
 * @property {string} ref - Full ref name (e.g. 'refs/heads/main')
 * @property {string} oid - Commit OID the ref points to
 */

/**
 * Commit object as returned by readCommit.
 *
 * @typedef {Object} CommitObject
 * @property {string} oid - Commit SHA-1
 * @property {CommitPayload} commit - Commit payload
 */

/**
 * @typedef {Object} CommitPayload
 * @property {string} message - Commit message
 * @property {string} tree - Tree OID
 * @property {CommitAuthor} author - Author (name, email, timestamp)
 * @property {CommitAuthor} committer - Committer (name, email, timestamp)
 * @property {string[]} [parent] - Parent commit OIDs
 */

/**
 * @typedef {Object} CommitAuthor
 * @property {string} name - Person name
 * @property {string} email - Person email
 * @property {number} timestamp - Seconds since epoch
 * @property {number} [timezoneOffset] - Timezone offset in minutes
 */

/**
 * @typedef {Object} RemoteInfo
 * @property {string} [capabilities] - Capabilities the remote advertised
 * @property {Object.<string, {oid: string}>} [refs] - Map of ref name → {oid}
 */

/**
 * Result of a merge operation.
 *
 * @typedef {Object} MergeResult
 * @property {string} [oid] - OID of the merge commit (absent on fast-forward/clean tree)
 * @property {boolean} [alreadyMerged=false] - True if the ref was already an ancestor
 * @property {boolean} [fastForward=false] - True if the merge was a fast-forward
 * @property {boolean} [throwConflicts=false] - True if conflicts occurred (provider-dependent)
 */

/**
 * Result of a fetch operation.
 *
 * @typedef {Object} FetchResult
 * @property {string} [defaultBranch] - Default branch of the remote
 * @property {FetchPullResult} [fetchHead] - Resolved FETCH_HEAD info
 * @property {Object.<string, string>} [pruned] - Pruned refs
 */

/**
 * @typedef {Object} FetchPullResult
 * @property {string} [url] - URL fetched from (sanitized — never contains tokens)
 * @property {Ref} [ref] - Ref that was fetched
 * @property {string} [shallow] - Shallow boundary commit, if shallow fetch
 */

/**
 * Union of all git operations covered by the GitProvider interface.
 *
 * @typedef {'clone'|'fetch'|'pull'|'push'|'getRemoteInfo'|'listServerRefs'
 *   |'add'|'remove'|'commit'|'branch'|'deleteBranch'|'checkout'|'merge'
 *   |'fastForward'|'writeRef'
 *   |'statusMatrix'|'status'|'currentBranch'|'listBranches'|'listRefs'
 *   |'resolveRef'|'readCommit'|'readBlob'|'getConfig'|'setConfig'} GitOperation
 */

/**
 * @typedef {'isomorphic-git'|'dugite'} ProviderName
 */

// ─── Exports ──────────────────────────────────────────────────────────────────
// This module is types-only (JSDoc); nothing to export at runtime.
// Requiring it must be side-effect free.
module.exports = {};
