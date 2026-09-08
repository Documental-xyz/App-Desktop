/**
 * @fileoverview Tests for GitHandlers pull/push/listRemoteBranches
 * Tests auth integration, lock mechanism, progress patterns, and edge cases.
 *
 * Backend seam (publish-update-resilience T16): mockDugiteProvider — a
 * real DugiteProvider with every method spied (fixtures/
 * mockDugiteProvider.js). Auth assertions read the PROVIDER contract
 * (`auth: { token }` in the options object) — the old iso onAuth
 * ({username, password}) mapping died with the provider in T15.
 * @author Documental Team
 * @since 1.0.0
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock('fs', () => ({
  default: {},
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock('../../src/ipc/gitOperations.js', () => ({
  GitOperations: vi.fn().mockImplementation(() => ({
    getGitHubToken: vi.fn(),
    configureGitForUser: vi.fn(),
    getCachedUserInfo: vi.fn(),
  })),
}));

import { GitHandlers } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { mockDugiteProvider } from '../git/fixtures/mockDugiteProvider.js';

describe('GitHandlers pull/push/listRemoteBranches', () => {
  let handlers;
  let mockLogger;
  let mockDatabaseManager;
  let git; // mockDugiteProvider handle (every method is a spy)

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mockDatabaseManager = { getDatabase: vi.fn() };

    git = mockDugiteProvider();

    handlers = new GitHandlers({
      logger: mockLogger,
      databaseManager: mockDatabaseManager,
      gitService: new GitService({ provider: git }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Lock mechanism', () => {
    it('acquireGitLock() returns false when operation already in progress', () => {
      handlers.gitOperationInProgress = true;
      const result = handlers.acquireGitLock();
      expect(result).toBe(false);
    });

    it('lock is released after successful pull', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('test-token');
      git.currentBranch.mockResolvedValue('main');
      git.fetch.mockResolvedValue({});
      git.fastForward.mockResolvedValue(true);
      await handlers.gitPullFromPreview('/test/path').catch(() => {});
      expect(handlers.gitOperationInProgress).toBe(false);
    });

    it('lock is released even when pull throws error', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('test-token');
      git.currentBranch.mockResolvedValue('main');
      git.fetch.mockRejectedValue(new Error('network error'));
      await handlers.gitPullFromPreview('/test/path').catch(() => {});
      expect(handlers.gitOperationInProgress).toBe(false);
    });
  });

  describe('gitPullFromPreview', () => {
    it('calls getGitHubToken() to obtain auth token', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue(null);
      await handlers.gitPullFromPreview('/test/path').catch(() => {});
      expect(handlers.gitOps.getGitHubToken).toHaveBeenCalled();
    });

    it('returns error when no token available', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue(null);
      const result = await handlers.gitPullFromPreview('/test/path');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('passes auth to git.pull() in the provider contract shape (auth.token)', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_test_token');
      git.currentBranch.mockResolvedValue('main');
      git.fetch.mockResolvedValue({});
      git.pull.mockResolvedValue({});
      // F3-D1: canFastForward is REAL now — false ancestry routes to
      // git.pull (true would shortcut to fastForward and never call pull).
      git.canFastForward.mockResolvedValue(false);
      await handlers.gitPullFromPreview('/test/path');
      const pullCall = git.pull.mock.calls[0]?.[1];
      // IPC passes auth:{token} straight through to the provider contract.
      expect(pullCall?.auth).toEqual({ token: 'ghp_test_token' });
      expect(pullCall?.ref).toBe('main');
    });

    it('returns error when HEAD is detached (currentBranch returns null)', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_test_token');
      git.currentBranch.mockResolvedValue(null);
      const result = await handlers.gitPullFromPreview('/test/path');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('gitPushToBranch', () => {
    beforeEach(async () => {
      git.currentBranch.mockResolvedValue('main');
      git.statusMatrix.mockResolvedValue([]); // clean
      git.resolveRef.mockResolvedValue('same-sha');
      git.fetch.mockResolvedValue({});
      git.checkout.mockResolvedValue(undefined);
      git.push.mockResolvedValue({});
      git.commit.mockResolvedValue('sha');
      git.branch.mockResolvedValue(undefined);
      git.merge.mockResolvedValue(undefined);
      git.getConfig.mockResolvedValue('Test User');
    });

    it('calls getGitHubToken() to obtain auth token', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue(null);
      await handlers.gitPushToBranch('/test/path', 'main').catch(() => {});
      expect(handlers.gitOps.getGitHubToken).toHaveBeenCalled();
    });

    it('calls configureGitForUser() before pushing', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_test_token');
      vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
      git.push.mockResolvedValue({});
      await handlers.gitPushToBranch('/test/path', 'main');
      expect(handlers.gitOps.configureGitForUser).toHaveBeenCalledWith('/test/path');
    });

    it('includes remote: origin in git.push() call', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_test_token');
      vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
      git.push.mockResolvedValue({});
      await handlers.gitPushToBranch('/test/path', 'main');
      const pushCall = git.push.mock.calls[0]?.[1];
      expect(pushCall?.remote).toBe('origin');
    });

    it('returns error when no token available', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue(null);
      const result = await handlers.gitPushToBranch('/test/path', 'main');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('gitListRemoteBranches', () => {
    it('calls getGitHubToken() to obtain auth token', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue(null);
      git.listServerRefs.mockResolvedValue([]);
      await handlers.gitListRemoteBranches('/test/path').catch(() => {});
      expect(handlers.gitOps.getGitHubToken).toHaveBeenCalled();
    });

    it('passes auth to git.listServerRefs() when token exists', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_test_token');
      git.listServerRefs.mockResolvedValue([]);
      git.getConfig.mockResolvedValue('https://github.com/user/repo.git');
      await handlers.gitListRemoteBranches('/test/path').catch(() => {});
      const refCall = git.listServerRefs.mock.calls[0];
      expect(refCall?.[1]?.auth).toEqual({ token: 'ghp_test_token' });
    });
  });

  describe('Error handling', () => {
    it('pull handles network error gracefully (returns error instead of throwing)', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_test_token');
      git.currentBranch.mockResolvedValue('main');
      git.fetch.mockRejectedValue(new Error('ECONNREFUSED network error'));
      const result = await handlers.gitPullFromPreview('/test/path');
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('push handles non-fast-forward error gracefully', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_test_token');
      vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
      git.currentBranch.mockResolvedValue('main');
      git.statusMatrix.mockResolvedValue([]);
      git.resolveRef.mockResolvedValue('same-sha');
      git.fetch.mockResolvedValue({});
      git.push.mockRejectedValue(new Error('non-fast-forward'));
      const result = await handlers.gitPushToBranch('/test/path', 'main');
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    it('pull categorizes 401 authentication errors', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_test_token');
      git.currentBranch.mockResolvedValue('main');
      git.fetch.mockRejectedValue(new Error('HTTP Error: 401 Unauthorized'));
      const result = await handlers.gitPullFromPreview('/test/path');
      expect(result.success).toBe(false);
      expect(result.error).toContain('autenticação');
    });
  });

  describe('Edge cases', () => {
    it('aborts the operation signal after LOCK_TIMEOUT_MS timeout', () => {
      vi.useFakeTimers();
      handlers.acquireGitLock();
      expect(handlers.gitOperationInProgress).toBe(true);
      const signal = handlers.getAbortSignal();
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(handlers.LOCK_TIMEOUT_MS + 1);
      expect(signal.aborted).toBe(true);
      handlers.releaseGitLock();
      expect(handlers.gitOperationInProgress).toBe(false);
      vi.useRealTimers();
    });

    it('concurrent pull returns lock error when operation already in progress', async () => {
      handlers.acquireGitLock();
      const result = await handlers.gitPullFromPreview('/test/path');
      expect(result.success).toBe(false);
      expect(result.error).toContain('already in progress');
      handlers.releaseGitLock();
    });

    it('concurrent push returns lock error when operation already in progress', async () => {
      handlers.acquireGitLock();
      const result = await handlers.gitPushToBranch('/test/path', 'main');
      expect(result.success).toBe(false);
      expect(result.error).toContain('already in progress');
      handlers.releaseGitLock();
    });

    it('push continues when configureGitForUser returns false (best-effort)', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_test_token');
      vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(false);
      git.currentBranch.mockResolvedValue('main');
      git.statusMatrix.mockResolvedValue([]);
      git.resolveRef.mockResolvedValue('same-sha');
      git.fetch.mockResolvedValue({});
      git.push.mockResolvedValue({});
      const result = await handlers.gitPushToBranch('/test/path', 'main');
      expect(result.success).toBe(true);
      expect(git.push).toHaveBeenCalled();
    });

    it('listRemoteBranches works without auth token (public repos)', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue(null);
      git.getConfig.mockResolvedValue('https://github.com/user/repo.git');
      git.listServerRefs.mockResolvedValue([
        { ref: 'refs/heads/main' },
        { ref: 'refs/heads/develop' },
      ]);
      const result = await handlers.gitListRemoteBranches('/test/path');
      expect(result).toEqual({ success: true, branches: ['main', 'develop'], defaultBranch: 'main' });
      const refCall = git.listServerRefs.mock.calls[0];
      expect(refCall[1].auth).toBeUndefined();
    });

    it('releaseGitLock clears the timeout timer', () => {
      vi.useFakeTimers();
      handlers.acquireGitLock();
      expect(handlers._lockTimeout).not.toBeNull();
      handlers.releaseGitLock();
      expect(handlers._lockTimeout).toBeNull();
      expect(handlers.gitOperationInProgress).toBe(false);
      vi.useRealTimers();
    });
  });
});
