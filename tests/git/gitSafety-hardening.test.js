/**
 * @fileoverview Task 5 — hardened gitSafety (git-sync-strategy plan).
 *
 * Covers the three safety invariants:
 *  1. Backup is MANDATORY and BLOCKING: if backup creation fails, the
 *     protected operation must not run — ZERO destructive provider
 *     mutations (mock spy via mockProvider helpers).
 *  2. statusMatrix failure = hard block: typed error, never dirty=[].
 *  3. Cancel does NOT delete backups; recovery = writeRef of the backup
 *     branch + checkout, restoring the working tree to backup content.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';

// Real-repo scenario (cancel/recovery) needs the real filesystem.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import gitModule from 'isomorphic-git';
import { GitSafety, GitSafetyError, createObjectStyleOps } from '../../src/ipc/gitSafety.js';
import { createMockGitProvider } from './fixtures/mockProvider.js';
import { createRepoPair, commitFile, makeDirty } from './fixtures/harness.js';
import { httpBackendAvailable } from './fixtures/harness.js';

const git = gitModule.default || gitModule;

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeSafety() {
  return new GitSafety({ logger: quietLogger });
}

/** Mock defaults that make the repo look "unpushed" (backup required). */
function unpushedMock(overrides = {}) {
  return createMockGitProvider({
    currentBranch: async () => 'preview',
    resolveRef: async ({ ref } = {}) =>
      ref === 'HEAD' ? 'aaaaaaa000000000000000000000000000000000' : 'bbbbbbb000000000000000000000000000000000',
    statusMatrix: async () => [['file.txt', 1, 2, 2]],
    ...overrides,
  });
}

// ─── 1. Mandatory blocking backup ────────────────────────────────────────────

describe('Task 5: backup creation failure blocks ALL destructive mutations', () => {
  it('createBranch throws → typed BACKUP_FAILED error, protected operation never runs', async () => {
    const safety = makeSafety();
    const provider = unpushedMock({
      branch: async () => {
        throw new Error('git branch exploded');
      },
    });
    const ops = createObjectStyleOps(provider);

    const operation = vi.fn(async () => {
      await provider.push('/repo', { remote: 'origin' });
      await provider.merge('/repo', 'aaaaaaa');
    });

    await expect(
      safety.withMandatoryBackup(ops, fs, '/repo', operation)
    ).rejects.toMatchObject({ code: 'BACKUP_FAILED' });

    await expect(
      safety.withMandatoryBackup(ops, fs, '/repo', operation)
    ).rejects.toBeInstanceOf(GitSafetyError);

    // The protected operation never ran → no destructive mutations.
    expect(operation).not.toHaveBeenCalled();
    expect(provider.push.mock.calls).toHaveLength(0);
    expect(provider.merge.mock.calls).toHaveLength(0);
    expect(provider.writeRef.mock.calls).toHaveLength(0);
    expect(provider.checkout.mock.calls).toHaveLength(0);
  });

  it('snapshot commit throws → typed BACKUP_FAILED error, operation never runs', async () => {
    const safety = makeSafety();
    const provider = unpushedMock({
      commit: async () => {
        throw new Error('commit exploded');
      },
    });
    const ops = createObjectStyleOps(provider);

    const operation = vi.fn();
    await expect(
      safety.withMandatoryBackup(ops, fs, '/repo', operation)
    ).rejects.toMatchObject({ code: 'BACKUP_FAILED' });
    expect(operation).not.toHaveBeenCalled();
    // No destructive mutation outside the backup attempt itself.
    expect(provider.writeRef.mock.calls).toHaveLength(0);
    expect(provider.merge.mock.calls).toHaveLength(0);
    expect(provider.push.mock.calls).toHaveLength(0);
  });

  it('backup succeeds → operation runs exactly once and result is forwarded', async () => {
    const safety = makeSafety();
    const provider = unpushedMock();
    const ops = createObjectStyleOps(provider);

    const operation = vi.fn(async () => 'done');
    const result = await safety.withMandatoryBackup(ops, fs, '/repo', operation);

    expect(result.result).toBe('done');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(result.backupBranch).toMatch(/^backup\//);
  });
});

// ─── 2. statusMatrix guard ───────────────────────────────────────────────────

describe('Task 5: statusMatrix failure is a hard block (never dirty=[])', () => {
  it('withMandatoryBackup → typed STATUS_MATRIX_FAILED, no mutations', async () => {
    const safety = makeSafety();
    const provider = unpushedMock({
      statusMatrix: async () => {
        throw new Error('index corrupted');
      },
    });
    const ops = createObjectStyleOps(provider);
    const operation = vi.fn();

    await expect(
      safety.withMandatoryBackup(ops, fs, '/repo', operation)
    ).rejects.toMatchObject({ code: 'STATUS_MATRIX_FAILED' });
    expect(operation).not.toHaveBeenCalled();
    expect(provider.writeRef.mock.calls).toHaveLength(0);
    expect(provider.checkout.mock.calls).toHaveLength(0);
  });

  it('_safeResetOrCheckout → typed STATUS_MATRIX_FAILED, no writeRef/checkout', async () => {
    const safety = makeSafety();
    const provider = unpushedMock({
      statusMatrix: async () => {
        throw new Error('index corrupted');
      },
    });
    const ops = createObjectStyleOps(provider);

    await expect(
      safety._safeResetOrCheckout(ops, fs, '/repo', 'origin/preview')
    ).rejects.toMatchObject({ code: 'STATUS_MATRIX_FAILED' });

    // The old behaviour continued with dirty=[] and hard-reset anyway.
    expect(provider.writeRef.mock.calls).toHaveLength(0);
    expect(provider.checkout.mock.calls).toHaveLength(0);
  });
});

// ─── 3. Cancel + recovery from backup ────────────────────────────────────────

describe.skipIf(!httpBackendAvailable)('Task 5: cancel keeps backups; recovery = writeRef(backup) + checkout', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  it('recoverFromBackup restores working tree to backup content and keeps the backup branch', async () => {
    const pair = await createRepoPair({ files: { 'doc.md': 'v1\n' }, branch: 'preview' });
    try {
      const safety = makeSafety();
      const dir = pair.local.dir;

      // Dirty working tree the user must not lose.
      makeDirty(pair.local, { 'doc.md': 'PRECIOUS-UNCOMMITTED-EDIT\n' });

      // Backup the dirty state (snapshot commit on the backup branch).
      const backupBranch = await safety._createBackup({
        gitMod: git,
        fs,
        projectPath: dir,
        currentBranch: 'preview',
        localHead: await pair.local.head(),
        dirty: await pair.local.statusMatrix(),
      });
      expect(backupBranch).toMatch(/^backup\//);

      // Simulate a cancelled/interrupted merge leaving the tree elsewhere:
      // a destructive checkout to the base commit (what cancel used to do).
      await commitFile(pair.local, 'doc.md', 'OVERWRITTEN-BY-BROKEN-MERGE\n', 'broken merge state');
      await git.checkout({ fs, dir, ref: 'preview', force: true });
      expect(await pair.local.readFile('doc.md')).toBe('OVERWRITTEN-BY-BROKEN-MERGE\n');

      // RECOVERY (documented in git:cancel-operation JSDoc):
      // writeRef of the backup branch + checkout — backup NOT deleted.
      const result = await safety.recoverFromBackup(git, fs, dir, backupBranch, 'preview');
      expect(result).toMatchObject({ restoredFrom: backupBranch, backupRetained: true });

      expect(await pair.local.readFile('doc.md')).toBe('PRECIOUS-UNCOMMITTED-EDIT\n');

      const branches = await git.listBranches({ fs, dir });
      expect(branches).toContain(backupBranch);
    } finally {
      pair.dispose();
    }
  });
});
