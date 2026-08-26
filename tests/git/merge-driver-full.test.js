/**
 * @fileoverview TDD tests for fullLocalMergeDriver / fullRemoteMergeDriver
 * + resolveBinaryFullLocal / resolveBinaryFullRemote
 * (conflict-strategy-modal plan, Task 2).
 *
 * User semantics (decision 2026-08-25): "full" = TOTAL priority for the
 * winning side, but NON-conflicting changes from the OTHER side still
 * enter the merge. Only the CONFLICTING hunks/files become integral to
 * the winner — a whole-file substitution would silently discard the
 * other side's non-conflicting hunks in the same file.
 *
 * Fixture mirrors tests/git/merge-semantics-regression.test.js:
 * 8-line base, conflict on line 2, non-conflicting edit on line 6.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createRepoPair, makeConflict } from './fixtures/harness.js';
import { httpBackendAvailable } from './fixtures/harness.js';
import {
  fullLocalMergeDriver,
  fullRemoteMergeDriver,
  resolveBinaryFullLocal,
  resolveBinaryFullRemote,
} from '../../src/ipc/gitMergeDriver.js';

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

// Same 8-line fixture as merge-semantics-regression.test.js.
const BASE = Array.from({ length: 8 }, (_, i) => `line${i + 1}\n`).join('');

/** Merge origin into local with the given driver, materialize HEAD. */
async function mergeWithDriver(driver) {
  await pair.local.fetch();
  const originHead = await pair.local.resolveRef(`origin/${pair.branch}`);
  await git.merge({
    ...pair.local.git,
    ours: pair.branch,
    theirs: `origin/${pair.branch}`,
    mergeDriver: driver,
    message: 'merge origin with full driver',
  });
  // iso-git merge does not touch the working tree — materialize HEAD.
  await git.checkout({ ...pair.local.git, ref: pair.branch, force: true });
  return originHead;
}

describe.skipIf(!httpBackendAvailable)('fullLocalMergeDriver (text, real repo)', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  it('conflicting line 2 = LOCAL integral AND non-conflicting remote line 6 PRESENT', async () => {
    pair = await createRepoPair();
    const { file } = await makeConflict(pair, {
      file: 'doc.md',
      base: BASE,
      local: BASE.replace('line2\n', 'line2-LOCAL\n'),
      remote: BASE
        .replace('line2\n', 'line2-REMOTE\n')
        .replace('line6\n', 'line6-REMOTE\n'),
    });

    await mergeWithDriver(fullLocalMergeDriver);

    const merged = await pair.local.readFile(file);
    // Conflicting hunk: LOCAL integral wins.
    expect(merged).toContain('line2-LOCAL\n');
    expect(merged).not.toContain('line2-REMOTE\n');
    // Non-conflicting remote hunk in the SAME file: still merges in.
    expect(merged).toContain('line6-REMOTE\n');
  });

  it('returns cleanMerge:false when local content is unavailable', () => {
    expect(
      fullLocalMergeDriver({
        branches: ['base', 'ours', 'theirs'],
        contents: ['b\n', undefined, 't\n'],
        path: 'x.txt',
      })
    ).toEqual({ cleanMerge: false });
  });

  it('binary (U+FFFD) surfaces cleanMerge:false with mandatory mergedText', () => {
    const { cleanMerge, mergedText } = fullLocalMergeDriver({
      branches: ['base', 'ours', 'theirs'],
      contents: ['\uFFFDbin', '\uFFFDours', 't'],
      path: 'asset.bin',
    });
    expect(cleanMerge).toBe(false);
    // mergedText obrigatório mesmo em conflito (Buffer.from incondicional
    // no mergeBlobs do iso-git).
    expect(mergedText).toBe('\uFFFDours');
  });
});

describe.skipIf(!httpBackendAvailable)('fullRemoteMergeDriver (text, real repo)', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  it('conflicting line 2 = REMOTE integral AND non-conflicting local line 6 PRESERVED', async () => {
    pair = await createRepoPair();
    const { file } = await makeConflict(pair, {
      file: 'doc.md',
      base: BASE,
      // Local has the conflicting line 2 PLUS its own non-conflicting
      // line 6 edit — the latter must survive a full-remote merge.
      local: BASE
        .replace('line2\n', 'line2-LOCAL\n')
        .replace('line6\n', 'line6-LOCAL\n'),
      remote: BASE.replace('line2\n', 'line2-REMOTE\n'),
    });

    await mergeWithDriver(fullRemoteMergeDriver);

    const merged = await pair.local.readFile(file);
    // Conflicting hunk: REMOTE integral wins.
    expect(merged).toContain('line2-REMOTE\n');
    expect(merged).not.toContain('line2-LOCAL\n');
    // Non-conflicting local hunk in the SAME file: still merges in.
    expect(merged).toContain('line6-LOCAL\n');
  });

  it('returns cleanMerge:false when remote content is unavailable', () => {
    expect(
      fullRemoteMergeDriver({
        branches: ['base', 'ours', 'theirs'],
        contents: ['b\n', 'o\n', undefined],
        path: 'x.txt',
      })
    ).toEqual({ cleanMerge: false });
  });

  it('binary (U+FFFD) surfaces cleanMerge:false with mandatory mergedText', () => {
    const { cleanMerge, mergedText } = fullRemoteMergeDriver({
      branches: ['base', 'ours', 'theirs'],
      contents: ['\uFFFDbin', 'o', '\uFFFDtheirs'],
      path: 'asset.bin',
    });
    expect(cleanMerge).toBe(false);
    expect(mergedText).toBe('\uFFFDtheirs');
  });
});

describe('direction markers (DugiteProvider.mergeDriverFavor contract)', () => {
  it('fullLocalMergeDriver.direction === "full-local"', () => {
    expect(fullLocalMergeDriver.direction).toBe('full-local');
  });

  it('fullRemoteMergeDriver.direction === "full-remote"', () => {
    expect(fullRemoteMergeDriver.direction).toBe('full-remote');
  });
});

describe.skipIf(!httpBackendAvailable)('binary fallbacks (real repo)', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  it('resolveBinaryFullLocal keeps LOCAL bytes (identical hash)', async () => {
    const localBytes = Buffer.from([1, 2, 0xff, 0xff, 0, 0, 7, 8]);
    pair = await createRepoPair();
    const { file, localHead } = await makeConflict(pair, {
      binary: true,
      local: localBytes,
    });

    let conflictErr = null;
    try {
      await mergeWithDriver(fullLocalMergeDriver);
    } catch (err) {
      conflictErr = err;
    }
    expect(conflictErr).toBeTruthy();
    expect(String(conflictErr.code || conflictErr.name)).toContain('MergeConflict');

    await pair.local.fetch();
    const originHead = await pair.local.resolveRef(`origin/${pair.branch}`);
    await resolveBinaryFullLocal(facadeFor(pair), pair.local.dir, file, localHead);
    await git.commit({
      ...pair.local.git,
      message: 'merge origin (binary resolved, full-local)',
      parent: [localHead, originHead],
    });

    const onDisk = await pair.local.readBytes(file);
    expect(onDisk.equals(localBytes)).toBe(true);
  });

  it('resolveBinaryFullRemote keeps REMOTE bytes (identical hash)', async () => {
    const remoteBytes = Buffer.from([1, 2, 0xaa, 0xbb, 0, 0, 7, 8]);
    pair = await createRepoPair();
    const { file, localHead } = await makeConflict(pair, {
      binary: true,
      remote: remoteBytes,
    });

    let conflictErr = null;
    try {
      await mergeWithDriver(fullRemoteMergeDriver);
    } catch (err) {
      conflictErr = err;
    }
    expect(conflictErr).toBeTruthy();
    expect(String(conflictErr.code || conflictErr.name)).toContain('MergeConflict');

    await pair.local.fetch();
    const originHead = await pair.local.resolveRef(`origin/${pair.branch}`);
    await resolveBinaryFullRemote(facadeFor(pair), pair.local.dir, file, originHead);
    await git.commit({
      ...pair.local.git,
      message: 'merge origin (binary resolved, full-remote)',
      parent: [localHead, originHead],
    });

    const onDisk = await pair.local.readBytes(file);
    expect(onDisk.equals(remoteBytes)).toBe(true);
  });
});
