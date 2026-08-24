/**
 * @fileoverview Task 4 (git-sync-strategy plan): backup branch retention
 * (7 days) + pruning — TDD.
 *
 * Covers:
 *   1. Pruning respects the 7-day window: 8-day-old backup deleted,
 *      6-day-old kept (timestamps fabricated via real commits with old
 *      committer timestamps — readCommit is the production clock source).
 *   2. Successful sync does NOT delete a freshly created backup
 *      (retention semantics: cleanupBackupBranch no longer deletes).
 *   3. Unit-level pruning via mock provider (listBranches/resolveRef/
 *      readCommit/deleteBranch only — no new provider methods).
 *   4. Best-effort: pruning failures never throw.
 *
 * @vitest-environment node
 */
import { vi } from 'vitest';

// Real FS needed for the harness repos.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import { describe, it, expect, afterEach } from 'vitest';
import gitModule from 'isomorphic-git';

import { GitSafety, createObjectStyleOps } from '../../src/ipc/gitSafety.js';
import { createRepoPair } from './fixtures/harness.js';
import { createMockGitProvider } from './fixtures/mockProvider.js';

const git = gitModule.default || gitModule;
const DAY_MS = 24 * 60 * 60 * 1000;
const silence = () => {};
const logger = { info: silence, warn: silence, error: silence, debug: silence };

/** Track created repo pairs for disposal. */
const pairs = [];
afterEach(() => {
  while (pairs.length) pairs.pop().dispose();
});

async function newPair(opts) {
  const pair = await createRepoPair(opts);
  pairs.push(pair);
  return pair;
}

/**
 * Create a backup branch whose tip commit has a committer timestamp
 * `ageDays` in the past (the realistic way readCommit sees old backups).
 */
async function makeBackupAtAge(repo, name, ageDays) {
  const ts = Math.floor((Date.now() - ageDays * DAY_MS) / 1000);
  const file = `bk-${name.replace(/[/\\]/g, '_')}.txt`;
  repo.writeFiles({ [file]: name });
  await git.add({ fs, dir: repo.dir, filepath: file });
  const oid = await git.commit({
    fs,
    dir: repo.dir,
    message: `backup seed ${name}`,
    author: { name: 'test', email: 'test@test.local', timestamp: ts },
  });
  await git.branch({ fs, dir: repo.dir, ref: name, checkout: false });
  return oid;
}

const branchNames = (dir) => git.listBranches({ fs, dir });

// ─── 1. Real repo: pruning window ────────────────────────────────────────────

describe('pruneOldBackups — real repo, 7-day window', () => {
  it('deletes the 8-day-old backup and keeps the 6-day-old one', async () => {
    const pair = await newPair();
    await pair.local.fetch();

    await makeBackupAtAge(pair.local, 'backup/main-aaaaaaa-111', 8);
    await makeBackupAtAge(pair.local, 'backup/main-bbbbbbb-222', 6);

    const safety = new GitSafety({ logger });
    const result = await safety.pruneOldBackups(git, fs, pair.local.dir, 7);

    expect(result.pruned).toEqual(['backup/main-aaaaaaa-111']);
    const branches = await branchNames(pair.local.dir);
    expect(branches).toContain('backup/main-bbbbbbb-222');
    expect(branches).not.toContain('backup/main-aaaaaaa-111');
  });

  it('ignores non-backup branches regardless of age', async () => {
    const pair = await newPair();

    // 8-day-old commit on a NORMAL branch — must survive pruning.
    const ts = Math.floor((Date.now() - 8 * DAY_MS) / 1000);
    pair.local.writeFiles({ old: 'old' });
    await git.add({ fs, dir: pair.local.dir, filepath: 'old' });
    await git.commit({
      fs,
      dir: pair.local.dir,
      message: 'old commit on main',
      author: { name: 'test', email: 'test@test.local', timestamp: ts },
    });

    const safety = new GitSafety({ logger });
    await safety.pruneOldBackups(git, fs, pair.local.dir, 7);

    expect(await branchNames(pair.local.dir)).toContain('main');
  });
});

// ─── 2. Successful sync does not delete a fresh backup ──────────────────────

describe('retention — sync success keeps fresh backup', () => {
  it('cleanupBackupBranch (post-success) + pruneOldBackups both retain a fresh backup', async () => {
    const pair = await newPair({ files: { 'a.txt': 'base' }, branch: 'main' });
    await pair.local.fetch();

    // Dirty tree → _safeResetOrCheckout creates a backup before resetting.
    pair.local.writeFiles({ 'b.txt': 'dirty work' });
    const safety = new GitSafety({ logger });
    const { backupBranch } = await safety._safeResetOrCheckout(
      git,
      fs,
      pair.local.dir,
      'origin/main'
    );
    expect(backupBranch).toMatch(/^backup\//);

    // Old behavior deleted here. New (Task 4): retention.
    await safety.cleanupBackupBranch(git, fs, pair.local.dir, backupBranch);
    await safety.pruneOldBackups(git, fs, pair.local.dir, 7);

    expect(await branchNames(pair.local.dir)).toContain(backupBranch);
  });

  it('pruneOldBackups keeps a backup created right now (age ~0)', async () => {
    const pair = await newPair();
    await makeBackupAtAge(pair.local, 'backup/main-ccccccc-333', 0);

    const safety = new GitSafety({ logger });
    const result = await safety.pruneOldBackups(git, fs, pair.local.dir, 7);

    expect(result.pruned).toEqual([]);
    expect(await branchNames(pair.local.dir)).toContain('backup/main-ccccccc-333');
  });
});

// ─── 3. Unit level: mock provider ────────────────────────────────────────────

describe('pruneOldBackups — mock provider', () => {
  const OLD_TS = Math.floor((Date.now() - 8 * DAY_MS) / 1000);
  const NEW_TS = Math.floor((Date.now() - 6 * DAY_MS) / 1000);

  function mockWithBackups() {
    const oidFor = {
      'backup/main-old-1': 'o'.repeat(40),
      'backup/main-new-2': 'n'.repeat(40),
      main: 'm'.repeat(40),
    };
    const commitFor = {
      [oidFor['backup/main-old-1']]: { committer: { timestamp: OLD_TS } },
      [oidFor['backup/main-new-2']]: { committer: { timestamp: NEW_TS } },
    };
    const provider = createMockGitProvider({
      listBranches: async () => Object.keys(oidFor),
      resolveRef: async (dir, ref) => oidFor[ref] || 'x'.repeat(40),
      readCommit: async (dir, oid) => ({ oid, commit: commitFor[oid] }),
    });
    return { provider };
  }

  it('deletes only backups older than the window, via existing provider methods', async () => {
    const { provider } = mockWithBackups();
    const safety = new GitSafety({ logger });
    const result = await safety.pruneOldBackups(createObjectStyleOps(provider), fs, '/repo', 7);

    expect(result.pruned).toEqual(['backup/main-old-1']);
    expect(provider.deleteBranch).toHaveBeenCalledTimes(1);
    expect(provider.deleteBranch).toHaveBeenCalledWith('/repo', 'backup/main-old-1');
  });

  it('best-effort: readCommit failure skips the branch without throwing', async () => {
    const provider = createMockGitProvider({
      listBranches: async () => ['backup/a-1', 'backup/b-2'],
      resolveRef: async (dir, ref) => `sha-${ref}`,
      readCommit: async () => {
        throw new Error('corrupted object');
      },
    });
    const safety = new GitSafety({ logger });
    await expect(
      safety.pruneOldBackups(createObjectStyleOps(provider), fs, '/repo', 7)
    ).resolves.toEqual({ pruned: [] });
    expect(provider.deleteBranch).not.toHaveBeenCalled();
  });

  it('best-effort: listBranches failure resolves empty (sync must not fail)', async () => {
    const provider = createMockGitProvider({
      listBranches: async () => {
        throw new Error('no repo');
      },
    });
    const safety = new GitSafety({ logger });
    await expect(
      safety.pruneOldBackups(createObjectStyleOps(provider), fs, '/repo', 7)
    ).resolves.toEqual({ pruned: [] });
  });
});
