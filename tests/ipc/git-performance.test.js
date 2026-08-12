/**
 * @fileoverview Tests for Git performance optimizations
 * Validates cache sharing, debounced output, parallel operations, async fs, and clone options.
 * @author Documental Team
 * @since 1.0.0
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('isomorphic-git', () => ({
  default: {},
  pull: vi.fn(),
  push: vi.fn(),
  currentBranch: vi.fn(),
  fetch: vi.fn(),
  checkout: vi.fn(),
  getConfig: vi.fn(),
  listServerRefs: vi.fn(),
  statusMatrix: vi.fn(),
  listBranches: vi.fn(),
  resolveRef: vi.fn(),
  readCommit: vi.fn(),
  branch: vi.fn(),
  add: vi.fn(),
  commit: vi.fn(),
}));

vi.mock('isomorphic-git/http/node', () => ({ default: {} }));

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
    access: vi.fn(),
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

describe('Git performance optimizations', () => {
  let handlers;
  let mockLogger;
  let mockDatabaseManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    mockDatabaseManager = { getDatabase: vi.fn() };
    handlers = new GitHandlers({ logger: mockLogger, databaseManager: mockDatabaseManager });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ─── Category 1: Cache sharing ───────────────────────────────────────
  describe('Cache sharing', () => {
    it('passes _gitCache object reference to statusMatrix via _getGit()', async () => {
      const git = await import('isomorphic-git');
      git.statusMatrix.mockResolvedValue([]);

      const cacheRef = handlers._gitCache;
      await handlers.gitCheckStatus('/test/path');

      expect(git.statusMatrix.mock.calls[0][0].cache).toBe(cacheRef);
    });

    it('passes _gitCache to currentBranch in gitPullFromPreview', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue(null);
      const git = await import('isomorphic-git');
      git.currentBranch.mockResolvedValue('main');

      const cacheRef = handlers._gitCache;
      await handlers.gitPullFromPreview('/test/path');

      expect(git.currentBranch.mock.calls[0][0].cache).toBe(cacheRef);
    });
  });

  // ─── Category 2: Cache invalidation ─────────────────────────────────
  describe('Cache invalidation', () => {
    it('resets _gitCache to new empty object after gitCreateBranch', async () => {
      const git = await import('isomorphic-git');
      git.branch.mockResolvedValue(undefined);

      const cacheBefore = handlers._gitCache;
      handlers._gitCache.someKey = 'cached-value';

      await handlers.gitCreateBranch('/test/path', 'new-branch');

      expect(handlers._gitCache).toEqual({});
      expect(handlers._gitCache).not.toBe(cacheBefore);
    });

    it('resets _gitCache after push operation', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('test-token');
      vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
      const git = await import('isomorphic-git');
      git.push.mockResolvedValue({});

      handlers._gitCache.data = 'stale';
      const cacheBefore = handlers._gitCache;

      await handlers.gitPushToBranch('/test/path', 'main');

      expect(handlers._gitCache).toEqual({});
      expect(handlers._gitCache).not.toBe(cacheBefore);
    });
  });

  // ─── Category 3: Debounce batching ──────────────────────────────────
  describe('Debounce batching', () => {
    it('batches multiple sendOutput calls into a single broadcast', () => {
      vi.useFakeTimers();
      const broadcastSpy = vi.spyOn(handlers, 'broadcastToWindows');

      handlers.sendOutput('msg1');
      handlers.sendOutput('msg2');
      handlers.sendOutput('msg3');

      // Nothing broadcast yet — still within 100ms debounce window
      expect(broadcastSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(150);

      // All messages delivered as single batched broadcast
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy).toHaveBeenCalledWith('command-output', {
        message: 'msg1\nmsg2\nmsg3',
      });
    });
  });

  // ─── Category 4: Debounce flush on releaseGitLock ───────────────────
  describe('Debounce flush on releaseGitLock', () => {
    it('flushes pending buffered messages before releasing lock', () => {
      vi.useFakeTimers();
      const broadcastSpy = vi.spyOn(handlers, 'broadcastToWindows');

      handlers.sendOutput('pending message');
      expect(broadcastSpy).not.toHaveBeenCalled();

      handlers.releaseGitLock();

      // Message flushed immediately by releaseGitLock
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy).toHaveBeenCalledWith('command-output', {
        message: 'pending message',
      });
      expect(handlers.gitOperationInProgress).toBe(false);
    });
  });

  // ─── Category 5: Error bypass (immediate delivery) ──────────────────
  describe('Error bypass (immediate delivery)', () => {
    it('delivers ❌ messages immediately without buffering', () => {
      vi.useFakeTimers();
      const broadcastSpy = vi.spyOn(handlers, 'broadcastToWindows');

      handlers.sendOutput('❌ Something failed');

      // Delivered immediately — no timer advance needed
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy).toHaveBeenCalledWith('command-output', {
        message: '❌ Something failed',
      });
      expect(handlers._sendOutputBuffer.length).toBe(0);
    });
  });

  // ─── Category 6: Async fs in gitListBranches ────────────────────────
  describe('Async fs in gitListBranches', () => {
    it('uses fs.promises.access instead of existsSync (verified via source)', async () => {
      const realFs = await vi.importActual('fs');
      const source = realFs.readFileSync('src/ipc/git.js', 'utf8');
      const gitListBranchesStart = source.indexOf('async gitListBranches(');
      const gitListBranchesEnd = source.indexOf('\n  async ', gitListBranchesStart + 1);
      const methodSource = source.slice(gitListBranchesStart, gitListBranchesEnd);
      expect(methodSource).not.toContain('existsSync');
      expect(methodSource).not.toContain('readFileSync');
      expect(methodSource).not.toContain('readdirSync');
      expect(methodSource).toContain('fs.promises.access');
    });

    it('uses fs.promises.readdir in filesystem fallback path (verified via source)', async () => {
      const realFs = await vi.importActual('fs');
      const source = realFs.readFileSync('src/ipc/git.js', 'utf8');
      const gitListBranchesStart = source.indexOf('async gitListBranches(');
      const gitListBranchesEnd = source.indexOf('\n  async ', gitListBranchesStart + 1);
      const methodSource = source.slice(gitListBranchesStart, gitListBranchesEnd);
      expect(methodSource).toContain('fs.promises.readdir');
    });
  });

  // ─── Category 7: Clone options ──────────────────────────────────────
  describe('Clone options', () => {
    it('projectCreation.js configures singleBranch: true and depth: 10', async () => {
      const realFs = await vi.importActual('fs');
      const source = realFs.readFileSync('src/ipc/projectCreation.js', 'utf8');
      expect(source).toContain('singleBranch: true');
      expect(source).toContain('depth: 10');
    });

    it('projects.js configures singleBranch: true and depth: 10', async () => {
      const realFs = await vi.importActual('fs');
      const source = realFs.readFileSync('src/ipc/projects.js', 'utf8');
      expect(source).toContain('singleBranch: true');
      expect(source).toContain('depth: 10');
    });
  });

  // ─── Category 8: Parallelization ───────────────────────────────────
  describe('Parallelization', () => {
    it('gitPullFromPreview starts token fetch and branch detection in parallel', async () => {
      // With Promise.all, both calls start before either resolves.
      // If sequential and token=null, currentBranch would never be called
      // because the early return fires. Both being called proves parallelism.
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue(null);
      const git = await import('isomorphic-git');
      git.currentBranch.mockResolvedValue('main');

      await handlers.gitPullFromPreview('/test/path');

      expect(handlers.gitOps.getGitHubToken).toHaveBeenCalledTimes(1);
      expect(git.currentBranch).toHaveBeenCalledTimes(1);
    });

    it('gitPushToBranch starts token fetch and configureGitForUser in parallel', async () => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue(null);
      vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);

      await handlers.gitPushToBranch('/test/path', 'main');

      expect(handlers.gitOps.getGitHubToken).toHaveBeenCalledTimes(1);
      expect(handlers.gitOps.configureGitForUser).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Category 9: Single gitListBranches in checkout ─────────────────
  describe('Single gitListBranches in checkout', () => {
    it('gitCheckoutBranch source uses branchListPromise pattern (single call)', async () => {
      const realFs = await vi.importActual('fs');
      const source = realFs.readFileSync('src/ipc/git.js', 'utf8');
      const checkoutStart = source.indexOf('async gitCheckoutBranch(');
      const checkoutEnd = source.indexOf('\n  async ', checkoutStart + 1);
      const methodSource = source.slice(checkoutStart, checkoutEnd);
      expect(methodSource).toContain('branchListPromise');
      const callCount = (methodSource.match(/this\.gitListBranches\(/g) || []).length;
      expect(callCount).toBe(1);
    });

    it('reuses branchListPromise via await (not a second call)', async () => {
      const realFs = await vi.importActual('fs');
      const source = realFs.readFileSync('src/ipc/git.js', 'utf8');
      const checkoutStart = source.indexOf('async gitCheckoutBranch(');
      const checkoutEnd = source.indexOf('\n  async ', checkoutStart + 1);
      const methodSource = source.slice(checkoutStart, checkoutEnd);

      expect(methodSource).toContain('const branchListPromise = this.gitListBranches(projectPath)');
      expect(methodSource).toContain('await branchListPromise');
    });
  });

  // ─── Category 10: Per-step timeout (_raceTimeout) ────────────────────
  describe('Per-step timeout (_raceTimeout)', () => {
    it('emits a warning when the awaited operation exceeds the threshold', async () => {
      vi.useFakeTimers();

      let resolveOp;
      const pending = new Promise((resolve) => { resolveOp = resolve; });
      const promise = handlers._raceTimeout(pending, 5000, 'fetch origin/preview');

      vi.advanceTimersByTime(4000);
      expect(mockLogger.warn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('fetch origin/preview')
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('5000ms')
      );

      resolveOp('value');
      const value = await promise;
      expect(value).toBe('value');

      vi.useRealTimers();
    });

    it('clears the warning timer when the operation completes under threshold', async () => {
      vi.useFakeTimers();

      const promise = handlers._raceTimeout(
        Promise.resolve('fast-value'),
        5000,
        'checkout preview'
      );

      const value = await promise;
      expect(value).toBe('fast-value');

      vi.advanceTimersByTime(20000);
      expect(mockLogger.warn).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('still resolves (and clears timer) when the operation rejects', async () => {
      vi.useFakeTimers();

      const promise = handlers._raceTimeout(
        Promise.reject(new Error('network down')),
        5000,
        'fetch origin/preview'
      );

      await expect(promise).rejects.toThrow('network down');

      vi.advanceTimersByTime(20000);
      expect(mockLogger.warn).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  // ─── Category 11: Lock heartbeat integration ─────────────────────────
  describe('Lock heartbeat integration', () => {
    it('starts heartbeat on acquireGitLock and stops on releaseGitLock', () => {
      expect(handlers.gitSafety).not.toBeNull();

      handlers.acquireGitLock();
      expect(handlers.gitSafety._heartbeatInterval).not.toBeNull();
      expect(handlers.gitSafety._lastHeartbeat).not.toBeNull();

      handlers.releaseGitLock();
      expect(handlers.gitSafety._heartbeatInterval).toBeNull();
      expect(handlers.gitSafety._lastHeartbeat).toBeNull();
    });

    it('heartbeat is null when no operation is in progress', () => {
      expect(handlers.gitSafety._heartbeatInterval).toBeNull();
      expect(handlers.gitSafety._lastHeartbeat).toBeNull();
    });

    it('multiple acquire/release cycles keep heartbeat consistent', () => {
      handlers.acquireGitLock();
      expect(handlers.gitSafety._heartbeatInterval).not.toBeNull();
      handlers.releaseGitLock();
      expect(handlers.gitSafety._heartbeatInterval).toBeNull();

      handlers.acquireGitLock();
      expect(handlers.gitSafety._heartbeatInterval).not.toBeNull();
      handlers.releaseGitLock();
      expect(handlers.gitSafety._heartbeatInterval).toBeNull();
    });
  });

  // ─── Category 12: Stale-lock auto-recovery ───────────────────────────
  describe('Stale-lock auto-recovery', () => {
    it('force-recovers a stale lock on the next acquireGitLock() call', () => {
      handlers.gitOperationInProgress = true;
      handlers.gitSafety._lastHeartbeat = Date.now() - 200000;
      expect(handlers.gitSafety.checkStaleHeartbeat()).toBe(true);

      const result = handlers.acquireGitLock();

      expect(result).toBe(true);
      expect(handlers.gitOperationInProgress).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('auto-recuperado')
      );
      expect(handlers.gitSafety._lastHeartbeat).toBeGreaterThan(Date.now() - 5000);
    });

    it('does NOT auto-recover when heartbeat is recent (active operation)', () => {
      handlers.gitOperationInProgress = true;
      handlers.gitSafety.startHeartbeat();
      expect(handlers.gitSafety.checkStaleHeartbeat()).toBe(false);

      const result = handlers.acquireGitLock();

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('Git operation already in progress');
    });

    it('does NOT auto-recover when gitSafety is unavailable', () => {
      const savedSafety = handlers.gitSafety;
      handlers.gitSafety = null;
      handlers.gitOperationInProgress = true;

      const result = handlers.acquireGitLock();

      expect(result).toBe(false);

      handlers.gitSafety = savedSafety;
      handlers.gitOperationInProgress = false;
    });

    it('stale recovery clears the stale _abortController and _lockTimeout', () => {
      vi.useFakeTimers();

      handlers.gitOperationInProgress = true;
      handlers.gitSafety._lastHeartbeat = Date.now() - 200000;
      const oldController = new AbortController();
      handlers._abortController = oldController;
      handlers._lockTimeout = setTimeout(() => {}, 99999);

      handlers.acquireGitLock();

      expect(handlers._abortController).not.toBe(oldController);
      expect(handlers._abortController).not.toBeNull();

      handlers.releaseGitLock();
      vi.useRealTimers();
    });
  });
});
