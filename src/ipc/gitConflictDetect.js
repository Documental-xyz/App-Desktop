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
 *   - dugite (`provider.mergeTree`): `git merge-tree --write-tree` —
 *     the merge runs entirely inside the object database and writes
 *     only a throwaway tree object; exit 1 = conflicts, conflicted
 *     paths parsed from the ls-files-style section. This is the
 *     documented choice over the legacy `merge-tree <base> <b1> <b2>`
 *     mode because the write-tree mode runs the REAL merge machinery
 *     (ort) — the answer matches what `git merge` would do.
 *   - isomorphic-git: driver-detector in memory — the same `diff3`
 *     package and LINEBREAKS splitting the merge drivers
 *     (gitMergeDriver.js) use, applied to the blobs that diverge on
 *     both sides. Reads blobs/trees via read-only provider ops
 *     (resolveRef/readCommit/readTree/readBlob/mergeBase); nothing is
 *     ever written.
 *
 * Semantics mirrored from the merge drivers (hunk granularity):
 *   - A file conflicts when BOTH sides changed the same blob AND the
 *     diff3 partition contains at least one conflicting hunk, OR the
 *     blob is binary on any side (U+FFFD heuristic — identical to
 *     oursMergeDriver/theirsMergeDriver).
 *   - Divergent edits in DIFFERENT hunks of the same file are NOT a
 *     conflict (diff3 merges them cleanly) — the modal must never
 *     appear for those.
 *   - delete/modify: the iso drivers auto-resolve these (winner side),
 *     so detection does not flag them; dugite's merge-tree DOES leave
 *     them conflicted (documented `-X ours|theirs` divergence). The
 *     dugite answer is the conservative one — an extra modal beats a
 *     silently wrong auto-resolution (Task 5 owns parity).
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

const diff3Merge = require('diff3');

// Same line-splitting strategy as gitMergeDriver.js (and iso-git's
// own mergeFile) so hunks are identical to the engine's notion of a
// conflict.
const LINEBREAKS = /^.*(\r?\n|$)/gm;

/**
 * Recursively flatten a tree level into { filepath: blobOid }.
 * Uses provider.readTree (read-only). `commitOid` is resolved to its
 * tree via readCommit first.
 *
 * @param {Object} provider - provider with readCommit/readTree
 * @param {string} repoPath - repo directory
 * @param {string} commitOid - commit whose tree to walk (null → empty map)
 * @returns {Promise<Map<string, string>>}
 * @private
 */
async function treeBlobMap(provider, repoPath, commitOid) {
  const map = new Map();
  if (!commitOid) {
    return map;
  }
  const { commit } = await provider.readCommit(repoPath, commitOid);
  const walk = async (treeOid, prefix) => {
    const { tree } = await provider.readTree(repoPath, treeOid);
    for (const entry of tree) {
      if (entry.type === 'tree') {
        await walk(entry.oid, `${prefix}${entry.path}/`);
      } else if (entry.type === 'blob') {
        map.set(`${prefix}${entry.path}`, entry.oid);
      }
      // 'commit' entries = submodules — out of scope for content merge
    }
  };
  await walk(commit.tree, '');
  return map;
}

/**
 * Whether a blob decodes as binary (U+FFFD heuristic from the merge
 * drivers: the engine decodes UTF-8 with losses; mangled bytes on any
 * side mean a textual merge would corrupt the file).
 *
 * @param {Uint8Array} blob
 * @returns {boolean}
 * @private
 */
function isBinaryBlob(blob) {
  return Buffer.from(Buffer.from(blob).toString('utf8')).toString('utf8')
    .includes('\uFFFD');
}

/**
 * In-memory diff3 detection for the isomorphic-git provider.
 *
 * @param {Object} provider
 * @param {string} repoPath
 * @param {{ours: string, theirs: string, mergeBase: string|null}} oids
 * @returns {Promise<string[]>} conflicted filepaths
 * @private
 */
async function detectViaDiff3(provider, repoPath, { ours, theirs, mergeBase }) {
  const [oursMap, theirsMap, baseMap] = await Promise.all([
    treeBlobMap(provider, repoPath, ours),
    treeBlobMap(provider, repoPath, theirs),
    treeBlobMap(provider, repoPath, mergeBase),
  ]);

  const conflicted = [];
  const paths = new Set([...oursMap.keys(), ...theirsMap.keys()]);
  for (const filepath of paths) {
    const o = oursMap.get(filepath);
    const t = theirsMap.get(filepath);
    if (o === t) {
      continue; // same content — nothing to merge
    }
    const b = baseMap.get(filepath);
    const oursChanged = o !== b;
    const theirsChanged = t !== b;
    if (!oursChanged || !theirsChanged) {
      continue; // only one side diverged → diff3/fast-path resolves it
    }
    // delete/modify and delete/delete: the iso drivers resolve these to
    // the winning side (documented in gitMergeDriver.js) — NOT a
    // conflict for the modal.
    if (!o || !t) {
      continue;
    }
    // Both sides changed the same blob → the exact case the merge
    // driver would be invoked for. Evaluate the hunk partition.
    const [baseBlob, oursBlob, theirsBlob] = await Promise.all([
      b
        ? provider.readBlob(repoPath, b).then((r) => r.blob)
        : Promise.resolve(new Uint8Array()),
      provider.readBlob(repoPath, o).then((r) => r.blob),
      provider.readBlob(repoPath, t).then((r) => r.blob),
    ]);
    if (isBinaryBlob(baseBlob) || isBinaryBlob(oursBlob) || isBinaryBlob(theirsBlob)) {
      conflicted.push(filepath); // binary + divergent = always a conflict
      continue;
    }
    const decode = (blob) =>
      Buffer.from(blob).toString('utf8').match(LINEBREAKS) || [''];
    const hasConflictHunk = diff3Merge(
      decode(oursBlob),
      decode(baseBlob),
      decode(theirsBlob)
    ).some((item) => item.conflict);
    if (hasConflictHunk) {
      conflicted.push(filepath);
    }
  }
  return conflicted.sort();
}

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
    // dugite: dry-run via the real merge machinery (write-tree mode).
    const { clean, files } = await provider.mergeTree(repoPath, ours, theirs);
    return { hasConflicts: !clean, files: clean ? [] : files, ours, theirs, mergeBase };
  }

  // isomorphic-git: driver-detector semantics, in memory.
  const files = await detectViaDiff3(provider, repoPath, { ours, theirs, mergeBase });
  return { hasConflicts: files.length > 0, files, ours, theirs, mergeBase };
}

module.exports = { detectMergeConflicts };
