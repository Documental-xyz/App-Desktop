/**
 * @fileoverview TDD tests for oursMergeDriver + resolveBinaryOurs
 * (git-sync-strategy plan, Task 2).
 *
 * Semantics under test (mirrors theirsMergeDriver contract, inverted):
 *   - conflicting hunk  → LOCAL content wins
 *   - non-conflicting remote hunk (same file, different hunk) → PRESERVED
 *   - conflicting binary → LOCAL bytes preserved (via resolveBinaryOurs)
 *
 * Real repos driven by isomorphic-git (Task 1 harness).
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createRepoPair, makeConflict, commitFile } from './fixtures/harness.js';
import { httpBackendAvailable } from './fixtures/harness.js';
import { oursMergeDriver, resolveBinaryOurs } from '../../src/ipc/gitMergeDriver.js';

import gitModule from 'isomorphic-git';
const git = gitModule.default || gitModule;

/** Minimal GitService-like facade over isomorphic-git (readBlob + add). */
function facadeFor(pair) {
  const { fs, dir, http, author } = pair.local.git;
  return {
    async readBlob(path, oid, opts) {
      return git.readBlob({ fs, dir: path, oid, ...opts });
    },
    async add(path, filepath) {
      return git.add({ fs, dir: path, filepath });
    },
  };
}

/** @type {Awaited<ReturnType<typeof createRepoPair>>} */
let pair;

afterAll(() => {
  if (pair) pair.dispose();
});

describe.skipIf(!httpBackendAvailable)('oursMergeDriver (text)', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  it('keeps LOCAL on the conflicting hunk AND keeps the remote non-conflicting hunk', async () => {
    // Base: 10 lines. Local edits line 5 (hunk X). Remote edits line 5
    // differently (conflict) AND appends line 11 (hunk Y, non-conflicting).
    const baseLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}\n`).join('');
    const localLines = baseLines.replace('line5\n', 'line5-LOCAL\n');
    const remoteLines = baseLines.replace('line5\n', 'line5-REMOTE\n') + 'line11-REMOTE\n';

    pair = await createRepoPair();
    const { file, localHead } = await makeConflict(pair, {
      file: 'doc.md',
      base: baseLines,
      local: localLines,
      remote: remoteLines,
    });

    // Merge origin/main into local with the ours driver.
    await pair.local.fetch();
    const originHead = await pair.local.resolveRef(`origin/${pair.branch}`);
    await git.merge({
      ...pair.local.git,
      ours: pair.branch,
      theirs: `origin/${pair.branch}`,
      mergeDriver: oursMergeDriver,
      message: 'merge origin with ours driver',
    });
    // iso-git merge does not touch the working tree — materialize HEAD.
    await git.checkout({ ...pair.local.git, ref: pair.branch, force: true });

    // Hunk X (conflict): local version wins.
    const merged = await pair.local.readFile(file);
    expect(merged).toContain('line5-LOCAL\n');
    expect(merged).not.toContain('line5-REMOTE\n');

    // Hunk Y (non-conflicting remote change in the SAME file): preserved.
    expect(merged).toContain('line11-REMOTE\n');

    // Merge commit has both parents — remote work reachable in history.
    const log = await pair.local.log(5);
    const mergeCommit = log.find((c) => c.oid !== localHead && c.oid !== originHead);
    expect(mergeCommit).toBeTruthy();
    expect(mergeCommit.commit.parent).toEqual(
      expect.arrayContaining([localHead, originHead])
    );
  });

  it('preserves non-conflicting remote changes in OTHER files (engine, no conflict)', async () => {
    pair = await createRepoPair();
    const { file } = await makeConflict(pair, { file: 'a.txt' });

    // Remote adds an unrelated file on top of its conflicting edit.
    await commitFile(pair.remote, 'other.txt', 'remote-only\n', 'remote: add other.txt');
    await pair.remote.push(pair.branch);

    await pair.local.fetch();
    await git.merge({
      ...pair.local.git,
      ours: pair.branch,
      theirs: `origin/${pair.branch}`,
      mergeDriver: oursMergeDriver,
      message: 'merge origin with ours driver',
    });
    await git.checkout({ ...pair.local.git, ref: pair.branch, force: true });

    expect(await pair.local.readFile('other.txt')).toBe('remote-only\n');
    expect(await pair.local.readFile(file)).toContain('line2-LOCAL');
  });

  it('returns cleanMerge:false when local content is unavailable', () => {
    const result = oursMergeDriver({
      branches: ['base', 'ours', 'theirs'],
      contents: ['b\n', undefined, 't\n'],
      path: 'x.txt',
    });
    expect(result).toEqual({ cleanMerge: false });
  });
});

describe.skipIf(!httpBackendAvailable)('resolveBinaryOurs (binary)', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  it('preserves LOCAL bytes of a conflicting binary file (identical hash)', async () => {
    const localBytes = Buffer.from([1, 2, 0xff, 0xff, 0, 0, 7, 8]);
    pair = await createRepoPair();
    const { file, localHead } = await makeConflict(pair, {
      binary: true,
      local: localBytes,
    });

    // Binary conflict bypasses the text driver → MergeConflictError.
    await pair.local.fetch();
    const originHead = await pair.local.resolveRef(`origin/${pair.branch}`);
    let conflictErr = null;
    try {
      await git.merge({
        ...pair.local.git,
        ours: pair.branch,
        theirs: `origin/${pair.branch}`,
        mergeDriver: oursMergeDriver,
        message: 'merge origin with ours driver',
      });
    } catch (err) {
      conflictErr = err;
    }
    expect(conflictErr).toBeTruthy();
    expect(String(conflictErr.code || conflictErr.name)).toContain('MergeConflict');

    // Fallback: resolve binary keeping LOCAL version.
    await resolveBinaryOurs(facadeFor(pair), pair.local.dir, file, localHead);
    await git.commit({
      ...pair.local.git,
      message: 'merge origin (binary resolved, ours)',
      parent: [localHead, originHead],
    });

    // Working tree bytes == local bytes (hash equality).
    const onDisk = await pair.local.readBytes(file);
    expect(onDisk.equals(localBytes)).toBe(true);
    expect(onDisk.toString('hex')).toBe(localBytes.toString('hex'));
  });
});
