/**
 * @fileoverview DugiteProvider.canFastForward (publish-update-resilience
 * Task 4 — the CRITICAL perf bottleneck fix).
 *
 * DugiteProvider previously had NO canFastForward, so every flow call
 * site (`git.js` _publishCore/_refreshCore/_pullCore) got a TypeError
 * silently swallowed as `localAhead = false` — forcing deepen-fetch +
 * full merge on every publish/update even when the local branch was
 * simply ahead. This suite pins the contract of the new implementation
 * (`git merge-base --is-ancestor`) against the IsomorphicGitProvider
 * signature (`{ ref, target }`, ancestor=true means ff-possible):
 *
 *   - ancestor            → true  (fast-forward possible)
 *   - diverged/descendant → false (exit 1 is a RESULT, not an error)
 *   - equal OIDs          → true  (iso-git equality shortcut parity)
 *   - default target      → HEAD
 *   - nonexistent ref     → GitError (exit 128) — thrown, never a
 *     boolean lie; call sites already treat this as "cannot tell"
 *   - `_run` allowedExitCodes mode: `{stdout, exitCode}` resolution
 *     for listed codes, GitError for unlisted ones, unchanged default
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import os from 'os';

import { DugiteProvider } from '../../src/git/providers/DugiteProvider.js';
import { gitSetup, isGitError, GIT_AUTHOR } from './harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Two-branch fixture driven entirely through the provider (the
 * dugite-merge-direction.test.js pattern): base on main, `side` branch
 * adds a commit, main adds a different commit → diverged.
 */
async function divergedRepo(base) {
  const dir = path.join(base, 'work');
  fs.mkdirSync(dir, { recursive: true });
  await gitSetup(['init', '-b', 'main', '.'], dir);
  const provider = new DugiteProvider();
  await provider.setConfig(dir, 'user.name', GIT_AUTHOR.name);
  await provider.setConfig(dir, 'user.email', GIT_AUTHOR.email);

  const commit = async (file, content, message) => {
    fs.writeFileSync(path.join(dir, file), content);
    await provider.add(dir, file);
    return provider.commit(dir, message);
  };

  const baseOid = await commit('base.txt', 'v1\n', 'base: common ancestor');

  await provider.branch(dir, 'side');
  await provider.checkout(dir, 'side');
  const sideOid = await commit('side.txt', 'side\n', 'side: ahead commit');

  await provider.checkout(dir, 'main');
  const mainOid = await commit('main.txt', 'main\n', 'main: divergent commit');

  return { dir, provider, baseOid, sideOid, mainOid };
}

describe('DugiteProvider.canFastForward (merge-base --is-ancestor)', () => {
  let base;
  let repo;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'dugite-canff-'));
    repo = await divergedRepo(base);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('ancestor → true: base is an ancestor of main and of side (ff possible)', async () => {
    const { dir, provider, baseOid, mainOid, sideOid } = repo;
    // raw OIDs
    await expect(
      provider.canFastForward(dir, { ref: baseOid, target: mainOid })
    ).resolves.toBe(true);
    await expect(
      provider.canFastForward(dir, { ref: baseOid, target: sideOid })
    ).resolves.toBe(true);
    // ref names (HEAD = main on checkout): a ref is its own ancestor
    await expect(
      provider.canFastForward(dir, { ref: 'main', target: 'HEAD' })
    ).resolves.toBe(true);
  });

  it('diverged refs → false on BOTH directions (exit 1 = result, not error)', async () => {
    const { dir, provider } = repo;
    await expect(
      provider.canFastForward(dir, { ref: 'main', target: 'side' })
    ).resolves.toBe(false);
    await expect(
      provider.canFastForward(dir, { ref: 'side', target: 'main' })
    ).resolves.toBe(false);
  });

  it('equal OIDs → true (iso-git equality shortcut parity)', async () => {
    const { dir, provider, mainOid } = repo;
    await expect(
      provider.canFastForward(dir, { ref: mainOid, target: mainOid })
    ).resolves.toBe(true);
  });

  it('target defaults to HEAD (iso-git contract)', async () => {
    const { dir, provider, baseOid } = repo;
    // HEAD = main; base is an ancestor of HEAD
    await expect(
      provider.canFastForward(dir, { ref: baseOid })
    ).resolves.toBe(true);
    // and HEAD is not an ancestor of base
    await expect(
      provider.canFastForward(dir, { ref: 'HEAD', target: baseOid })
    ).resolves.toBe(false);
  });

  it('nonexistent ref → GitError (thrown, never a boolean lie)', async () => {
    const { dir, provider } = repo;
    const err = await provider
      .canFastForward(dir, { ref: 'origin/does-not-exist', target: 'HEAD' })
      .then(() => null, (e) => e);
    expect(isGitError(err)).toBe(true);
    expect(err.exitCode).not.toBe(0);
    expect(err.exitCode).not.toBe(1);
  });

  it('history shape stays honest: ancestor walks a chain, not a coincidence', async () => {
    const { dir, provider } = repo;
    // side → one more commit on side; base still ancestor, main still not
    fs.writeFileSync(path.join(dir, 'side2.txt'), 'side2\n');
    await provider.checkout(dir, 'side');
    await provider.add(dir, 'side2.txt');
    await provider.commit(dir, 'side: second commit');
    await provider.checkout(dir, 'main');
    await expect(
      provider.canFastForward(dir, { ref: 'side', target: 'HEAD' })
    ).resolves.toBe(false);
    await expect(
      provider.canFastForward(dir, { ref: 'HEAD', target: 'HEAD' })
    ).resolves.toBe(true);
  });
});

describe('DugiteProvider._run allowedExitCodes (Task 4)', () => {
  let base;
  let repo;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'dugite-runexit-'));
    repo = await divergedRepo(base);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('default mode unchanged: exit 1 throws GitError, exit 0 resolves stdout', async () => {
    const { dir, provider, baseOid, sideOid } = repo;
    const out = await provider._run(
      'canFastForward',
      ['merge-base', '--is-ancestor', baseOid, 'HEAD'],
      dir,
      { repoPath: dir },
    );
    expect(typeof out).toBe('string');

    // side is NOT an ancestor of HEAD (main) → exit 1 → GitError
    const err = await provider
      ._run('canFastForward', ['merge-base', '--is-ancestor', sideOid, 'HEAD'], dir, {
        repoPath: dir,
      })
      .then(() => null, (e) => e);
    expect(isGitError(err)).toBe(true);
    expect(err.exitCode).toBe(1);
  });

  it('allowedExitCodes: listed codes resolve {stdout, exitCode}; unlisted still throw', async () => {
    const { dir, provider, sideOid } = repo;

    const yes = await provider._run(
      'canFastForward',
      ['merge-base', '--is-ancestor', 'HEAD', 'HEAD'],
      dir,
      { repoPath: dir },
      { allowedExitCodes: [0, 1] },
    );
    expect(yes).toMatchObject({ exitCode: 0 });

    const no = await provider._run(
      'canFastForward',
      ['merge-base', '--is-ancestor', sideOid, 'HEAD'],
      dir,
      { repoPath: dir },
      { allowedExitCodes: [0, 1] },
    );
    expect(no).toMatchObject({ exitCode: 1 });

    // exit 128 (bad ref) is NOT in the list → still a GitError
    const err = await provider
      ._run(
        'canFastForward',
        ['merge-base', '--is-ancestor', 'no-such-ref', 'HEAD'],
        dir,
        { repoPath: dir },
        { allowedExitCodes: [0, 1] },
      )
      .then(() => null, (e) => e);
    expect(isGitError(err)).toBe(true);
    expect(err.exitCode).toBe(128);
  });
});
