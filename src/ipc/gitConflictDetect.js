/**
 * @fileoverview Pre-merge conflict DETECTION without resolution
 * (conflict-strategy-modal plan, Task 1).
 *
 * `detectMergeConflicts(repoCtx, theirRef)` answers ONE question —
 * "would merging theirRef into HEAD produce a REAL conflict?" — with
 * ZERO mutation of the user's repository: no merge applied, no working
 * tree touched, no refs moved, no index written.
 *
 * Provider dispatch (capability-based, no name matching):
 *   - providers implementing `mergeTree` (dugite): `git merge-tree
 *     --write-tree` — the merge runs entirely inside the object database
 *     and writes only a throwaway tree object; exit 1 = conflicts,
 *     conflicted paths parsed from the ls-files-style section. This is the
 *     documented choice over the legacy `merge-tree <base> <b1> <b2>`
 *     mode because the write-tree mode runs the REAL merge machinery
 *     (ort) — the answer matches what `git merge` would do.
 *   - providers WITHOUT `mergeTree`: detection refuses to guess and
 *     throws — the caller's fail-open handling treats that as
 *     "detection unavailable" (never a wrong yes/no answer).
 *
 * Semantics (dugite merge-tree, hunk granularity):
 *   - A file conflicts when the real merge machinery reports it
 *     conflicted (both sides changed it and no clean auto-merge).
 *   - delete/modify IS left conflicted by merge-tree (documented
 *     `-X ours|theirs` divergence) — the conservative answer; an extra
 *     modal beats a silently wrong auto-resolution.
 *
 * Return shape — designed to feed Task 3's typed CONFLICT_PENDING
 * error payload as-is:
 *   {
 *     hasConflicts: boolean,
 *     files: string[],   // conflicted paths (sorted; [] when clean)
 *     ours: string,      // HEAD oid
 *     theirs: string,    // resolved theirRef oid
 *     mergeBase: string|null,  // null = unrelated histories
 *   }
 * Unrelated histories (no merge base) with divergent tips are reported
 * as hasConflicts: true with files: [] — the merge itself would refuse
 * ("refusing to merge unrelated histories") and needs a user decision.
 *
 * @since 2.0.0
 */

'use strict';

/**
 * Detect whether merging `theirRef` into HEAD would produce real
 * conflicts — WITHOUT resolving, staging, or mutating anything.
 *
 * @param {{ provider: Object, repoPath: string }} repoCtx - provider
 *   (GitProvider instance — capability-dispatched) + repository dir
 * @param {string} theirRef - Ref to merge into HEAD (e.g. 'origin/main')
 * @returns {Promise<{hasConflicts: boolean, files: string[], ours: string, theirs: string, mergeBase: string|null}>}
 * @throws {GitError} when refs cannot be resolved or a read fails
 */
async function detectMergeConflicts(repoCtx, theirRef) {
  const { provider, repoPath } = repoCtx;

  const ours = await provider.resolveRef(repoPath, 'HEAD');
  const theirs = await provider.resolveRef(repoPath, theirRef);

  if (ours === theirs) {
    return { hasConflicts: false, files: [], ours, theirs, mergeBase: ours };
  }

  const bases = await provider.mergeBase(repoPath, [ours, theirs]);
  const mergeBase = bases[0] || null;

  if (mergeBase === theirs || mergeBase === ours) {
    // Fast-forward / already-merged — nothing to merge.
    return { hasConflicts: false, files: [], ours, theirs, mergeBase };
  }

  if (!mergeBase) {
    // Unrelated histories: git itself refuses without a user decision.
    return { hasConflicts: true, files: [], ours, theirs, mergeBase: null };
  }

  if (typeof provider.mergeTree === 'function') {
    // mergeTree capability (dugite): dry-run via the real merge
    // machinery (write-tree mode).
    const { clean, files } = await provider.mergeTree(repoPath, ours, theirs);
    return { hasConflicts: !clean, files: clean ? [] : files, ours, theirs, mergeBase };
  }

  // No mergeTree capability: refuse to guess. The caller's fail-open
  // handling (GitHandlers._conflictGate) catches and falls through to
  // the historical auto-resolution behavior.
  throw new Error(
    'detectMergeConflicts: provider does not implement mergeTree — ' +
    'conflict detection unavailable'
  );
}

module.exports = { detectMergeConflicts };
