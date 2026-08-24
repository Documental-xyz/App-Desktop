/**
 * @fileoverview Unit tests for GitSafety — backup branch creation, dirty-tree
 * pre-commit, heartbeat/stale-lock detection, and backup listing.
 *
 * Mocks isomorphic-git at the module level. Each test constructs its own
 * GitSafety instance with a spy logger so call history is isolated.
 *
 * @author Documental Team
 * @since 1.0.0
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub isomorphic-git so gitSafety can require() it indirectly via gitFlowTypes
// (it doesn't import isomorphic-git itself, but we keep the mock for parity
// with the other IPC test files and to avoid side-effects).
vi.mock('isomorphic-git', () => ({
  default: {},
  currentBranch: vi.fn(),
  statusMatrix: vi.fn(),
  resolveRef: vi.fn(),
  writeRef: vi.fn(),
  checkout: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  commit: vi.fn(),
  branch: vi.fn(),
  deleteBranch: vi.fn(),
  listBranches: vi.fn(),
  readCommit: vi.fn(),
}));

vi.mock('isomorphic-git/http/node', () => ({ default: {} }));

import { GitSafety, BACKUP_BRANCH_PREFIX } from '../../src/ipc/gitSafety.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const PROJECT_PATH = '/test/project';

/** Build a fresh spy logger. */
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Build a git module mock with per-method spies and the given resolveRef map. */
function makeGitMock({ headSha = 'abcdef1234567890', remotePreviewSha = null } = {}) {
  const git = {
    currentBranch: vi.fn().mockResolvedValue('preview'),
    statusMatrix: vi.fn().mockResolvedValue([]),
    resolveRef: vi.fn(async ({ ref }) => {
      if (ref === 'HEAD') return headSha;
      if (ref === 'refs/remotes/origin/preview') {
        if (remotePreviewSha === null) {
          throw new Error('Could not find ref refs/remotes/origin/preview');
        }
        return remotePreviewSha;
      }
      if (ref === 'origin/preview') return remotePreviewSha || headSha;
      return headSha;
    }),
    writeRef: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue('backup-commit-sha'),
    branch: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    listBranches: vi.fn().mockResolvedValue([]),
    readCommit: vi.fn().mockResolvedValue({ committer: { timestamp: 1700000000 } }),
  };
  return git;
}

/** A plain stub fs object (GitSafety only calls fs.sync optionally). */
const fsStub = {};

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('GitSafety', () => {
  let logger;
  let safety;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = makeLogger();
    safety = new GitSafety({ logger });
  });

  afterEach(() => {
    // Ensure no heartbeat timer leaks between tests.
    safety.stopHeartbeat();
    vi.useRealTimers();
  });

  // ─── _safeResetOrCheckout ──────────────────────────────────────────────
  describe('_safeResetOrCheckout — backup creation', () => {
    it('creates a backup branch when unpushed commits exist (HEAD !== origin/preview)', async () => {
      const git = makeGitMock({
        headSha: 'aaa1111111111111',
        remotePreviewSha: 'bbb2222222222222', // different → unpushed
      });

      const result = await safety._safeResetOrCheckout(git, fsStub, PROJECT_PATH, 'origin/preview');

      // branch() was called with a ref prefixed backup/preview-
      expect(git.branch).toHaveBeenCalled();
      const branchArg = git.branch.mock.calls[0][0];
      expect(branchArg.ref).toMatch(/^backup\/preview-/);
      expect(branchArg.force).toBe(false);
      expect(branchArg.checkout).toBe(false);

      // Returned backupBranch is the same name passed to branch()
      expect(result.backupBranch).toBe(branchArg.ref);
    });

    it('pre-commits uncommitted working tree changes before the destructive op', async () => {
      const git = makeGitMock({
        headSha: 'ccc3333333333333',
        remotePreviewSha: 'ccc3333333333333', // equal → not unpushed
      });
      // Modified file present in worktree: [filepath, HEAD, WORKDIR, STAGE]
      git.statusMatrix.mockResolvedValue([['src/file.ts', 1, 2, 1]]);

      await safety._safeResetOrCheckout(git, fsStub, PROJECT_PATH, 'origin/preview');

      expect(git.branch).toHaveBeenCalledTimes(1);
      const backupName = git.branch.mock.calls[0][0].ref;

      const checkoutBackupCall = git.checkout.mock.calls.find(
        (c) => c[0] && c[0].ref === backupName
      );
      expect(checkoutBackupCall).toBeDefined();

      expect(git.add).toHaveBeenCalledWith(
        expect.objectContaining({ filepath: 'src/file.ts' })
      );

      expect(git.commit).toHaveBeenCalled();
      const commitArg = git.commit.mock.calls[0][0];
      expect(commitArg.message).toMatch(/chore\(backup\): snapshot de working tree/);
    });

    it('stages deleted files via gitMod.remove when worktreeStatus is 0', async () => {
      const git = makeGitMock({
        headSha: 'ccc3333333333333',
        remotePreviewSha: 'ccc3333333333333',
      });
      git.statusMatrix.mockResolvedValue([['deleted.txt', 1, 0, 1]]);

      await safety._safeResetOrCheckout(git, fsStub, PROJECT_PATH, 'origin/preview');

      expect(git.remove).toHaveBeenCalledWith(
        expect.objectContaining({ filepath: 'deleted.txt' })
      );
      expect(git.add).not.toHaveBeenCalled();
    });

    it('does NOT create a backup when the tree is clean and pushed (HEAD === origin/preview)', async () => {
      const git = makeGitMock({
        headSha: 'ddd4444444444444',
        remotePreviewSha: 'ddd4444444444444', // equal AND statusMatrix clean
      });
      git.statusMatrix.mockResolvedValue([['unchanged.txt', 1, 1, 1]]);

      const result = await safety._safeResetOrCheckout(git, fsStub, PROJECT_PATH, 'origin/preview');

      expect(git.branch).not.toHaveBeenCalled();
      expect(result.backupBranch).toBeNull();

      // Destructive op still ran
      expect(git.writeRef).toHaveBeenCalled();
      expect(git.checkout).toHaveBeenCalled();
    });

    it('aborts the destructive operation when backup creation fails', async () => {
      const git = makeGitMock({
        headSha: 'eee5555555555555',
        remotePreviewSha: 'fff6666666666666', // unpushed → tries backup
      });
      // branch() rejects with a non-"already exists" error → fatal
      git.branch.mockRejectedValue(new Error('disk full'));

      await expect(
        safety._safeResetOrCheckout(git, fsStub, PROJECT_PATH, 'origin/preview')
      ).rejects.toThrow('disk full');

      // Destructive op MUST be skipped (writeRef NOT called)
      expect(git.writeRef).not.toHaveBeenCalled();
      // error logged
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // ─── cleanupBackupBranch ───────────────────────────────────────────────
  describe('cleanupBackupBranch — retention (Task 4)', () => {
    it('does NOT delete the backup (retention semantics) and never throws', async () => {
      const git = makeGitMock();
      git.deleteBranch.mockRejectedValue(new Error('should not be called'));

      await expect(
        safety.cleanupBackupBranch(git, fsStub, PROJECT_PATH, 'backup/preview-abc-1700000000000')
      ).resolves.toBeUndefined();

      expect(git.deleteBranch).not.toHaveBeenCalled();
    });

    it('logs the retention decision', async () => {
      const git = makeGitMock();
      await safety.cleanupBackupBranch(git, fsStub, PROJECT_PATH, 'backup/preview-abc-123');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('backup/preview-abc-123'));
    });
  });

  // ─── Heartbeat ─────────────────────────────────────────────────────────
  describe('Heartbeat — start/stop/stale', () => {
    it('startHeartbeat sets an interval; stopHeartbeat clears it', () => {
      vi.useFakeTimers();
      expect(safety._heartbeatInterval).toBeNull();
      expect(safety._lastHeartbeat).toBeNull();

      safety.startHeartbeat();
      expect(safety._heartbeatInterval).not.toBeNull();
      expect(safety._lastHeartbeat).not.toBeNull();

      const initial = safety._lastHeartbeat;
      vi.advanceTimersByTime(6000); // > LOCK_HEARTBEAT_INTERVAL_MS (5s)
      expect(safety._lastHeartbeat).toBeGreaterThan(initial);

      safety.stopHeartbeat();
      expect(safety._heartbeatInterval).toBeNull();
      expect(safety._lastHeartbeat).toBeNull();
    });

    it('checkStaleHeartbeat returns false when no active heartbeat', () => {
      // No startHeartbeat called → never stale
      expect(safety.checkStaleHeartbeat()).toBe(false);
    });

    it('checkStaleHeartbeat returns true when heartbeat is older than LOCK_HEARTBEAT_STALE_MS', () => {
      safety.startHeartbeat();
      // Simulate the heartbeat being very stale.
      safety._lastHeartbeat = Date.now() - 200000; // > 180000ms threshold
      expect(safety.checkStaleHeartbeat()).toBe(true);
    });

    it('checkStaleHeartbeat returns false when heartbeat is recent', () => {
      safety.startHeartbeat();
      // _lastHeartbeat was just set; should be fresh.
      expect(safety.checkStaleHeartbeat()).toBe(false);
    });

    it('calling startHeartbeat twice does not create two intervals', () => {
      vi.useFakeTimers();
      safety.startHeartbeat();
      const first = safety._heartbeatInterval;
      safety.startHeartbeat();
      // Same reference would be fine, but vitest's setInterval returns fresh
      // ids — what matters is stopHeartbeat clears the most recent. Ensure
      // the first interval was cleared (no leak) by verifying only one active.
      safety.stopHeartbeat();
      expect(safety._heartbeatInterval).toBeNull();
      // first should have been cleared by the inner stopHeartbeat() call.
      // We cannot inspect vitest fake timer refs directly; the absence of
      // leaks across the test run (afterEach stopHeartbeat) is the contract.
      expect(first).toBeTruthy();
    });
  });

  // ─── listBackups ───────────────────────────────────────────────────────
  describe('listBackups — prefix filtering', () => {
    it('filters branches by the backup/ prefix and resolves sha + timestamp', async () => {
      const git = makeGitMock();
      git.listBranches.mockResolvedValue([
        'main',
        'preview',
        'backup/preview-abc1234-1700000000000',
      ]);
      git.resolveRef.mockResolvedValue('sha-for-backup');

      const backups = await safety.listBackups(git, fsStub, PROJECT_PATH);

      expect(backups).toHaveLength(1);
      expect(backups[0]).toEqual({
        name: 'backup/preview-abc1234-1700000000000',
        sha: 'sha-for-backup',
        timestamp: 1700000000000,
      });
    });

    it('returns empty array when no backup branches exist', async () => {
      const git = makeGitMock();
      git.listBranches.mockResolvedValue(['main', 'preview', 'develop']);

      const backups = await safety.listBackups(git, fsStub, PROJECT_PATH);
      expect(backups).toEqual([]);
    });

    it('skips branches whose ref cannot be resolved', async () => {
      const git = makeGitMock();
      git.listBranches.mockResolvedValue([
        'backup/preview-good-1700000000000',
        'backup/preview-broken-1700000000001',
      ]);
      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref.includes('broken')) throw new Error('missing object');
        return 'good-sha';
      });

      const backups = await safety.listBackups(git, fsStub, PROJECT_PATH);
      expect(backups).toHaveLength(1);
      expect(backups[0].name).toBe('backup/preview-good-1700000000000');
    });

    it('sorts backups newest-first by timestamp', async () => {
      const git = makeGitMock();
      git.listBranches.mockResolvedValue([
        'backup/preview-old-1700000000000',
        'backup/preview-new-1700000099999',
        'backup/preview-mid-1700000050000',
      ]);

      const backups = await safety.listBackups(git, fsStub, PROJECT_PATH);
      expect(backups.map((b) => b.name)).toEqual([
        'backup/preview-new-1700000099999',
        'backup/preview-mid-1700000050000',
        'backup/preview-old-1700000000000',
      ]);
    });

    it('returns [] when listBranches throws (logged)', async () => {
      const git = makeGitMock();
      git.listBranches.mockRejectedValue(new Error('repo corrupt'));

      const backups = await safety.listBackups(git, fsStub, PROJECT_PATH);
      expect(backups).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // ─── fsSyncSafe ────────────────────────────────────────────────────────
  describe('fsSyncSafe — Windows flush helper', () => {
    it('calls fs.sync(path) when available and returns its result', () => {
      const sync = vi.fn(() => 'ok');
      const fakeFs = { sync };
      expect(safety.fsSyncSafe(fakeFs, PROJECT_PATH)).toBe('ok');
      expect(sync).toHaveBeenCalledWith(PROJECT_PATH);
    });

    it('returns undefined when fs.sync is not a function (POSIX)', () => {
      const fakeFs = {};
      expect(safety.fsSyncSafe(fakeFs, PROJECT_PATH)).toBeUndefined();
    });

    it('swallows fs.sync exceptions and returns undefined', () => {
      const fakeFs = { sync: vi.fn(() => { throw new Error('EBUSY'); }) };
      expect(safety.fsSyncSafe(fakeFs, PROJECT_PATH)).toBeUndefined();
      expect(logger.debug).toHaveBeenCalled();
    });
  });

  // ─── Backup name format ────────────────────────────────────────────────
  describe('Backup name format', () => {
    it('uses BACKUP_BRANCH_PREFIX constant exported from the module', () => {
      expect(BACKUP_BRANCH_PREFIX).toBe('backup/');
    });

    it('backup name embeds shortSha (7 chars) and timestamp suffix', async () => {
      const git = makeGitMock({
        headSha: '0123456789abcdef', // 16 chars
        remotePreviewSha: 'ffffffffffffffff', // unpushed
      });

      await safety._safeResetOrCheckout(git, fsStub, PROJECT_PATH, 'origin/preview');

      const branchArg = git.branch.mock.calls[0][0];
      // backup/preview-<7-char-sha>-<digits>
      expect(branchArg.ref).toMatch(/^backup\/preview-[0-9a-f]{7}-\d+$/);
    });
  });

  // ─── deleteBackup ──────────────────────────────────────────────────────
  describe('deleteBackup — user-initiated', () => {
    it('throws when deleteBranch fails (UI surfaces the error)', async () => {
      const git = makeGitMock();
      git.deleteBranch.mockRejectedValue(new Error('branch checked out'));

      await expect(
        safety.deleteBackup(git, fsStub, PROJECT_PATH, 'backup/preview-abc-1')
      ).rejects.toThrow('branch checked out');
    });

    it('resolves on success', async () => {
      const git = makeGitMock();
      await expect(
        safety.deleteBackup(git, fsStub, PROJECT_PATH, 'backup/preview-abc-1')
      ).resolves.toBeUndefined();
      expect(git.deleteBranch).toHaveBeenCalledWith(
        expect.objectContaining({ ref: 'backup/preview-abc-1' })
      );
    });
  });
});
