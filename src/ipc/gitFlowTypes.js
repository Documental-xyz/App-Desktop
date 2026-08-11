/**
 * @fileoverview Constants and types for the new git workflow
 * @author Documental Team
 * @since 1.0.0
 */

'use strict';

// ─── Branch Constants ─────────────────────────────────────────────────────────
/** @type {string} Name of the preview branch */
const BRANCH_PREVIEW = 'preview';

/** @type {string} Name of the main/production branch */
const BRANCH_MAIN = 'main';

/** @type {string} Temporary branch used for publishing preview content */
const TEMP_PUBLISH_BRANCH = 'publish-preview';

// ─── Timing / Lock Constants ──────────────────────────────────────────────────
/** @type {number} Maximum time (ms) a git lock may be held before forced release */
const LOCK_TIMEOUT_MS = 120000;

/** @type {number} How long (ms) a permission check result is cached */
const PERMISSION_CACHE_TTL_MS = 30 * 60 * 1000;

// ─── Retry & Batching Constants ───────────────────────────────────────────────
/** @type {number} Maximum number of retry attempts for a publish operation */
const MAX_PUBLISH_RETRIES = 2;

/** @type {number} Number of files to stage in a single batch during staging */
const BATCH_SIZE_STAGING = 25;

// ─── Per-Step Timeout Constants ───────────────────────────────────────────────
// AbortSignal is ignored by isomorphic-git local ops, so these are for
// Promise.race-based timeout warnings, not actual cancellation.
/** @type {number} Fetch is network-bound, allow 30s */
const STEP_TIMEOUT_FETCH_MS = 30000;

/** @type {number} Merge is CPU-bound on large repos, allow 45s */
const STEP_TIMEOUT_MERGE_MS = 45000;

/** @type {number} Push is network-bound + server-side processing, allow 60s */
const STEP_TIMEOUT_PUSH_MS = 60000;

/** @type {number} Checkout is I/O-bound, worse on Windows with Defender, allow 20s */
const STEP_TIMEOUT_CHECKOUT_MS = 20000;

// ─── Backup Namespace Constants ───────────────────────────────────────────────
/** @type {string} Prefix for auto-created backup branches */
const BACKUP_BRANCH_PREFIX = 'backup/';

/** @type {boolean} If true, backup branches are deleted on operation success; persist only on failure/crash */
const BACKUP_AUTO_CLEAN = true;

// ─── Lock Heartbeat Constants ─────────────────────────────────────────────────
/** @type {number} How often to update heartbeat timestamp (5s) */
const LOCK_HEARTBEAT_INTERVAL_MS = 5000;

/** @type {number} Heartbeat older than 3 minutes = stale (process presumed dead) */
const LOCK_HEARTBEAT_STALE_MS = 180000;

// ─── JSDoc Type Definitions ───────────────────────────────────────────────────

/**
 * @typedef {Object} GitExecutionStep
 * @property {string} name - Human-readable label for the step (e.g. 'Checking permissions')
 * @property {Function} execute - Async function that performs the step; receives a sendOutput callback
 * @property {Function} [rollback] - Optional async function to revert the step on failure
 * @property {number} [timeoutMs] - Step-specific timeout override (defaults to LOCK_TIMEOUT_MS)
 */

/**
 * @typedef {Object} PublishResult
 * @property {boolean} success - Whether the publish completed successfully
 * @property {string} [error] - Error message when success is false
 * @property {number} [commitCount] - Number of commits pushed
 * @property {string} [publishedBranch] - Name of the branch that was published
 */

/**
 * @typedef {Object} PermissionCacheEntry
 * @property {boolean} hasPermission - Whether the user has the required permission
 * @property {number} timestamp - When the entry was created (ms since epoch)
 * @property {string} [context] - Optional context describing the permission check
 */

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  BRANCH_PREVIEW,
  BRANCH_MAIN,
  TEMP_PUBLISH_BRANCH,
  LOCK_TIMEOUT_MS,
  PERMISSION_CACHE_TTL_MS,
  MAX_PUBLISH_RETRIES,
  BATCH_SIZE_STAGING,
  STEP_TIMEOUT_FETCH_MS,
  STEP_TIMEOUT_MERGE_MS,
  STEP_TIMEOUT_PUSH_MS,
  STEP_TIMEOUT_CHECKOUT_MS,
  BACKUP_BRANCH_PREFIX,
  BACKUP_AUTO_CLEAN,
  LOCK_HEARTBEAT_INTERVAL_MS,
  LOCK_HEARTBEAT_STALE_MS,
};
