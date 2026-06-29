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
};
