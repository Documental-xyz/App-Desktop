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
      createUsingTemplate: vi.fn(),
      get: vi.fn()
    },
    users: {
      getAuthenticated: vi.fn()
    }
  };
  // Octokit exposes both `.repos.X` (legacy) and `.rest.repos.X` (current API).
  // Aliasing `.rest` → self lets the same mocks serve both call styles.
  mockOctokitInstance.rest = mockOctokitInstance;
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

      // i18n defaults to 'en' in test environment
      expect(onProgress).toHaveBeenCalledWith('Creating fork...');
      expect(onProgress).toHaveBeenCalledWith('Waiting for fork to be ready...');
      expect(result.success).toBe(true);
    });
  });

  describe('createFromTemplate', () => {
    // Common mock setup for createFromTemplate authenticated + resolved template call
    function setupTemplateSuccess(overrides = {}) {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.users.getAuthenticated.mockResolvedValue({
        data: { login: 'test-user' }
      });
      mockOctokitInstance.repos.createUsingTemplate.mockResolvedValue(
        Object.assign(
          {
            status: 201,
            data: {
              clone_url: 'https://github.com/test-user/test-repo.git',
              name: 'test-repo'
            }
          },
          overrides
        )
      );
    }

    it('calls octokit.rest.repos.createUsingTemplate with correct params', async () => {
      setupTemplateSuccess({
        data: { clone_url: 'https://github.com/test-user/test-repo.git', name: 'test-repo' }
      });

      await service.createFromTemplate(
        'TemplateOwner',
        'TemplateRepo',
        'my-repo',
        null,
        { owner: 'my-org', private: true, description: 'Test desc' }
      );

      expect(mockOctokitInstance.repos.createUsingTemplate).toHaveBeenCalledWith({
        template_owner: 'TemplateOwner',
        template_repo: 'TemplateRepo',
        name: 'my-repo',
        description: 'Test desc',
        include_all_branches: false,
        private: true,
        owner: 'my-org'
      });
    });

    it('omits owner when not provided', async () => {
      setupTemplateSuccess();

      await service.createFromTemplate('TemplateOwner', 'TemplateRepo', 'my-repo', null);

      const callArgs = mockOctokitInstance.repos.createUsingTemplate.mock.calls[0][0];
      expect(callArgs.owner).toBeUndefined();
    });

    it('passes private flag through', async () => {
      // private: true
      setupTemplateSuccess();
      await service.createFromTemplate('TemplateOwner', 'TemplateRepo', 'my-repo', null, { private: true });
      expect(mockOctokitInstance.repos.createUsingTemplate.mock.calls[0][0].private).toBe(true);

      vi.clearAllMocks();
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.users.getAuthenticated.mockResolvedValue({ data: { login: 'test-user' } });
      mockOctokitInstance.repos.createUsingTemplate.mockResolvedValue({
        status: 201,
        data: { clone_url: 'https://github.com/test-user/test-repo.git', name: 'test-repo' }
      });

      // private: false
      await service.createFromTemplate('TemplateOwner', 'TemplateRepo', 'my-repo', null, { private: false });
      expect(mockOctokitInstance.repos.createUsingTemplate.mock.calls[0][0].private).toBe(false);
    });

    it('passes owner for org destination', async () => {
      setupTemplateSuccess();

      await service.createFromTemplate('TemplateOwner', 'TemplateRepo', 'my-repo', null, { owner: 'my-org' });

      expect(mockOctokitInstance.repos.createUsingTemplate.mock.calls[0][0].owner).toBe('my-org');
    });

    it('does NOT include template_owner/template_repo as body params', async () => {
      setupTemplateSuccess();

      await service.createFromTemplate(
        'TemplateOwner',
        'TemplateRepo',
        'my-repo',
        null,
        { description: 'd', private: false }
      );

      const callArg = mockOctokitInstance.repos.createUsingTemplate.mock.calls[0][0];
      // template_owner and template_repo should appear exactly once (as path params),
      // not duplicated as separate body-only entries.
      expect(Object.keys(callArg).filter(k => k === 'template_owner')).toHaveLength(1);
      expect(Object.keys(callArg).filter(k => k === 'template_repo')).toHaveLength(1);
      // All keys are exactly the expected set
      expect(Object.keys(callArg).sort()).toEqual(
        ['description', 'include_all_branches', 'name', 'private', 'template_owner', 'template_repo'].sort()
      );
    });

    it('maps 404 to template_not_found error', async () => {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.users.getAuthenticated.mockResolvedValue({ data: { login: 'test-user' } });
      mockOctokitInstance.repos.createUsingTemplate.mockRejectedValue({
        status: 404,
        message: 'Not Found'
      });

      await expect(
        service.createFromTemplate('TemplateOwner', 'TemplateRepo', 'my-repo')
      ).rejects.toThrow(/template_not_found/i);
    });

    it('maps 422 to name_taken error', async () => {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.users.getAuthenticated.mockResolvedValue({ data: { login: 'test-user' } });
      mockOctokitInstance.repos.createUsingTemplate.mockRejectedValue({
        status: 422,
        message: 'name already exists'
      });

      await expect(
        service.createFromTemplate('TemplateOwner', 'TemplateRepo', 'my-repo')
      ).rejects.toThrow(/template_name_taken/i);
    });

    it('maps 403 to no_permission error', async () => {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.users.getAuthenticated.mockResolvedValue({ data: { login: 'test-user' } });
      mockOctokitInstance.repos.createUsingTemplate.mockRejectedValue({
        status: 403,
        message: 'Forbidden'
      });

      await expect(
        service.createFromTemplate('TemplateOwner', 'TemplateRepo', 'my-repo')
      ).rejects.toThrow(/template_no_permission/i);
    });

    it('returns cloneUrl from response', async () => {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.users.getAuthenticated.mockResolvedValue({ data: { login: 'test-user' } });
      mockOctokitInstance.repos.createUsingTemplate.mockResolvedValue({
        status: 201,
        data: {
          clone_url: 'https://github.com/test-user/my-repo.git',
          name: 'my-repo'
        }
      });

      const result = await service.createFromTemplate('TemplateOwner', 'TemplateRepo', 'my-repo');

      expect(result.success).toBe(true);
      expect(result.cloneUrl).toBe('https://github.com/test-user/my-repo.git');
    });
  });
});
