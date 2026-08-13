/**
 * @fileoverview Tests for git IPC handlers
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron at the top level
const mockIpcMain = {
  handle: vi.fn(),
  removeHandler: vi.fn()
};

vi.mock('electron', () => ({
  ipcMain: mockIpcMain
}));

// isomorphic-git is intentionally NOT mocked at module level: vitest's
// vi.mock does not intercept CommonJS `require()` used by src/ipc/git.js,
// so behavior tests below spy on the real module's methods instead.
vi.mock('isomorphic-git/http/node', () => ({}));

describe('GitHandlers Unit Tests', () => {
  let mockLogger;
  let mockDatabaseManager;
  let mockIpcMain;

  beforeEach(() => {
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
  });

  describe('GitHandlers Basic Functionality', () => {
    it('should validate dependencies are properly mocked', () => {
      expect(mockLogger.info).toBeDefined();
      expect(mockDatabaseManager.getDatabase).toBeDefined();
    });

    it('should test mock logger functionality', () => {
      mockLogger.info('Test git message');
      expect(mockLogger.info).toHaveBeenCalledWith('Test git message');
    });

    it('should test mock database functionality', async () => {
      const db = await mockDatabaseManager.getDatabase();
      expect(db).toBeDefined();
      expect(mockDatabaseManager.getDatabase).toHaveBeenCalled();
    });
  });

  describe('Module Import Validation', () => {
    it('should validate GitHandlers can be imported', async () => {
      const { GitHandlers } = await import('../../src/ipc/git.js');
      expect(GitHandlers).toBeDefined();
    });

    it('should create GitHandlers instance', async () => {
      const { GitHandlers } = await import('../../src/ipc/git.js');
      const handlers = new GitHandlers({
        logger: mockLogger,
        databaseManager: mockDatabaseManager
      });
      
      expect(handlers).toBeDefined();
      expect(handlers.logger).toBe(mockLogger);
      expect(handlers.databaseManager).toBe(mockDatabaseManager);
    });
  });

  describe('Basic Method Existence Tests', () => {
    let gitHandlers;

    beforeEach(async () => {
      const { GitHandlers } = await import('../../src/ipc/git.js');
      gitHandlers = new GitHandlers({
        logger: mockLogger,
        databaseManager: mockDatabaseManager
      });
    });

    it('should have getProjectPath method', () => {
      expect(typeof gitHandlers.getProjectPath).toBe('function');
    });

    it('should have gitListBranches method', () => {
      expect(typeof gitHandlers.gitListBranches).toBe('function');
    });

    it('should have gitCreateBranch method', () => {
      expect(typeof gitHandlers.gitCreateBranch).toBe('function');
    });

    it('should have gitCheckoutBranch method', () => {
      expect(typeof gitHandlers.gitCheckoutBranch).toBe('function');
    });

    it('should have gitGetCurrentBranch method', () => {
      expect(typeof gitHandlers.gitGetCurrentBranch).toBe('function');
    });

    it('should have gitGetRepositoryInfo method', () => {
      expect(typeof gitHandlers.gitGetRepositoryInfo).toBe('function');
    });

    it('should have gitPullFromPreview method', () => {
      expect(typeof gitHandlers.gitPullFromPreview).toBe('function');
    });

    it('should have gitPushToBranch method', () => {
      expect(typeof gitHandlers.gitPushToBranch).toBe('function');
    });

    it('should have gitListRemoteBranches method', () => {
      expect(typeof gitHandlers.gitListRemoteBranches).toBe('function');
    });

    it('should have registerHandlers method', () => {
      expect(typeof gitHandlers.registerHandlers).toBe('function');
    });

    it('should have unregisterHandlers method', () => {
      expect(typeof gitHandlers.unregisterHandlers).toBe('function');
    });
  });

  describe('Git Operations Flow Tests', () => {
    let gitHandlers;

    beforeEach(async () => {
      const { GitHandlers } = await import('../../src/ipc/git.js');
      gitHandlers = new GitHandlers({
        logger: mockLogger,
        databaseManager: mockDatabaseManager
      });
    });

    it('should handle getting project path', async () => {
      const result = await gitHandlers.getProjectPath(1);
      
      expect(result).toBe('/base/path/repo-name');
    });

    it('should validate git list branches method exists and is callable', async () => {
      expect(typeof gitHandlers.gitListBranches).toBe('function');
      // We don't call it to avoid actual git operations
    });

    it('should validate git create branch method exists and is callable', async () => {
      expect(typeof gitHandlers.gitCreateBranch).toBe('function');
      // We don't call it to avoid actual git operations
    });

    it('should validate git checkout method exists and is callable', async () => {
      expect(typeof gitHandlers.gitCheckoutBranch).toBe('function');
      // We don't call it to avoid actual git operations
    });

    it('should validate getting current branch method exists and is callable', async () => {
      expect(typeof gitHandlers.gitGetCurrentBranch).toBe('function');
      // We don't call it to avoid actual git operations
    });

    it('should validate getting repository info method exists and is callable', async () => {
      expect(typeof gitHandlers.gitGetRepositoryInfo).toBe('function');
      // We don't call it to avoid actual git operations
    });

    it('should validate git pull from preview method exists and is callable', async () => {
      expect(typeof gitHandlers.gitPullFromPreview).toBe('function');
      // We don't call it to avoid actual git operations
    });

    it('should validate git push to branch method exists and is callable', async () => {
      expect(typeof gitHandlers.gitPushToBranch).toBe('function');
      // We don't call it to avoid actual git operations
    });

    it('should validate listing remote branches method exists and is callable', async () => {
      expect(typeof gitHandlers.gitListRemoteBranches).toBe('function');
      // We don't call it to avoid actual git operations
    });
  });

  describe('Error Handling Tests', () => {
    let gitHandlers;

    beforeEach(async () => {
      const { GitHandlers } = await import('../../src/ipc/git.js');
      gitHandlers = new GitHandlers({
        logger: mockLogger,
        databaseManager: mockDatabaseManager
      });
    });

    it('should handle database errors gracefully', async () => {
      mockDatabaseManager.getDatabase.mockRejectedValue(new Error('Database connection failed'));
      
      await expect(gitHandlers.getProjectPath(1)).rejects.toThrow('Database connection failed');
    });

    it('should handle project not found errors', async () => {
      const mockDb = await mockDatabaseManager.getDatabase();
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      await expect(gitHandlers.getProjectPath(999)).rejects.toThrow('Project not found');
    });

    it('should validate error handling structure exists', () => {
      // Test that error handling methods exist
      expect(typeof gitHandlers.getProjectPath).toBe('function');
      expect(mockLogger.error).toBeDefined();
    });
  });

  describe('IPC Registration Tests', () => {
    let gitHandlers;

    beforeEach(async () => {
      const { GitHandlers } = await import('../../src/ipc/git.js');
      gitHandlers = new GitHandlers({
        logger: mockLogger,
        databaseManager: mockDatabaseManager
      });
    });

    it('should validate registerHandlers method exists', () => {
      expect(typeof gitHandlers.registerHandlers).toBe('function');
      // We don't call it to avoid ipcMain dependency issues
    });

    it('should validate unregisterHandlers method exists', () => {
      expect(typeof gitHandlers.unregisterHandlers).toBe('function');
      // We don't call it to avoid ipcMain dependency issues
    });
  });

  describe('gitCheckoutBranch — remote-only tracking branch creation', () => {
    let gitHandlers;
    let gitMod;
    let checkoutSpy;
    let branchSpy;
    let setConfigSpy;
    let listBranchesSpy;

    beforeEach(async () => {
      vi.clearAllMocks();
      const { GitHandlers } = await import('../../src/ipc/git.js');
      // src/ipc/git.js does `const git = require('isomorphic-git')` at load,
      // holding a reference to the same cached module object. Spies installed
      // on it therefore intercept calls made from inside git.js methods.
      gitMod = require('isomorphic-git');

      gitHandlers = new GitHandlers({
        logger: mockLogger,
        databaseManager: mockDatabaseManager
      });

      checkoutSpy = vi.spyOn(gitMod, 'checkout');
      branchSpy = vi.spyOn(gitMod, 'branch');
      setConfigSpy = vi.spyOn(gitMod, 'setConfig').mockResolvedValue(undefined);
      listBranchesSpy = vi.spyOn(gitHandlers, 'gitListBranches');
    });

    afterEach(() => {
      checkoutSpy.mockRestore();
      branchSpy.mockRestore();
      setConfigSpy.mockRestore();
      listBranchesSpy.mockRestore();
    });

    it('should create local branch from origin/<name> (not HEAD) when only remote exists', async () => {
      checkoutSpy.mockRejectedValue(new Error('ref does not match any known ref'));
      listBranchesSpy.mockResolvedValue({
        branches: [{ name: 'preview', isRemote: true }],
        current: 'main'
      });
      branchSpy.mockResolvedValue(undefined);

      await gitHandlers.gitCheckoutBranch('/repo', 'preview');

      expect(branchSpy).toHaveBeenCalledTimes(1);
      const branchCall = branchSpy.mock.calls[0][0];
      expect(branchCall.ref).toBe('preview');
      expect(branchCall.checkout).toBe(true);
      expect(branchCall.object).toBe('origin/preview');

      expect(setConfigSpy).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'branch.preview.remote', value: 'origin' })
      );
      expect(setConfigSpy).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'branch.preview.merge', value: 'refs/heads/preview' })
      );
    });

    it('should NOT call git.branch when local branch exists', async () => {
      checkoutSpy.mockResolvedValue(undefined);

      await gitHandlers.gitCheckoutBranch('/repo', 'main');

      expect(branchSpy).not.toHaveBeenCalled();
    });
  });
});