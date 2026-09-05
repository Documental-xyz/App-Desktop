'use strict';

/**
 * Shared guard against dummy/placeholder GitHub client IDs shipping in builds.
 *
 * Used by:
 * - scripts/generate-runtime-env.js  (generate-time rejection)
 * - scripts/verify-build.js          (post-build verification of packaged runtime-env.json)
 *
 * Matching rules (case-insensitive, input is trimmed):
 * - SUBSTRING_DENYLIST: long, unambiguous placeholder markers are matched as
 *   substrings, so variants like "spike-local-dummy-2" are also caught.
 * - EXACT_DENYLIST: short generic tokens ("test", "xxx", ...) are matched only
 *   exactly, to avoid false positives on real client IDs.
 *
 * Real GitHub client IDs are never denylisted: they look like "Iv1.<hex>"
 * (GitHub App) or a 20-char hex string (OAuth App), which cannot contain any
 * denylisted marker.
 */

// Matched as case-insensitive substrings of the trimmed value.
const SUBSTRING_DENYLIST = [
  'spike-local-dummy',
  'your_github_client_id_here',
  'your_github_client_id',
  'client_id_here',
  'dummy',
  'placeholder',
  'changeme',
  'change_me'
];

// Matched only as an exact (case-insensitive) match of the trimmed value.
const EXACT_DENYLIST = [
  'test',
  'xxx',
  'todo',
  'fixme'
];

/**
 * Returns true when the given GitHub client ID is a known dummy/placeholder value.
 * Empty/missing values are NOT dummies — the existing empty-check in
 * generate-runtime-env.js (and the missing-key check in verify-build.js) owns
 * that case.
 * @param {unknown} value
 * @returns {boolean}
 */
function isDummyClientId(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (EXACT_DENYLIST.includes(normalized)) {
    return true;
  }

  return SUBSTRING_DENYLIST.some((marker) => normalized.includes(marker));
}

module.exports = {
  isDummyClientId,
  SUBSTRING_DENYLIST,
  EXACT_DENYLIST
};
