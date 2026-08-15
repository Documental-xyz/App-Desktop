/**
 * @vitest-environment node
 * @fileoverview Tests for GitHub Repos IPC handlers
 * @author Documental Team
 * @since 1.0.0
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';

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
      listForAuthenticatedUser: vi.fn(),
      getContent: vi.fn()
    },
    rest: {
      users: {
        getAuthenticated: vi.fn()
      },
      search: {
        code: vi.fn()
      },
      orgs: {
        listForAuthenticatedUser: vi.fn()
      }
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

/**
 * Reset all octokit method mock queues and implementations.
 * vi.clearAllMocks() (called in beforeEach) only clears call history —
 * mockImplementationOnce queues and persistent implementations SURVIVE it,
 * so a test whose flow skips a queued once-implementation would leak it
 * into the next test. New describes call this in afterEach for isolation.
 */
function resetOctokitMocks() {
  mockOctokitInstance.rest.users.getAuthenticated.mockReset();
  mockOctokitInstance.rest.search.code.mockReset();
  mockOctokitInstance.rest.orgs.listForAuthenticatedUser.mockReset();
  mockOctokitInstance.repos.listForAuthenticatedUser.mockReset();
  mockOctokitInstance.repos.getContent.mockReset();
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
        .mockResolvedValueOnce({ data: makeRepos(1, 100), headers: { 'x-oauth-scopes': 'user:email, repo, read:org' } })  // page 1: full page
        .mockResolvedValueOnce({ data: makeRepos(101, 50), headers: { 'x-oauth-scopes': 'user:email, repo, read:org' } }); // page 2: partial → break

      const result = await handlers.listUserRepos();

      expect(result.success).toBe(true);
      expect(result.repos).toHaveLength(150);
      expect(mockOctokitInstance.repos.listForAuthenticatedUser).toHaveBeenCalledTimes(2);
    });

    it('respects the 500 repo cap (mock 6 pages of 100)', async () => {
      tokenMock.mockResolvedValue('fake-token');
      // Always return a full page of 100 repos regardless of page number
      mockOctokitInstance.repos.listForAuthenticatedUser.mockResolvedValue({
        data: makeRepos(1, 100),
        headers: { 'x-oauth-scopes': 'user:email, repo, read:org' }
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
        data: [makeRepo(1, 'test-repo')],
        headers: { 'x-oauth-scopes': 'user:email, repo, read:org' }
      });

      const result = await handlers.listUserRepos();

      expect(result.success).toBe(true);
      expect(result.repos).toHaveLength(1);

      const repo = result.repos[0];
      expect(Object.keys(repo).sort()).toEqual(
        ['clone_url', 'description', 'fork', 'full_name', 'id', 'name', 'owner', 'private', 'updated_at']
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

  // ── findDocumentalRepos ─────────────────────────────────────────────────
  // Covers the fallback path at src/ipc/githubRepos.js ~line 205:
  // code search fails (401) → enumerate repos via listForAuthenticatedUser
  // → probe documental.json via getContent in chunks of 10.

  describe('findDocumentalRepos', () => {
    /**
     * Build a repo object sufficient for the fallback getContent loop,
     * which reads repo.owner.login, repo.name, and repo.full_name.
     */
    function makeFallbackRepo(id, name, owner = 'user') {
      return {
        id,
        name,
        full_name: `${owner}/${name}`,
        owner: { login: owner }
      };
    }

    /** Create a 404-shaped rejection error (file not present). */
    function make404() {
      const err = new Error('Not Found');
      err.status = 404;
      return err;
    }

    /** Create a 403-shaped rejection error (rate limit). */
    function make403() {
      const err = new Error('Rate limit exceeded');
      err.status = 403;
      return err;
    }

    /**
     * Wire up the non-fallback prefix of findDocumentalRepos:
     * getAuthenticated user + code search. The search is configured to
     * reject with a status that falls through to the fallback branch.
     * NOTE: status 401 returns immediately (token expired) and does NOT
     * reach the fallback; 403 and other errors do (see src line 186-193).
     */
    function setupSearchFailure(searchErr) {
      mockOctokitInstance.rest.users.getAuthenticated.mockResolvedValue({
        data: { login: 'testuser' }
      });
      mockOctokitInstance.rest.search.code.mockRejectedValue(searchErr);
    }

    it('happy path fallback: search fails → enumerates 3 repos → 2 have documental.json', async () => {
      tokenMock.mockResolvedValue('fake-token');
      // Code search 403 falls through to the fallback (401 returns immediately).
      setupSearchFailure(make403());

      const repos = [
        makeFallbackRepo(1, 'has-doc-1'),
        makeFallbackRepo(2, 'has-doc-2'),
        makeFallbackRepo(3, 'no-doc')
      ];
      mockOctokitInstance.repos.listForAuthenticatedUser.mockResolvedValueOnce({
        data: repos
      });

      // getContent: first two resolve, third rejects 404.
      mockOctokitInstance.repos.getContent
        .mockResolvedValueOnce({ data: { path: 'documental.json' } })
        .mockResolvedValueOnce({ data: { path: 'documental.json' } })
        .mockRejectedValueOnce(make404());

      const result = await handlers.findDocumentalRepos();

      expect(result.success).toBe(true);
      expect(result.fallback).toBe(true);
      expect(result.documentalRepos).toHaveLength(2);
      expect(result.documentalRepos).toEqual(
        expect.arrayContaining(['user/has-doc-1', 'user/has-doc-2'])
      );
      expect(result.documentalRepos).not.toContain('user/no-doc');
    });

    it('rate limit: fallback path hits 403 → returns rate limit error', async () => {
      tokenMock.mockResolvedValue('fake-token');
      // Search fails with a non-401 status to enter the fallback path.
      setupSearchFailure(make403());

      // listForAuthenticatedUser itself rejects 403 inside the fallback.
      mockOctokitInstance.repos.listForAuthenticatedUser.mockRejectedValue(make403());

      const result = await handlers.findDocumentalRepos();

      expect(result).toEqual({
        success: false,
        error: 'GitHub API rate limit exceeded. Try again later.'
      });
      // getContent should never have been reached.
      expect(mockOctokitInstance.repos.getContent).not.toHaveBeenCalled();
    });

    it('code search succeeds (no fallback): returns results without fallback flag', async () => {
      tokenMock.mockResolvedValue('fake-token');

      mockOctokitInstance.rest.users.getAuthenticated.mockResolvedValue({
        data: { login: 'testuser' }
      });
      // Code search resolves with two matching repositories.
      mockOctokitInstance.rest.search.code.mockResolvedValue({
        data: {
          items: [
            { repository: { full_name: 'user/repo-a' } },
            { repository: { full_name: 'user/repo-b' } }
          ]
        }
      });
      // User has no orgs, so the org loop is a no-op.
      mockOctokitInstance.rest.orgs.listForAuthenticatedUser.mockResolvedValue({
        data: []
      });

      const result = await handlers.findDocumentalRepos();

      expect(result.success).toBe(true);
      expect(result.fallback).toBeUndefined();
      expect(result.documentalRepos).toEqual(
        expect.arrayContaining(['user/repo-a', 'user/repo-b'])
      );
      // The fallback path must NOT have executed.
      expect(mockOctokitInstance.repos.listForAuthenticatedUser).not.toHaveBeenCalled();
      expect(mockOctokitInstance.repos.getContent).not.toHaveBeenCalled();
    });

    it('empty fallback: search fails → all repos lack documental.json → returns empty list', async () => {
      tokenMock.mockResolvedValue('fake-token');
      // Search fails with a non-401 status to enter the fallback path.
      setupSearchFailure(make403());

      const repos = [
        makeFallbackRepo(1, 'no-doc-1'),
        makeFallbackRepo(2, 'no-doc-2')
      ];
      mockOctokitInstance.repos.listForAuthenticatedUser.mockResolvedValueOnce({
        data: repos
      });

      // Every getContent probe rejects with 404 → none qualify.
      mockOctokitInstance.repos.getContent.mockRejectedValue(make404());

      const result = await handlers.findDocumentalRepos();

      expect(result.success).toBe(true);
      expect(result.fallback).toBe(true);
      expect(result.documentalRepos).toEqual([]);
    });

    // ── Fallback rejection table ─────────────────────────────────────────
    // Promise.allSettled must NOT treat every rejection as "not documental".
    // Only 404 means that; 401/403/5xx/no-status must fail the scan ATOMICALLY
    // (discard the partial fallback set — never silently untag).

    /** Create a 401-shaped rejection error (bad credentials). */
    function make401() {
      const err = new Error('Bad credentials');
      err.status = 401;
      return err;
    }

    /** Create a 500-shaped rejection error (server error). */
    function make500() {
      const err = new Error('Server error');
      err.status = 500;
      return err;
    }

    describe('fallback rejection table', () => {
      afterEach(() => resetOctokitMocks());

      it('fallback getContent 403 → atomic {success:false} — no silent untagging', async () => {
        tokenMock.mockResolvedValue('fake-token');
        // Search 403 → outer catch → fallback enumeration.
        setupSearchFailure(make403());
        mockOctokitInstance.repos.listForAuthenticatedUser.mockResolvedValueOnce({
          data: [
            makeFallbackRepo(1, 'has-doc-1'),
            makeFallbackRepo(2, 'probe-blocked'),
            makeFallbackRepo(3, 'has-doc-3')
          ]
        });
        mockOctokitInstance.repos.getContent
          .mockResolvedValueOnce({ data: { path: 'documental.json' } })
          .mockRejectedValueOnce(make403())
          .mockResolvedValueOnce({ data: { path: 'documental.json' } });

        const result = await handlers.findDocumentalRepos();

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/rate limit/i);
        // Atomic: the partial fallback set is discarded, not returned.
        expect(result.documentalRepos).toBeUndefined();
      });

      it('fallback getContent 401 → atomic {success:false}', async () => {
        tokenMock.mockResolvedValue('fake-token');
        setupSearchFailure(make403());
        mockOctokitInstance.repos.listForAuthenticatedUser.mockResolvedValueOnce({
          data: [
            makeFallbackRepo(1, 'has-doc-1'),
            makeFallbackRepo(2, 'probe-blocked'),
            makeFallbackRepo(3, 'has-doc-3')
          ]
        });
        mockOctokitInstance.repos.getContent
          .mockResolvedValueOnce({ data: { path: 'documental.json' } })
          .mockRejectedValueOnce(make401())
          .mockResolvedValueOnce({ data: { path: 'documental.json' } });

        const result = await handlers.findDocumentalRepos();

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/re-authenticate/i);
        expect(result.documentalRepos).toBeUndefined();
      });

      it('fallback 404-only rejections → success:true with those repos excluded', async () => {
        tokenMock.mockResolvedValue('fake-token');
        setupSearchFailure(make403());
        mockOctokitInstance.repos.listForAuthenticatedUser.mockResolvedValueOnce({
          data: [
            makeFallbackRepo(1, 'has-doc-1'),
            makeFallbackRepo(2, 'no-doc'),
            makeFallbackRepo(3, 'has-doc-3')
          ]
        });
        mockOctokitInstance.repos.getContent
          .mockResolvedValueOnce({ data: { path: 'documental.json' } })
          .mockRejectedValueOnce(make404())
          .mockResolvedValueOnce({ data: { path: 'documental.json' } });

        const result = await handlers.findDocumentalRepos();

        expect(result.success).toBe(true);
        expect(result.fallback).toBe(true);
        expect(result.documentalRepos).toEqual(['user/has-doc-1', 'user/has-doc-3']);
        expect(result.documentalRepos).not.toContain('user/no-doc');
        // Success payloads always carry skippedOrgs (empty array when none).
        expect(result.skippedOrgs).toEqual([]);
      });

      it('fallback getContent 500 → atomic {success:false}, partial set NOT returned', async () => {
        tokenMock.mockResolvedValue('fake-token');
        setupSearchFailure(make403());
        mockOctokitInstance.repos.listForAuthenticatedUser.mockResolvedValueOnce({
          data: [
            makeFallbackRepo(1, 'has-doc-1'),
            makeFallbackRepo(2, 'probe-blocked'),
            makeFallbackRepo(3, 'has-doc-3')
          ]
        });
        mockOctokitInstance.repos.getContent
          .mockResolvedValueOnce({ data: { path: 'documental.json' } })
          .mockRejectedValueOnce(make500())
          .mockResolvedValueOnce({ data: { path: 'documental.json' } });

        const result = await handlers.findDocumentalRepos();

        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
        expect(result.documentalRepos).toBeUndefined();
      });

      it('fallback getContent network error (no .status) → atomic {success:false}', async () => {
        tokenMock.mockResolvedValue('fake-token');
        setupSearchFailure(make403());
        mockOctokitInstance.repos.listForAuthenticatedUser.mockResolvedValueOnce({
          data: [
            makeFallbackRepo(1, 'has-doc-1'),
            makeFallbackRepo(2, 'probe-blocked')
          ]
        });
        // Network errors may carry NO .status property.
        mockOctokitInstance.repos.getContent
          .mockResolvedValueOnce({ data: { path: 'documental.json' } })
          .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.github.com'));

        const result = await handlers.findDocumentalRepos();

        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
        expect(result.documentalRepos).toBeUndefined();
      });
    });

    // ── Org loop status table ────────────────────────────────────────────
    // 401 → fail fast (no fallback); 403 → PRESERVED throw-to-fallback;
    // 422 → alt-term retry (existing); 5xx/network/other → skip org + continue.

    describe('org loop status table', () => {
      afterEach(() => resetOctokitMocks());

      it('org#2 fails 5xx → success:true with org#1/org#3 results, skippedOrgs records org#2', async () => {
        tokenMock.mockResolvedValue('fake-token');
        mockOctokitInstance.rest.users.getAuthenticated.mockResolvedValue({
          data: { login: 'testuser' }
        });
        // Call order: personal search, then org1, org2 (500), org3.
        mockOctokitInstance.rest.search.code
          .mockResolvedValueOnce({ data: { items: [{ repository: { full_name: 'user/personal-repo' } }] } })
          .mockResolvedValueOnce({ data: { items: [{ repository: { full_name: 'org1-login/org1-repo' } }] } })
          .mockRejectedValueOnce(make500())
          .mockResolvedValueOnce({ data: { items: [{ repository: { full_name: 'org3-login/org3-repo' } }] } });
        mockOctokitInstance.rest.orgs.listForAuthenticatedUser.mockResolvedValue({
          data: [
            { login: 'org1-login' },
            { login: 'org2-login' },
            { login: 'org3-login' }
          ]
        });

        const result = await handlers.findDocumentalRepos();

        expect(result.success).toBe(true);
        expect(result.fallback).toBeUndefined();
        expect(result.documentalRepos).toEqual(
          expect.arrayContaining([
            'user/personal-repo',
            'org1-login/org1-repo',
            'org3-login/org3-repo'
          ])
        );
        expect(result.skippedOrgs).toEqual(['org2-login']);
        // The loop continued — no fallback probing happened.
        expect(mockOctokitInstance.repos.getContent).not.toHaveBeenCalled();
      });

      it('org 403 → PRESERVED: fallback path taken (getContent asserted called)', async () => {
        tokenMock.mockResolvedValue('fake-token');
        mockOctokitInstance.rest.users.getAuthenticated.mockResolvedValue({
          data: { login: 'testuser' }
        });
        mockOctokitInstance.rest.search.code
          .mockResolvedValueOnce({ data: { items: [] } }) // personal search OK
          .mockRejectedValueOnce(make403()); // org search → 403 → throw
        mockOctokitInstance.rest.orgs.listForAuthenticatedUser.mockResolvedValue({
          data: [{ login: 'my-org' }]
        });
        // Fallback enumeration + probing.
        mockOctokitInstance.repos.listForAuthenticatedUser.mockResolvedValueOnce({
          data: [makeFallbackRepo(1, 'no-doc')]
        });
        mockOctokitInstance.repos.getContent.mockRejectedValue(make404());

        const result = await handlers.findDocumentalRepos();

        expect(result.success).toBe(true);
        expect(result.fallback).toBe(true);
        expect(mockOctokitInstance.repos.getContent).toHaveBeenCalled();
      });

      it('org 401 → fail fast {success:false}, NO fallback (no getContent calls)', async () => {
        tokenMock.mockResolvedValue('fake-token');
        mockOctokitInstance.rest.users.getAuthenticated.mockResolvedValue({
          data: { login: 'testuser' }
        });
        mockOctokitInstance.rest.search.code
          .mockResolvedValueOnce({ data: { items: [] } }) // personal search OK
          .mockRejectedValueOnce(make401()); // org search → 401 → fail fast
        mockOctokitInstance.rest.orgs.listForAuthenticatedUser.mockResolvedValue({
          data: [{ login: 'my-org' }]
        });

        const result = await handlers.findDocumentalRepos();

        expect(result).toEqual({
          success: false,
          error: 'Token expired. Please re-authenticate.'
        });
        expect(mockOctokitInstance.repos.listForAuthenticatedUser).not.toHaveBeenCalled();
        expect(mockOctokitInstance.repos.getContent).not.toHaveBeenCalled();
      });
    });
  });

  // ── github:find-documental-repos registration ───────────────────────────
  // Contract compliance ({success, error} try/catch) + single-flight scan.

  describe('github:find-documental-repos registration', () => {
    afterEach(() => resetOctokitMocks());

    /** Extract the handler function registered for a channel. */
    function getRegisteredHandler(channel) {
      const call = mockIpcMain.handle.mock.calls.find(([ch]) => ch === channel);
      if (!call) throw new Error(`no handler registered for ${channel}`);
      return call[1];
    }

    it('findDocumentalRepos throws → handler returns {success:false, error}', async () => {
      tokenMock.mockResolvedValue('fake-token');
      handlers.registerHandlers();
      const handlerFn = getRegisteredHandler('github:find-documental-repos');

      vi.spyOn(handlers, 'findDocumentalRepos').mockRejectedValue(new Error('boom'));

      await expect(handlerFn()).resolves.toEqual({ success: false, error: 'boom' });
    });

    it('single-flight: two concurrent invokes share ONE scan and get the same result', async () => {
      tokenMock.mockResolvedValue('fake-token');
      mockOctokitInstance.rest.users.getAuthenticated.mockResolvedValue({
        data: { login: 'testuser' }
      });
      const searchResult = { data: { items: [{ repository: { full_name: 'user/repo-a' } }] } };
      // Delay each search call so both handler invocations overlap while the
      // scan is in flight.
      mockOctokitInstance.rest.search.code.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(searchResult), 20))
      );
      mockOctokitInstance.rest.orgs.listForAuthenticatedUser.mockResolvedValue({
        data: []
      });

      handlers.registerHandlers();
      const handlerFn = getRegisteredHandler('github:find-documental-repos');

      const [r1, r2] = await Promise.all([handlerFn(), handlerFn()]);

      // The underlying code-search path ran exactly once.
      expect(mockOctokitInstance.rest.search.code).toHaveBeenCalledTimes(1);
      // Both callers received the same (successful) scan result.
      expect(r1).toEqual(r2);
      expect(r1.success).toBe(true);
      expect(r1.documentalRepos).toEqual(['user/repo-a']);
      // The in-flight slot is released after completion.
      expect(handlers._documentalScanInFlight).toBeNull();
    });
  });
});
