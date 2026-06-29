import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockIpcMain = {
  handle: vi.fn(),
  removeHandler: vi.fn()
};

vi.mock('electron', () => ({
  ipcMain: mockIpcMain
}));

vi.mock('isomorphic-git', () => ({}));
vi.mock('isomorphic-git/http/node', () => ({}));

describe('GitHandlers - Cancellation', () => {
  let mockLogger;
  let mockDatabaseManager;
  let mockIpcMain;
  let gitHandlers;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };

    mockDatabaseManager = {
      getDatabase: vi.fn().mockResolvedValue({
        get: vi.fn((query, params, callback) => {
          callback(null, {
            id: 1,
            projectPath: '/base/path',
            repoFolderName: 'repo-name'
          });
        })
      })
    };

    mockIpcMain = {
      handle: vi.fn(),
      removeHandler: vi.fn()
    };

    const { GitHandlers } = await import('../../src/ipc/git.js');
    gitHandlers = new GitHandlers({
      logger: mockLogger,
      databaseManager: mockDatabaseManager
    });
  });

  describe('Cancellation Flag', () => {
    it('should initialize with cancelRequested = false', () => {
      expect(gitHandlers.cancelRequested).toBe(false);
    });

    it('should set cancelRequested to true when requestCancel is called', () => {
      gitHandlers.requestCancel();
      expect(gitHandlers.cancelRequested).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('Git operation cancellation requested');
    });

    it('should reset cancelRequested to false when resetCancel is called', () => {
      gitHandlers.requestCancel();
      expect(gitHandlers.cancelRequested).toBe(true);
      gitHandlers.resetCancel();
      expect(gitHandlers.cancelRequested).toBe(false);
    });

    it('should return correct value from isCancelRequested', () => {
      expect(gitHandlers.isCancelRequested()).toBe(false);
      gitHandlers.requestCancel();
      expect(gitHandlers.isCancelRequested()).toBe(true);
      gitHandlers.resetCancel();
      expect(gitHandlers.isCancelRequested()).toBe(false);
    });

    it('should reset cancel flag when acquireGitLock is called', () => {
      gitHandlers.requestCancel();
      gitHandlers.acquireGitLock();
      expect(gitHandlers.cancelRequested).toBe(false);
    });
  });

  describe('IPC Handler', () => {
    it('should have registerHandlers method', () => {
      expect(typeof gitHandlers.registerHandlers).toBe('function');
    });

    it('should have unregisterHandlers method', () => {
      expect(typeof gitHandlers.unregisterHandlers).toBe('function');
    });
  });

  describe('Operation Cancellation Flow', () => {
    it('should stop operations when cancel is requested between steps', () => {
      gitHandlers.acquireGitLock();
      expect(gitHandlers.isCancelRequested()).toBe(false);
      expect(gitHandlers.gitOperationInProgress).toBe(true);
      
      gitHandlers.requestCancel();
      expect(gitHandlers.isCancelRequested()).toBe(true);
      
      if (gitHandlers.isCancelRequested()) {
        gitHandlers.releaseGitLock();
        expect(gitHandlers.gitOperationInProgress).toBe(false);
      }
    });

    it('should reset cancel flag when new operation starts', () => {
      gitHandlers.requestCancel();
      gitHandlers.acquireGitLock();
      
      expect(gitHandlers.isCancelRequested()).toBe(false);
      expect(gitHandlers.gitOperationInProgress).toBe(true);
    });

    it('should maintain cancel state across multiple checks', () => {
      gitHandlers.requestCancel();
      
      expect(gitHandlers.isCancelRequested()).toBe(true);
      expect(gitHandlers.isCancelRequested()).toBe(true);
      expect(gitHandlers.isCancelRequested()).toBe(true);
      
      gitHandlers.resetCancel();
      expect(gitHandlers.isCancelRequested()).toBe(false);
    });
  });

  describe('Error Cases', () => {
    it('should handle rapid cancel requests gracefully', () => {
      gitHandlers.requestCancel();
      gitHandlers.requestCancel();
      gitHandlers.requestCancel();
      
      expect(gitHandlers.isCancelRequested()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledTimes(3);
    });

    it('should handle reset without prior cancel', () => {
      gitHandlers.resetCancel();
      
      expect(gitHandlers.isCancelRequested()).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith('Git operation cancellation flag reset');
    });

    it('should handle cancel when no operation is in progress', () => {
      gitHandlers.requestCancel();
      
      expect(gitHandlers.gitOperationInProgress).toBe(false);
      expect(gitHandlers.isCancelRequested()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('Git operation cancellation requested');
    });
  });

  describe('Unregister Handlers', () => {
    it('should have unregisterHandlers method', () => {
      expect(typeof gitHandlers.unregisterHandlers).toBe('function');
    });
  });

  describe('AbortController Integration', () => {
    it('should expose an AbortSignal via getAbortSignal after acquiring lock', () => {
      gitHandlers.acquireGitLock();
      const signal = gitHandlers.getAbortSignal();
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      gitHandlers.releaseGitLock();
    });

    it('should return null from getAbortSignal when no operation is in progress', () => {
      expect(gitHandlers.getAbortSignal()).toBeNull();
    });

    it('should abort the signal when LOCK_TIMEOUT_MS elapses', () => {
      vi.useFakeTimers();
      gitHandlers.acquireGitLock();
      const signal = gitHandlers.getAbortSignal();
      expect(signal.aborted).toBe(false);

      vi.advanceTimersByTime(gitHandlers.LOCK_TIMEOUT_MS);

      expect(signal.aborted).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Git operation auto-aborted after timeout'
      );
      gitHandlers.releaseGitLock();
      vi.useRealTimers();
    });

    it('should clear the AbortController on releaseGitLock without aborting', () => {
      gitHandlers.acquireGitLock();
      const signal = gitHandlers.getAbortSignal();
      gitHandlers.releaseGitLock();
      expect(signal.aborted).toBe(false);
      expect(gitHandlers.getAbortSignal()).toBeNull();
    });

    it('should abort the controller when requestCancel is called during an operation', () => {
      gitHandlers.acquireGitLock();
      const signal = gitHandlers.getAbortSignal();
      expect(signal.aborted).toBe(false);

      gitHandlers.requestCancel();

      expect(signal.aborted).toBe(true);
      expect(gitHandlers.cancelRequested).toBe(true);
      gitHandlers.releaseGitLock();
    });

    it('should not throw when requestCancel is called with no active controller', () => {
      expect(() => gitHandlers.requestCancel()).not.toThrow();
      expect(gitHandlers.cancelRequested).toBe(true);
    });

    it('should provide a fresh AbortSignal on each acquireGitLock', () => {
      gitHandlers.acquireGitLock();
      const first = gitHandlers.getAbortSignal();
      gitHandlers.releaseGitLock();

      gitHandlers.acquireGitLock();
      const second = gitHandlers.getAbortSignal();
      gitHandlers.releaseGitLock();

      expect(first).not.toBe(second);
    });

    it('should use a LOCK_TIMEOUT_MS of at least 120000 (raised from 60s)', () => {
      expect(gitHandlers.LOCK_TIMEOUT_MS).toBeGreaterThanOrEqual(120000);
    });
  });
});
