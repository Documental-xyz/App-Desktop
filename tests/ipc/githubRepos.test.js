/**
 * @vitest-environment node
 * @fileoverview Tests for GitHub Repos IPC handlers
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// ── Hoisted mocks — available inside vi.mock() factories ──────────────────

const {
  mockIpcMain,
  mockOctokitInstance,
  mockElectron
} = vi.hoisted(() => {
  const mockIpcMain = {
    handle: vi.fn(),
    removeHandler: vi.fn()
  };
  const mockOctokitInstance = {
    repos: {
      listForAuthenticatedUser: vi.fn()
    }
  };
  const mockElectron = {
    ipcMain: mockIpcMain,
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    app: { getPath: vi.fn(() => '/tmp/test') },
    safeStorage: {
      encryptString: vi.fn(() => Buffer.from('e')),
      decryptString: vi.fn(() => ''),
      isEncryptionAvailable: vi.fn(() => true)
    }
  };
  return { mockIpcMain, mockOctokitInstance, mockElectron };
});

// Named function so vi.fn wraps a real constructor (vitest 4.x requirement)
function MockOctokitImpl() { return mockOctokitInstance; }

// ── Module mocks (hoisted before imports by vitest) ────────────────────────

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(MockOctokitImpl)
}));

// ── Module._load monkey-patch for electron ─────────────────────────────────
// vi.mock('electron') does NOT intercept native require('electron') in CJS
// source files. We patch Module._load to ensure the mock is returned.

const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'electron') {
    return mockElectron;
  }
  return originalLoad.call(this, request, ...args);
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a raw repo object from the GitHub API with many fields.
 * Only a subset should be retained by the handler.
 */
function makeRepo(id, name) {
  return {
    id,
    name,
    full_name: `user/${name}`,
    clone_url: `https://github.com/user/${name}.git`,
    private: false,
    updated_at: '2025-01-01T00:00:00Z',
    description: `Repo ${name}`,
    // ── Extra fields that must be filtered out ──
    url: `https://api.github.com/repos/user/${name}`,
    html_url: `https://github.com/user/${name}`,
    fork: false,
    created_at: '2024-01-01T00:00:00Z',
    stargazers_count: 42,
    owner: { login: 'user' }
  };
}

function makeRepos(startId, count) {
  const repos = [];
  for (let i = 0; i < count; i++) {
    repos.push(makeRepo(startId + i, `repo-${startId + i}`));
  }
  return repos;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GithubReposHandlers', () => {
  let handlers;
  let mockLogger;
  let tokenMock;

  beforeAll(() => {
    // require() ensures shared CJS cache with source's require()
    const mod = require('../../src/services/secureTokenService.js');
    tokenMock = vi.spyOn(mod.secureTokenService, 'getToken');
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    tokenMock.mockResolvedValue(null);

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };

    // import() ensures vitest transforms the source, intercepting
    // the dynamic import('@octokit/rest') inside listUserRepos
    const { GithubReposHandlers } = await import('../../src/ipc/githubRepos.js');
    handlers = new GithubReposHandlers({ logger: mockLogger });
  });

  // ── registerHandlers / unregisterHandlers ──────────────────────────────

  describe('registerHandlers / unregisterHandlers', () => {
    it("registerHandlers calls ipcMain.handle('github:list-user-repos', ...)", () => {
      handlers.registerHandlers();

      expect(mockIpcMain.handle).toHaveBeenCalledWith(
        'github:list-user-repos',
        expect.any(Function)
      );
    });

    it("unregisterHandlers calls ipcMain.removeHandler('github:list-user-repos')", () => {
      handlers.unregisterHandlers();

      expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('github:list-user-repos');
    });
  });

  // ── listUserRepos ──────────────────────────────────────────────────────

  describe('listUserRepos', () => {
    it("returns {success:false, error:'Not authenticated'} when token is null", async () => {
      tokenMock.mockResolvedValue(null);

      const result = await handlers.listUserRepos();

      expect(result).toEqual({ success: false, error: 'Not authenticated' });
      expect(mockOctokitInstance.repos.listForAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('returns {success:true, repos:[...]} with pagination (2 pages)', async () => {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.repos.listForAuthenticatedUser
        .mockResolvedValueOnce({ data: makeRepos(1, 100) })  // page 1: full page
        .mockResolvedValueOnce({ data: makeRepos(101, 50) }); // page 2: partial → break

      const result = await handlers.listUserRepos();

      expect(result.success).toBe(true);
      expect(result.repos).toHaveLength(150);
      expect(mockOctokitInstance.repos.listForAuthenticatedUser).toHaveBeenCalledTimes(2);
    });

    it('respects the 500 repo cap (mock 6 pages of 100)', async () => {
      tokenMock.mockResolvedValue('fake-token');
      // Always return a full page of 100 repos regardless of page number
      mockOctokitInstance.repos.listForAuthenticatedUser.mockResolvedValue({
        data: makeRepos(1, 100)
      });

      const result = await handlers.listUserRepos();

      expect(result.success).toBe(true);
      expect(result.repos).toHaveLength(500);
      // 5 pages × 100 = 500 → loop exits before requesting a 6th page
      expect(mockOctokitInstance.repos.listForAuthenticatedUser).toHaveBeenCalledTimes(5);
    });

    it('returns rate limit error on 403', async () => {
      tokenMock.mockResolvedValue('fake-token');
      const error = new Error('API rate limit exceeded');
      error.status = 403;
      mockOctokitInstance.repos.listForAuthenticatedUser.mockRejectedValue(error);

      const result = await handlers.listUserRepos();

      expect(result).toEqual({
        success: false,
        error: 'Rate limit exceeded. Please try again later.'
      });
    });

    it('returns token expired error on 401', async () => {
      tokenMock.mockResolvedValue('fake-token');
      const error = new Error('Bad credentials');
      error.status = 401;
      mockOctokitInstance.repos.listForAuthenticatedUser.mockRejectedValue(error);

      const result = await handlers.listUserRepos();

      expect(result).toEqual({
        success: false,
        error: 'Token expired. Please re-authenticate.'
      });
    });

    it('filters repo fields to {id, name, full_name, clone_url, private, updated_at, description}', async () => {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.repos.listForAuthenticatedUser.mockResolvedValueOnce({
        data: [makeRepo(1, 'test-repo')]
      });

      const result = await handlers.listUserRepos();

      expect(result.success).toBe(true);
      expect(result.repos).toHaveLength(1);

      const repo = result.repos[0];
      expect(Object.keys(repo).sort()).toEqual(
        ['clone_url', 'description', 'full_name', 'id', 'name', 'private', 'updated_at']
      );
      expect(repo.id).toBe(1);
      expect(repo.name).toBe('test-repo');
      expect(repo.full_name).toBe('user/test-repo');
      expect(repo.clone_url).toBe('https://github.com/user/test-repo.git');
      expect(repo.private).toBe(false);
      expect(repo.updated_at).toBe('2025-01-01T00:00:00Z');
      expect(repo.description).toBe('Repo test-repo');
    });
  });
});
