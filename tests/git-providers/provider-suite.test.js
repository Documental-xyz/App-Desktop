/**
 * @fileoverview Dual-provider contract suite (plan checkbox 18 / PRD §28).
 *
 * `describeGitProvider(name, factory)` runs the SAME parametrized battery
 * of specs against both git providers (isomorphic-git — the INCUMBENT
 * that defines the contract — and dugite). Fixture expectations are
 * derived from incumbent behavior (iso-git), never from dugite.
 *
 * Runner contract: GIT_PROVIDER env selects ONE provider; unset runs BOTH
 * sequentially (`npm run test:providers`).
 *
 * Known documented divergences (NOT tested in the common battery):
 *  - Racy same-second same-size rewrite (T17): iso statusMatrix returns
 *    [1,1,1] (stale stat-cache) where git/dugite re-hash → [1,2,1]. A
 *    bug in iso-git's raciness protection; consumers only count dirty
 *    files. Excluded from the common fixtures — all "modified" fixtures
 *    below deliberately change file LENGTH so the stat cache cannot hit.
 *  - iso-git http/node does not honor in-flight AbortSignal (T9): the
 *    provider forwards `signal` per contract, but the observable outcome
 *    (GitError) arrives via iso's internal ~5s request timeout rather
 *    than an immediate kill (dugite kills the process). The cancellation
 *    spec asserts the CONTRACT (GitError), not the timing.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';

import { theirsMergeDriver } from '../../src/ipc/gitMergeDriver.js';
import {
  makeTempDir,
  createHttpRemote,
  createBlackholeServer,
  advanceRemoteHead,
  remoteHead,
  initLocalRepo,
  gitSetup,
  providersUnderTest,
  providerFactory,
  isGitError,
  GIT_AUTHOR,
} from './harness.js';
import { resetGitProviderCache } from '../../src/git/GitProviderFactory.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** Row lookup helper for statusMatrix results. */
function rowFor(matrix, file) {
  const row = matrix.find((r) => r[0] === file);
  expect(row, `statusMatrix must contain a row for ${file}`).toBeDefined();
  return row.slice(1);
}

/**
 * The parametrized dual-provider battery.
 * @param {string} name - provider name ('isomorphic-git' | 'dugite')
 * @param {() => Object} factory - builds a FRESH provider instance
 */
function describeGitProvider(name, factory) {
  describe(`provider: ${name}`, () => {
    /** @type {Object} */
    let provider;
    /** @type {string} */
    let base;
    const originalEnv = process.env.GIT_PROVIDER;

    beforeEach(() => {
      base = makeTempDir('dual-suite-');
      provider = factory();
    });

    afterEach(() => {
      resetGitProviderCache();
      if (originalEnv === undefined) {
        delete process.env.GIT_PROVIDER;
      } else {
        process.env.GIT_PROVIDER = originalEnv;
      }
      fs.rmSync(base, { recursive: true, force: true });
    });

    // ─── Full local cycle ──────────────────────────────────────────────

    it('full local cycle: add → commit → branch → checkout → statusMatrix → resolveRef → readCommit', async () => {
      const dir = path.join(base, 'work');
      await initLocalRepo(dir);

      fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha content\n');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'beta content\n');
      await provider.add(dir, ['a.txt', 'b.txt']);
      const oid1 = await provider.commit(dir, 'init: two files');
      expect(oid1).toMatch(/^[0-9a-f]{40}$/);

      await provider.branch(dir, 'feature');
      expect(await provider.listBranches(dir)).toEqual(
        expect.arrayContaining(['main', 'feature'])
      );

      await provider.checkout(dir, 'feature');
      expect(await provider.currentBranch(dir)).toBe('feature');

      fs.writeFileSync(path.join(dir, 'c.txt'), 'gamma feature-only\n');
      await provider.add(dir, 'c.txt');
      await provider.commit(dir, 'feature work');

      await provider.checkout(dir, 'main');
      expect(await provider.currentBranch(dir)).toBe('main');

      const matrix = await provider.statusMatrix(dir);
      // c.txt was checked away with the branch; a/b clean at HEAD.
      expect(rowFor(matrix, 'a.txt')).toEqual([1, 1, 1]);
      expect(rowFor(matrix, 'b.txt')).toEqual([1, 1, 1]);
      expect(matrix.find((r) => r[0] === 'c.txt')).toBeUndefined();

      const head = await provider.resolveRef(dir, 'HEAD');
      expect(head).toBe(oid1);

      const { commit, payload } = await provider.readCommit(dir, head);
      expect(commit.message).toContain('init: two files');
      expect(commit.parent).toEqual([]);
      expect(typeof payload).toBe('string');
    });

    // ─── Shallow fetch semantics over the shared loopback transport ────

    it('shallow clone (depth 10) creates .git/shallow for both providers (same loopback http transport)', async () => {
      // History longer than the clone depth (10): git skips .git/shallow
      // when the cutoff would land at/below the root commit.
      const { server, url } = await createHttpRemote(base, { commits: 12 });
      try {
        const dir = path.join(base, 'clone');
        await provider.clone(url, dir);
        // App-wide shallow semantics: clone --single-branch --depth 10.
        expect(fs.existsSync(path.join(dir, '.git', 'shallow'))).toBe(true);
        expect(await provider.currentBranch(dir)).toBe('main');
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('shallow fetch (depth 1) tracks a remote advance on the same transport', async () => {
      const { server, url, bare } = await createHttpRemote(base);
      try {
        const dir = path.join(base, 'clone');
        await provider.clone(url, dir);

        const advanced = await advanceRemoteHead(bare, 'fetch target');
        await provider.fetch(dir, { depth: 1, ref: 'main' });

        expect(await provider.resolveRef(dir, 'origin/main')).toBe(advanced);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    // ─── Branch / checkout / delete ─────────────────────────────────────

    it('deleteBranch removes an unmerged branch (parity: iso deletes unmerged; dugite uses -D)', async () => {
      const dir = path.join(base, 'work');
      await initLocalRepo(dir);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
      await provider.add(dir, 'a.txt');
      await provider.commit(dir, 'init');

      await provider.branch(dir, 'throwaway');
      await provider.checkout(dir, 'throwaway');
      fs.writeFileSync(path.join(dir, 't.txt'), 'unmerged work\n');
      await provider.add(dir, 't.txt');
      await provider.commit(dir, 'unmerged commit');
      await provider.checkout(dir, 'main');

      await provider.deleteBranch(dir, 'throwaway');
      expect(await provider.listBranches(dir)).not.toContain('throwaway');
    });

    // ─── Merge strategies (theirs) ──────────────────────────────────────

    it('merge with theirs mergeDriver resolves conflicts with theirs content and 2 parents', async () => {
      const dir = path.join(base, 'work');
      await initLocalRepo(dir);
      // iso merge requires an author (no DEFAULT_AUTHOR fallback there);
      // local user config serves both providers.
      await provider.setConfig(dir, 'user.name', GIT_AUTHOR.name);
      await provider.setConfig(dir, 'user.email', GIT_AUTHOR.email);

      fs.writeFileSync(path.join(dir, 'conflicted.txt'), 'base line\n');
      await provider.add(dir, 'conflicted.txt');
      await provider.commit(dir, 'base');

      await provider.branch(dir, 'theirs-branch');
      await provider.checkout(dir, 'theirs-branch');
      fs.writeFileSync(path.join(dir, 'conflicted.txt'), 'THEIRS version line\n');
      await provider.add(dir, 'conflicted.txt');
      await provider.commit(dir, 'theirs change');

      await provider.checkout(dir, 'main');
      fs.writeFileSync(path.join(dir, 'conflicted.txt'), 'OURS different line\n');
      await provider.add(dir, 'conflicted.txt');
      await provider.commit(dir, 'ours change');

      // The app path (git.js:1237/1695/1933): mergeDriver = theirsMergeDriver.
      await provider.merge(dir, 'theirs-branch', {
        fastForward: false,
        mergeDriver: theirsMergeDriver,
      });

      // Documented divergence (workdir side effects): iso-git write ops
      // do NOT update the working tree (the file stays at the OURS
      // content), while dugite's `git merge -X theirs` rewrites it. The
      // CONTRACT both must honor is the committed TREE — read the blob
      // from the merge commit's HEAD.
      const head = await provider.resolveRef(dir, 'HEAD');
      const { blob } = await provider.readBlob(dir, head, { filepath: 'conflicted.txt' });
      expect(Buffer.from(blob).toString('utf8')).toBe('THEIRS version line\n');

      const { commit } = await provider.readCommit(dir, head);
      expect(commit.parent).toHaveLength(2);
    });

    // ─── Config roundtrip ───────────────────────────────────────────────

    it('config roundtrip: setConfig → getConfig; unset key is nullish', async () => {
      const dir = path.join(base, 'work');
      await initLocalRepo(dir);

      await provider.setConfig(dir, 'user.name', 'Dual Suite');
      expect(await provider.getConfig(dir, 'user.name')).toBe('Dual Suite');

      await provider.setConfig(dir, 'dual.suite.marker', 'ok-42');
      expect(await provider.getConfig(dir, 'dual.suite.marker')).toBe('ok-42');

      // iso-git returns undefined, dugite null for unset keys — both
      // nullish (documented, contract-level equality).
      const unset = await provider.getConfig(dir, 'dual.suite.absent');
      expect(unset == null).toBe(true);
    });

    // ─── statusMatrix fixtures (values fixed by the INCUMBENT, T17) ─────

    /**
     * Fresh repo with one committed file 'base file content' (17 bytes).
     * @returns {Promise<string>} repo dir
     */
    async function matrixFixtureRepo() {
      const dir = path.join(base, 'matrix');
      await initLocalRepo(dir);
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base file content\n');
      await provider.add(dir, 'tracked.txt');
      await provider.commit(dir, 'matrix base');
      return dir;
    }

    it('statusMatrix: clean tree is [1,1,1]', async () => {
      const dir = await matrixFixtureRepo();
      expect(rowFor(await provider.statusMatrix(dir), 'tracked.txt'))
        .toEqual([1, 1, 1]);
    });

    it('statusMatrix: untracked file is [0,2,0]', async () => {
      const dir = await matrixFixtureRepo();
      fs.writeFileSync(path.join(dir, 'new.txt'), 'never committed\n');
      expect(rowFor(await provider.statusMatrix(dir), 'new.txt'))
        .toEqual([0, 2, 0]);
    });

    it('statusMatrix: unstaged modification is [1,2,1]', async () => {
      const dir = await matrixFixtureRepo();
      // Different LENGTH than the committed blob — dodges the documented
      // same-second racy divergence (T17) by design.
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base file content — EDITED LONGER\n');
      expect(rowFor(await provider.statusMatrix(dir), 'tracked.txt'))
        .toEqual([1, 2, 1]);
    });

    it('statusMatrix: staged modification is [1,2,2]', async () => {
      const dir = await matrixFixtureRepo();
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base file content — STAGED EDIT LONGER\n');
      await provider.add(dir, 'tracked.txt');
      expect(rowFor(await provider.statusMatrix(dir), 'tracked.txt'))
        .toEqual([1, 2, 2]);
    });

    it('statusMatrix: staged new file (add) is [0,2,2]', async () => {
      const dir = await matrixFixtureRepo();
      fs.writeFileSync(path.join(dir, 'added.txt'), 'staged addition\n');
      await provider.add(dir, 'added.txt');
      expect(rowFor(await provider.statusMatrix(dir), 'added.txt'))
        .toEqual([0, 2, 2]);
    });

    it('statusMatrix: unstaged deletion is [1,0,1]', async () => {
      const dir = await matrixFixtureRepo();
      fs.unlinkSync(path.join(dir, 'tracked.txt'));
      expect(rowFor(await provider.statusMatrix(dir), 'tracked.txt'))
        .toEqual([1, 0, 1]);
    });

    it('statusMatrix: staged deletion (remove) clears the stage, workdir file PRESERVED', async () => {
      const dir = await matrixFixtureRepo();
      await provider.remove(dir, 'tracked.txt');
      const row = rowFor(await provider.statusMatrix(dir), 'tracked.txt');
      // UNIFIED contract (post 7afc290): remove is index-only
      // (`git rm --cached -f` parity with iso-git 1.38.4) — the workdir
      // file survives and the row is the 'rm --cached' shape [1,1,0]
      // in BOTH providers.
      expect(fs.existsSync(path.join(dir, 'tracked.txt'))).toBe(true);
      expect(row).toEqual([1, 1, 0]);
    });

    it('merge conflict throws GitError(conflict); CLI-conflicted repo reads [1,2,3] in statusMatrix', async () => {
      // (a) provider.merge on diverged branches must reject with a
      // conflict-classified GitError.
      const dir = path.join(base, 'conflict');
      await initLocalRepo(dir);
      await provider.setConfig(dir, 'user.name', GIT_AUTHOR.name);
      await provider.setConfig(dir, 'user.email', GIT_AUTHOR.email);
      fs.writeFileSync(path.join(dir, 'k.txt'), 'line one\n');
      await provider.add(dir, 'k.txt');
      await provider.commit(dir, 'base');

      await provider.branch(dir, 'side');
      await provider.checkout(dir, 'side');
      fs.writeFileSync(path.join(dir, 'k.txt'), 'line one THEIRS\n');
      await provider.add(dir, 'k.txt');
      await provider.commit(dir, 'theirs');
      await provider.checkout(dir, 'main');
      fs.writeFileSync(path.join(dir, 'k.txt'), 'line one OURS\n');
      await provider.add(dir, 'k.txt');
      await provider.commit(dir, 'ours');

      let err = null;
      try {
        await provider.merge(dir, 'side');
      } catch (e) {
        err = e;
      }
      // iso: MergeConflictError ('...merge conflicts...' → conflict);
      // dugite: 'CONFLICT (content): Merge conflict' → conflict.
      expect(isGitError(err)).toBe(true);
      expect(
        err.errorType === 'conflict' || err.code === 'MergeConflictError'
      ).toBe(true);

      // (b) The conflicted-index STATE (T17 methodology): created with the
      // real git CLI — iso-git's merge implementation never writes
      // conflicted index entries, so the state cannot be produced via the
      // iso provider; both providers then READ the same on-disk state.
      const dir2 = path.join(base, 'cli-conflict');
      await initLocalRepo(dir2);
      fs.writeFileSync(path.join(dir2, 'k.txt'), 'line one\n');
      await gitSetup(['add', '.'], dir2);
      await gitSetup(
        ['-c', `user.email=${GIT_AUTHOR.email}`, '-c', `user.name=${GIT_AUTHOR.name}`,
          'commit', '-m', 'base'],
        dir2
      );
      await gitSetup(['checkout', '-b', 'side'], dir2);
      fs.writeFileSync(path.join(dir2, 'k.txt'), 'line one THEIRS\n');
      await gitSetup(['add', '.'], dir2);
      await gitSetup(
        ['-c', `user.email=${GIT_AUTHOR.email}`, '-c', `user.name=${GIT_AUTHOR.name}`,
          'commit', '-m', 'theirs'],
        dir2
      );
      await gitSetup(['checkout', 'main'], dir2);
      fs.writeFileSync(path.join(dir2, 'k.txt'), 'line one OURS\n');
      await gitSetup(['add', '.'], dir2);
      await gitSetup(
        ['-c', `user.email=${GIT_AUTHOR.email}`, '-c', `user.name=${GIT_AUTHOR.name}`,
          'commit', '-m', 'ours'],
        dir2
      );
      // Unresolvable merge → exit 1 with CONFLICT (setup; the provider is
      // not involved in CREATING the state).
      await gitSetup(['merge', 'side'], dir2).catch(() => {});

      expect(rowFor(await provider.statusMatrix(dir2), 'k.txt'))
        .toEqual([1, 2, 3]);
    });

    // ─── Cancellation via signal ────────────────────────────────────────

    it('signal abort during a slow (blackhole) push rejects with GitError', async () => {
      const { close, url } = await createBlackholeServer();
      try {
        const dir = path.join(base, 'work');
        await initLocalRepo(dir);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
        await provider.add(dir, 'a.txt');
        await provider.commit(dir, 'to push');
        await provider.setConfig(dir, 'remote.origin.url', url);

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 250);

        let err = null;
        try {
          await provider.push(dir, { branch: 'main', signal: controller.signal });
        } catch (e) {
          err = e;
        }
        // CONTRACT: aborted network op surfaces as GitError. Timing is
        // provider-specific (dugite: kill; iso: internal ~5s request
        // timeout — documented divergence, T9) and is NOT asserted.
        expect(isGitError(err)).toBe(true);
      } finally {
        await close();
      }
    }, 60_000);
  });
}

// ─── Runner: GIT_PROVIDER selects one; unset runs BOTH sequentially ──────────
for (const name of providersUnderTest()) {
  describeGitProvider(name, providerFactory(name));
}
