/**
 * @vitest-environment node
 * @fileoverview Tests for GitHub Fork Service
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';

// ── Hoisted mocks — available inside vi.mock() factories ──────────────────

const {
  mockOctokitInstance,
  mockElectron
} = vi.hoisted(() => {
  const mockOctokitInstance = {
    repos: {
      createFork: vi.fn(),
      get: vi.fn()
    },
    users: {
      getAuthenticated: vi.fn()
    }
  };
  const mockElectron = {
    safeStorage: {
      encryptString: vi.fn(() => Buffer.from('encrypted')),
      decryptString: vi.fn(() => ''),
      isEncryptionAvailable: vi.fn(() => true)
    },
    app: { getPath: vi.fn(() => '/tmp/test-userdata') },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
  };
  return { mockOctokitInstance, mockElectron };
});

// Named function so vi.fn wraps a real constructor (vitest 4.x requirement)
function MockOctokitImpl() { return mockOctokitInstance; }

// ── Module mocks (hoisted before imports by vitest) ────────────────────────

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(MockOctokitImpl)
}));

// ── Module._load monkey-patch for electron ─────────────────────────────────

const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'electron') {
    return mockElectron;
  }
  return originalLoad.call(this, request, ...args);
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GithubForkService', () => {
  let service;
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
    // the dynamic import('@octokit/rest') inside forkAndPoll
    const { GithubForkService } = await import('../../src/services/githubForkService.js');
    service = new GithubForkService({ logger: mockLogger });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Common mock setup for authenticated + user resolved
  function setupAuth() {
    tokenMock.mockResolvedValue('fake-token');
    mockOctokitInstance.users.getAuthenticated.mockResolvedValue({
      data: { login: 'currentuser' }
    });
  }

  describe('forkAndPoll', () => {
    it('rejects when token is null ("Not authenticated")', async () => {
      tokenMock.mockResolvedValue(null);

      await expect(service.forkAndPoll('owner', 'repo')).rejects.toThrow(/Not authenticated/i);
      expect(mockOctokitInstance.repos.createFork).not.toHaveBeenCalled();
    });

    it('calls repos.createFork({owner, repo}) exactly once', async () => {
      setupAuth();
      mockOctokitInstance.repos.createFork.mockResolvedValue({ status: 202 });
      // First poll returns ready → no iteration needed
      mockOctokitInstance.repos.get.mockResolvedValue({
        status: 200,
        data: { parent: { full_name: 'owner/repo' }, clone_url: 'https://github.com/currentuser/repo.git' }
      });

      await service.forkAndPoll('owner', 'repo');

      expect(mockOctokitInstance.repos.createFork).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo'
      });
      expect(mockOctokitInstance.repos.createFork).toHaveBeenCalledTimes(1);
    });

    it('polls repos.get until data.parent exists, then returns {success:true, forkCloneUrl, fork}', async () => {
      vi.useFakeTimers();

      setupAuth();
      mockOctokitInstance.repos.createFork.mockResolvedValue({ status: 202 });

      const readyData = {
        parent: { full_name: 'owner/repo' },
        clone_url: 'https://github.com/currentuser/repo.git'
      };
      mockOctokitInstance.repos.get
        .mockResolvedValueOnce({ status: 200, data: {} })     // 1st poll: not ready
        .mockResolvedValueOnce({ status: 200, data: {} })     // 2nd poll: not ready
        .mockResolvedValueOnce({ status: 200, data: readyData }); // 3rd poll: ready!

      const promise = service.forkAndPoll('owner', 'repo');

      // Advance through 2 polling intervals (2 failed checks → 2 setTimeouts)
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.forkCloneUrl).toBe('https://github.com/currentuser/repo.git');
      expect(result.fork).toEqual(readyData);
      expect(mockOctokitInstance.repos.get).toHaveBeenCalledTimes(3);
    });

    it('times out after FORK_POLLING.timeoutMs → throws timeout error', async () => {
      vi.useFakeTimers();

      setupAuth();
      mockOctokitInstance.repos.createFork.mockResolvedValue({ status: 202 });
      // Never ready — always returns data without parent
      mockOctokitInstance.repos.get.mockResolvedValue({ status: 200, data: {} });

      const promise = service.forkAndPoll('owner', 'repo');
      promise.catch(() => {}); // suppress unhandled rejection until expect() catches it

      // Advance past the 60s timeout
      await vi.advanceTimersByTimeAsync(62000);

      await expect(promise).rejects.toThrow(/timed out/i);
    });

    it('treats createFork idempotency (already exists) as success', async () => {
      setupAuth();
      // createFork rejects with a status-202 / "already exist" error
      const forkExistsError = Object.assign(new Error('Repository already exists'), {
        status: 202
      });
      mockOctokitInstance.repos.createFork.mockRejectedValue(forkExistsError);
      // First poll returns ready
      mockOctokitInstance.repos.get.mockResolvedValue({
        status: 200,
        data: { parent: { full_name: 'owner/repo' } }
      });

      const result = await service.forkAndPoll('owner', 'repo');

      expect(result.success).toBe(true);
      expect(result.forkCloneUrl).toBe('https://github.com/currentuser/repo.git');
    });

    it('onProgress callback is called with messages during fork and polling', async () => {
      vi.useFakeTimers();

      setupAuth();
      mockOctokitInstance.repos.createFork.mockResolvedValue({ status: 202 });

      const readyData = { parent: { full_name: 'owner/repo' } };
      mockOctokitInstance.repos.get
        .mockResolvedValueOnce({ status: 200, data: {} })  // not ready → polling msg
        .mockResolvedValueOnce({ status: 200, data: readyData }); // ready

      const onProgress = vi.fn();
      const promise = service.forkAndPoll('owner', 'repo', onProgress);

      // Advance past the single polling interval
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      // "Criando fork..." is called before createFork
      expect(onProgress).toHaveBeenCalledWith('Criando fork...');
      // "Aguardando fork ficar pronto..." is called during each polling cycle
      expect(onProgress).toHaveBeenCalledWith('Aguardando fork ficar pronto...');
      expect(result.success).toBe(true);
    });
  });
});
