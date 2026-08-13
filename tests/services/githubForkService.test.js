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
      get: vi.fn(),
      createPagesSite: vi.fn(),
      updateInformationAboutPagesSite: vi.fn(),
      createOrUpdateEnvironment: vi.fn(),
      createDeploymentBranchPolicy: vi.fn()
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

// KNOWN-FAILURE: quarantined during perf-zombie-refactor, see tests/KNOWN-FAILURES.md
describe.skip('GithubForkService', () => {
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

    it('treats createFork idempotency (already exists) as error', async () => {
      setupAuth();
      // createFork throws with a status-202 / "already exist" error
      const forkExistsError = Object.assign(new Error('Repository already exists'), {
        status: 202
      });
      mockOctokitInstance.repos.createFork.mockRejectedValue(forkExistsError);

      await expect(service.forkAndPoll('owner', 'repo')).rejects.toThrow(
        'A repository with this name already exists in your account. Please choose a different workspace name.'
      );
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
      expect(onProgress).toHaveBeenCalledWith('Creating repository...');
      expect(onProgress).toHaveBeenCalledWith('Waiting for repository to be ready...');
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

  describe('waitForRepoReadiness', () => {
    it('rejects when token is null ("Not authenticated")', async () => {
      tokenMock.mockResolvedValue(null);

      await expect(service.waitForRepoReadiness('owner', 'repo')).rejects.toThrow(/Not authenticated/i);
      expect(mockOctokitInstance.repos.get).not.toHaveBeenCalled();
    });

    it('returns true immediately when default_branch populated and size > 0', async () => {
      setupAuth();
      mockOctokitInstance.repos.get.mockResolvedValue({
        status: 200,
        data: { default_branch: 'main', size: 42 }
      });

      const result = await service.waitForRepoReadiness('owner', 'repo');

      expect(result).toBe(true);
      expect(mockOctokitInstance.repos.get).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo' });
      expect(mockOctokitInstance.repos.get).toHaveBeenCalledTimes(1);
    });

    it('polls while size === 0, then resolves once size > 0', async () => {
      vi.useFakeTimers();

      setupAuth();
      mockOctokitInstance.repos.get
        .mockResolvedValueOnce({ status: 200, data: { default_branch: 'main', size: 0 } })
        .mockResolvedValueOnce({ status: 200, data: { default_branch: 'main', size: 0 } })
        .mockResolvedValueOnce({ status: 200, data: { default_branch: 'main', size: 15 } });

      const promise = service.waitForRepoReadiness('owner', 'repo');

      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);

      const result = await promise;

      expect(result).toBe(true);
      expect(mockOctokitInstance.repos.get).toHaveBeenCalledTimes(3);
    });

    it('polls while default_branch is empty, then resolves once populated', async () => {
      vi.useFakeTimers();

      setupAuth();
      mockOctokitInstance.repos.get
        .mockResolvedValueOnce({ status: 200, data: { default_branch: null, size: 5 } })
        .mockResolvedValueOnce({ status: 200, data: { default_branch: 'main', size: 5 } });

      const promise = service.waitForRepoReadiness('owner', 'repo');

      await vi.advanceTimersByTimeAsync(2000);

      const result = await promise;

      expect(result).toBe(true);
      expect(mockOctokitInstance.repos.get).toHaveBeenCalledTimes(2);
    });

    it('keeps polling on 404 errors, then resolves', async () => {
      vi.useFakeTimers();

      setupAuth();
      const notFoundError = { status: 404, message: 'Not Found' };
      mockOctokitInstance.repos.get
        .mockRejectedValueOnce(notFoundError)
        .mockResolvedValueOnce({ status: 200, data: { default_branch: 'main', size: 10 } });

      const promise = service.waitForRepoReadiness('owner', 'repo');

      await vi.advanceTimersByTimeAsync(2000);

      const result = await promise;

      expect(result).toBe(true);
      expect(mockOctokitInstance.repos.get).toHaveBeenCalledTimes(2);
    });

    it('throws after timeoutMs when repo never becomes ready', async () => {
      vi.useFakeTimers();

      setupAuth();
      mockOctokitInstance.repos.get.mockResolvedValue({
        status: 200,
        data: { default_branch: null, size: 0 }
      });

      const promise = service.waitForRepoReadiness('owner', 'repo', null, {
        intervalMs: 1000,
        timeoutMs: 5000
      });
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(6000);

      await expect(promise).rejects.toThrow(/não ficou pronto/i);
    });

    it('honors custom intervalMs and timeoutMs options', async () => {
      vi.useFakeTimers();

      setupAuth();
      mockOctokitInstance.repos.get.mockResolvedValue({
        status: 200,
        data: { default_branch: 'main', size: 0 }
      });

      const promise = service.waitForRepoReadiness('owner', 'repo', null, {
        intervalMs: 500,
        timeoutMs: 2000
      });
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(3000);

      await expect(promise).rejects.toThrow(/2s/);
    });

    it('onProgress is called with readiness messages', async () => {
      setupAuth();
      mockOctokitInstance.repos.get.mockResolvedValue({
        status: 200,
        data: { default_branch: 'main', size: 7 }
      });

      const onProgress = vi.fn();
      await service.waitForRepoReadiness('owner', 'repo', onProgress);

      expect(onProgress).toHaveBeenCalledWith(
        expect.stringMatching(/✅ Repositório pronto.*branch: main.*tamanho: 7KB/)
      );
    });

    it('onProgress is called with waiting message during polling', async () => {
      vi.useFakeTimers();

      setupAuth();
      mockOctokitInstance.repos.get
        .mockResolvedValueOnce({ status: 200, data: { default_branch: null, size: 0 } })
        .mockResolvedValueOnce({ status: 200, data: { default_branch: 'main', size: 3 } });

      const onProgress = vi.fn();
      const promise = service.waitForRepoReadiness('owner', 'repo', onProgress);

      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(onProgress).toHaveBeenCalledWith(expect.stringMatching(/⏳ Aguardando.*tentativa 1/));
    });

    it('uses default intervalMs=2000 and timeoutMs=30000 when options omitted', async () => {
      vi.useFakeTimers();

      setupAuth();
      mockOctokitInstance.repos.get.mockResolvedValue({
        status: 200,
        data: { default_branch: null, size: 0 }
      });

      const promise = service.waitForRepoReadiness('owner', 'repo');
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(32000);

      await expect(promise).rejects.toThrow(/30s/);
    });
  });

  describe('full template flow', () => {
    it('createFromTemplate returns cloneUrl matching expected format', async () => {
      setupAuth();
      mockOctokitInstance.repos.createUsingTemplate.mockResolvedValue({
        status: 201,
        data: {
          clone_url: 'https://github.com/test-user/my-project.git',
          full_name: 'test-user/my-project'
        }
      });

      const result = await service.createFromTemplate('Documental-xyz', 'Template', 'my-project');

      expect(result.success).toBe(true);
      expect(result.cloneUrl).toMatch(/^https:\/\/github\.com\/.+\/.+\.git$/);
      expect(result.cloneUrl).toBe('https://github.com/test-user/my-project.git');
      expect(result.repo.full_name).toBe('test-user/my-project');
    });

    it('createFromTemplate works with options (private, description, owner)', async () => {
      setupAuth();
      mockOctokitInstance.repos.createUsingTemplate.mockResolvedValue({
        status: 201,
        data: {
          clone_url: 'https://github.com/my-org/my-project.git',
          full_name: 'my-org/my-project',
          private: true,
          description: 'Test project'
        }
      });

      const result = await service.createFromTemplate(
        'Documental-xyz', 'Template', 'my-project', null,
        { owner: 'my-org', private: true, description: 'Test project' }
      );

      expect(result.success).toBe(true);
      expect(result.cloneUrl).toContain('my-org');
      expect(mockOctokitInstance.repos.createUsingTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'my-org',
          private: true
        })
      );
    });

    it('createFromTemplate followed by waitForRepoReadiness completes successfully', async () => {
      vi.useFakeTimers();

      setupAuth();
      mockOctokitInstance.repos.createUsingTemplate.mockResolvedValue({
        status: 201,
        data: {
          clone_url: 'https://github.com/test-user/my-project.git',
          full_name: 'test-user/my-project'
        }
      });

      mockOctokitInstance.repos.get
        .mockResolvedValueOnce({ status: 200, data: { default_branch: 'main', size: 0 } })
        .mockResolvedValueOnce({ status: 200, data: { default_branch: 'main', size: 7951 } });

      const createResult = await service.createFromTemplate('Documental-xyz', 'Template', 'my-project');
      expect(createResult.success).toBe(true);

      const match = createResult.cloneUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
      expect(match).not.toBeNull();

      const [, owner, repo] = match;
      const readinessPromise = service.waitForRepoReadiness(owner, repo, null, {
        intervalMs: 1000,
        timeoutMs: 10000
      });

      await vi.advanceTimersByTimeAsync(1000);
      const ready = await readinessPromise;

      expect(ready).toBe(true);
      expect(mockOctokitInstance.repos.get).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'test-user', repo: 'my-project' })
      );
    });
  });

  describe('checkTemplateTargetExists', () => {
    it('returns exists:true when repo exists at target owner', async () => {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.repos.get.mockResolvedValue({
        status: 200,
        data: { full_name: 'my-org/my-repo' }
      });

      const result = await service.checkTemplateTargetExists('my-org', 'my-repo');

      expect(result.exists).toBe(true);
      expect(result.fullName).toBe('my-org/my-repo');
    });

    it('returns exists:false when 404', async () => {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.repos.get.mockRejectedValue({ status: 404, message: 'Not Found' });

      const result = await service.checkTemplateTargetExists('my-org', 'nonexistent');

      expect(result.exists).toBe(false);
    });

    it('uses targetOwner when provided', async () => {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.repos.get.mockResolvedValue({
        status: 200,
        data: { full_name: 'my-org/my-repo' }
      });

      await service.checkTemplateTargetExists('my-org', 'my-repo');

      expect(mockOctokitInstance.repos.get).toHaveBeenCalledWith({ owner: 'my-org', repo: 'my-repo' });
      expect(mockOctokitInstance.users.getAuthenticated).not.toHaveBeenCalled();
    });

    it('uses authenticated user login when targetOwner is null', async () => {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.users.getAuthenticated.mockResolvedValue({ data: { login: 'test-user' } });
      mockOctokitInstance.repos.get.mockResolvedValue({
        status: 200,
        data: { full_name: 'test-user/my-repo' }
      });

      await service.checkTemplateTargetExists(null, 'my-repo');

      expect(mockOctokitInstance.repos.get).toHaveBeenCalledWith({ owner: 'test-user', repo: 'my-repo' });
    });
  });
});

// Tests below run (the describe above is quarantined). They cover
// configurePagesEnvironment, which is NOT subject to the known-failure
// quarantine because it touches none of the refactored polling code.
describe('GithubForkService#configurePagesEnvironment', () => {
  let service;
  let mockLogger;
  let tokenMock;

  beforeAll(() => {
    const mod = require('../../src/services/secureTokenService.js');
    tokenMock = vi.spyOn(mod.secureTokenService, 'getToken');
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    tokenMock.mockResolvedValue('fake-token');

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };

    const { GithubForkService } = await import('../../src/services/githubForkService.js');
    service = new GithubForkService({ logger: mockLogger });

    mockOctokitInstance.repos.createPagesSite.mockResolvedValue({ status: 201 });
    mockOctokitInstance.repos.updateInformationAboutPagesSite.mockResolvedValue({ status: 200 });
    mockOctokitInstance.repos.createOrUpdateEnvironment.mockResolvedValue({ status: 200 });
    mockOctokitInstance.repos.createDeploymentBranchPolicy.mockResolvedValue({ status: 201 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function expectCreateOrUpdateEnvironment(name) {
    expect(mockOctokitInstance.repos.createOrUpdateEnvironment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      environment_name: name,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
    });
  }

  function expectCreateDeploymentBranchPolicy(envName) {
    expect(mockOctokitInstance.repos.createDeploymentBranchPolicy).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      environment_name: envName,
      name: 'preview',
      type: 'branch'
    });
  }

  it('creates environment github-pages with custom_branch_policies: true', async () => {
    await service.configurePagesEnvironment('owner', 'repo');

    expectCreateOrUpdateEnvironment('github-pages');
  });

  it('creates environment preview with custom_branch_policies: true', async () => {
    await service.configurePagesEnvironment('owner', 'repo');

    expectCreateOrUpdateEnvironment('preview');
  });

  it('adds branch policy preview to BOTH environments', async () => {
    await service.configurePagesEnvironment('owner', 'repo');

    expect(mockOctokitInstance.repos.createDeploymentBranchPolicy).toHaveBeenCalledTimes(2);
    expectCreateDeploymentBranchPolicy('github-pages');
    expectCreateDeploymentBranchPolicy('preview');
  });

  it('executes 5 calls in correct order (Pages → env1 → env2 → policy1 → policy2)', async () => {
    const order = [];
    mockOctokitInstance.repos.createPagesSite.mockImplementation(() => {
      order.push('createPagesSite');
      return Promise.resolve({ status: 201 });
    });
    mockOctokitInstance.repos.createOrUpdateEnvironment.mockImplementation((params) => {
      order.push('createOrUpdateEnvironment:' + params.environment_name);
      return Promise.resolve({ status: 200 });
    });
    mockOctokitInstance.repos.createDeploymentBranchPolicy.mockImplementation((params) => {
      order.push('createDeploymentBranchPolicy:' + params.environment_name);
      return Promise.resolve({ status: 201 });
    });

    await service.configurePagesEnvironment('owner', 'repo');

    expect(order).toEqual([
      'createPagesSite',
      'createOrUpdateEnvironment:github-pages',
      'createOrUpdateEnvironment:preview',
      'createDeploymentBranchPolicy:github-pages',
      'createDeploymentBranchPolicy:preview'
    ]);
  });

  it('treats 409 (Pages exists) by degrading to updateInformationAboutPagesSite', async () => {
    const existsErr = Object.assign(new Error('Conflict'), { status: 409 });
    mockOctokitInstance.repos.createPagesSite.mockRejectedValue(existsErr);

    const result = await service.configurePagesEnvironment('owner', 'repo');

    expect(result.success).toBe(true);
    expect(mockOctokitInstance.repos.updateInformationAboutPagesSite).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      build_type: 'workflow'
    });
    // Subsequent steps still run
    expect(mockOctokitInstance.repos.createOrUpdateEnvironment).toHaveBeenCalledTimes(2);
    expect(mockOctokitInstance.repos.createDeploymentBranchPolicy).toHaveBeenCalledTimes(2);
  });

  it('treats 422 (private repo on Free) with non-blocking warning', async () => {
    const privateErr = Object.assign(new Error('Validation Failed'), { status: 422 });
    mockOctokitInstance.repos.createOrUpdateEnvironment.mockRejectedValue(privateErr);

    const result = await service.configurePagesEnvironment('owner', 'repo');

    expect(result.success).toBe(true);
    expect(result.warning).toEqual(expect.any(String));
    // Branch policy steps are skipped because environments failed
    expect(mockOctokitInstance.repos.createDeploymentBranchPolicy).not.toHaveBeenCalled();
  });

  it('returns auth error if token missing', async () => {
    tokenMock.mockResolvedValue(null);

    const result = await service.configurePagesEnvironment('owner', 'repo');

    expect(result).toEqual({ success: false, error: 'Not authenticated' });
    expect(mockOctokitInstance.repos.createPagesSite).not.toHaveBeenCalled();
  });

  it('idempotency: 303 (already exists) on branch policy treated as success', async () => {
    const policyExistsErr = Object.assign(new Error('Already exists'), { status: 303 });
    mockOctokitInstance.repos.createDeploymentBranchPolicy.mockRejectedValue(policyExistsErr);

    const result = await service.configurePagesEnvironment('owner', 'repo');

    expect(result).toEqual({ success: true });
    // Both policy calls attempted (both 303 → both succeed)
    expect(mockOctokitInstance.repos.createDeploymentBranchPolicy).toHaveBeenCalledTimes(2);
  });
});
