/**
 * @vitest-environment node
 * @fileoverview Security guardrail tests for ProjectCreationHandler.gitClone
 * @author Documental Team
 * @since 1.0.0
 *
 * Verifies that the OAuth token is only injected for github.com URLs
 * and withheld for all other hosts (security guardrail).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const realFs = require('fs');
const realPath = require('path');
const realOs = require('os');
const realChildProcess = require('child_process');

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const {
  mockGitGetRemoteInfo,
  mockGitOps,
  mockElectron,
  mockServiceClone,
  mockServiceCurrentBranch,
  mockServiceCheckout,
  mockServiceListBranches,
  mockServiceRemoteBranches,
} = vi.hoisted(() => ({
  mockGitGetRemoteInfo: vi.fn(),
  mockGitOps: { getGitHubToken: vi.fn() },
  mockElectron: {
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    app: { getPath: vi.fn(() => '/tmp/test') },
  },
  // GitService stub methods (T16): the clone/verify path goes through
  // getGitService() → GitService(dugite); the stub class below routes
  // every call to these spies in the PROVIDER contract shapes.
  mockServiceClone: vi.fn(),
  mockServiceCurrentBranch: vi.fn(),
  mockServiceCheckout: vi.fn(),
  mockServiceListBranches: vi.fn(),
  mockServiceRemoteBranches: vi.fn(),
}));

// ── Module._load monkey-patch for electron, isomorphic-git, GitService
// and execa — vi.mock() does NOT intercept native require() in CJS
// source files. Two seams (T16):
//  1. 'isomorphic-git' still feeds the LIVE pre-clone PROBE
//     (_probeRemoteRefs → getRemoteInfo — mock-visible by design; the
//     probe itself is migrated to dugite ls-remote in T17).
//  2. '../git/GitService.js' (as required by projectCreation.js) is
//     replaced by a stub class routing clone/currentBranch/checkout/
//     listBranches to provider-contract spies.

const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'electron') {
    return mockElectron;
  }
  if (request === 'isomorphic-git') {
    return {
      getRemoteInfo: mockGitGetRemoteInfo,
    };
  }
  if (request === 'isomorphic-git/http/node') {
    return {};
  }
  if (request === '../git/GitService.js') {
    return {
      GitService: class GitService {
        constructor(_opts) {}
        clone(url, dir, opts) { return mockServiceClone(url, dir, opts); }
        currentBranch(dir) { return mockServiceCurrentBranch(dir); }
        checkout(dir, ref, opts) { return mockServiceCheckout(dir, ref, opts); }
        listBranches(dir, opts) {
          return opts && opts.remote
            ? mockServiceRemoteBranches(dir, opts)
            : mockServiceListBranches(dir, opts);
        }
      },
    };
  }
  if (request === 'execa') {
    return { execa: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }) };
  }
  return originalLoad.call(this, request, ...args);
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ProjectCreationHandler.gitClone security guardrail', () => {
  let handler;
  let mockLogger;
  let sendOutput;
  let tmpDir;

  beforeEach(async () => {
    vi.clearAllMocks();

    tmpDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'gitclone-sec-'));
    // Simulate a successful clone: create .git dir + a working-tree file
    // so the post-clone verification (which uses real fs) passes.
    realFs.mkdirSync(realPath.join(tmpDir, '.git'), { recursive: true });
    realFs.writeFileSync(realPath.join(tmpDir, 'package.json'), '{}');

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    sendOutput = vi.fn();
    mockServiceClone.mockResolvedValue(undefined);
    mockServiceListBranches.mockResolvedValue(['main']);
    mockServiceRemoteBranches.mockResolvedValue(['origin/main']);
    mockGitOps.getGitHubToken.mockResolvedValue('ghp_fake_token');
    // Remote reports a "main" branch + HEAD -> main so the probe succeeds
    // immediately and clone proceeds with an explicit ref.
    mockGitGetRemoteInfo.mockResolvedValue({
      capabilities: ['shallow'],
      HEAD: 'main',
      refs: { heads: { main: 'abc123' } },
    });

    // Use Object.create to bypass the constructor (avoids GitOperations /
    // ProcessManager side effects). We only need the prototype method gitClone
    // plus the instance properties it references: logger and gitOps.
    // import() ensures vitest transforms the source so Module._load is active.
    const { ProjectCreationHandler } = await import('../../src/ipc/projectCreation.js');
    handler = Object.create(ProjectCreationHandler.prototype);
    handler.logger = mockLogger;
    handler.gitOps = mockGitOps;
  });

  afterEach(() => {
    if (tmpDir && realFs.existsSync(tmpDir)) {
      realFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Non-GitHub URL: no token, no auth ──────────────────────────────────

  it('does NOT call getGitHubToken for non-GitHub URL and clones with auth: undefined', async () => {
    const url = 'https://evil.com/repo.git';

    await handler.gitClone(url, tmpDir, sendOutput);

    expect(mockGitOps.getGitHubToken).not.toHaveBeenCalled();
    expect(mockServiceClone).toHaveBeenCalledTimes(1);

    // Provider contract: clone(url, dir, opts) — no token, no auth.
    const [cloneUrl, cloneDir, cloneOpts] = mockServiceClone.mock.calls[0];
    expect(cloneUrl).toBe(url);
    expect(cloneDir).toBe(tmpDir);
    expect(cloneOpts.auth).toBeUndefined();
  });

  // ── GitHub URL: token retrieved, auth populated ────────────────────────

  it('calls getGitHubToken for github.com URL and clones with auth in the provider contract', async () => {
    const url = 'https://github.com/foo/bar.git';

    await handler.gitClone(url, tmpDir, sendOutput);

    expect(mockGitOps.getGitHubToken).toHaveBeenCalledTimes(1);
    expect(mockServiceClone).toHaveBeenCalledTimes(1);

    const [cloneUrl, _cloneDir, cloneOpts] = mockServiceClone.mock.calls[0];
    expect(cloneUrl).toBe(url);
    // Provider contract (dugite askpass consumes {token}); the token
    // never appears in the URL or as a raw credential.
    expect(cloneOpts.auth).toEqual({ token: 'ghp_fake_token' });

    // The discovered default branch must be passed as an explicit ref so
    // singleBranch clone does not depend on HEAD symref resolution.
    expect(cloneOpts.ref).toBe('main');
    expect(cloneOpts.singleBranch).toBe(true);
    expect(cloneOpts.depth).toBe(10);
  });

  // ── Case-insensitive host match ────────────────────────────────────────

  it('uses auth for uppercase GITHUB.com URL (case-insensitive regex)', async () => {
    const url = 'https://GITHUB.com/foo/bar.git';

    await handler.gitClone(url, tmpDir, sendOutput);

    expect(mockGitOps.getGitHubToken).toHaveBeenCalledTimes(1);
    expect(mockServiceClone).toHaveBeenCalledTimes(1);

    const [, , cloneOpts] = mockServiceClone.mock.calls[0];
    expect(cloneOpts.auth).toEqual({ token: 'ghp_fake_token' });
  });
});

// ── Regression: empty-clone race (the bug being fixed) ────────────────────
//
// After createFromTemplate, GitHub's REST API reports size > 0 before the
// git smart-HTTP /info/refs endpoint serves any refs. isomorphic-git then
// silently completes a clone with zero branches (line 10181 of its source:
// `if (fetchHead === null) return`). gitClone must probe /info/refs and
// retry until refs appear, then clone with an explicit ref.
describe('ProjectCreationHandler.gitClone empty-clone race regression', () => {
  let handler;
  let mockLogger;
  let sendOutput;
  let tmpDir;

  beforeEach(async () => {
    vi.clearAllMocks();

    tmpDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'gitclone-race-'));
    realFs.mkdirSync(realPath.join(tmpDir, '.git'), { recursive: true });
    realFs.writeFileSync(realPath.join(tmpDir, 'package.json'), '{}');

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    sendOutput = vi.fn();
    mockServiceClone.mockResolvedValue(undefined);
    mockServiceListBranches.mockResolvedValue(['main']);
    mockServiceRemoteBranches.mockResolvedValue(['origin/main']);
    mockGitOps.getGitHubToken.mockResolvedValue('ghp_fake_token');

    const { ProjectCreationHandler } = await import('../../src/ipc/projectCreation.js');
    handler = Object.create(ProjectCreationHandler.prototype);
    handler.logger = mockLogger;
    handler.gitOps = mockGitOps;
  });

  afterEach(() => {
    if (tmpDir && realFs.existsSync(tmpDir)) {
      realFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('retries getRemoteInfo until refs appear, then clones with explicit ref', async () => {
    const url = 'https://github.com/foo/bar.git';

    // First two probes return zero refs (simulating GitHub propagation lag),
    // third probe returns a populated remote.
    mockGitGetRemoteInfo
      .mockResolvedValueOnce({ capabilities: [], refs: {} })
      .mockResolvedValueOnce({ capabilities: [], refs: {} })
      .mockResolvedValueOnce({
        capabilities: ['shallow'],
        HEAD: 'main',
        refs: { heads: { main: 'abc123' } },
      });

    // Speed up the probe backoff by setting probe interval to 10ms.
    // Cannot use vi.useFakeTimers() because gitClone now uses fsPromises
    // (real I/O) in the pre-clone section, which does not resolve under
    // fake timers. Instead we monkey-patch setTimeout to a short delay.
    const origSetTimeout = global.setTimeout;
    global.setTimeout = (fn, _ms, ...args) => origSetTimeout(fn, 10, ...args);
    try {
      await handler.gitClone(url, tmpDir, sendOutput);
    } finally {
      global.setTimeout = origSetTimeout;
    }

    expect(mockGitGetRemoteInfo).toHaveBeenCalledTimes(3);
    expect(mockServiceClone).toHaveBeenCalledTimes(1);
    const [, , cloneOpts] = mockServiceClone.mock.calls[0];
    expect(cloneOpts.ref).toBe('main');
    expect(cloneOpts.singleBranch).toBe(true);
  });

  it('clones even if the probe never sees refs (timeout fallback), then throws on empty result', async () => {
    const url = 'https://github.com/foo/bar.git';

    // Remote never exposes refs — probe always returns null-ish.
    mockGitGetRemoteInfo.mockResolvedValue({ capabilities: [], refs: {} });
    // Simulate the silent empty clone: no .git, no branches, no files.
    // Wipe the seeded state so post-clone verification sees emptiness.
    realFs.rmSync(realPath.join(tmpDir, '.git'), { recursive: true, force: true });
    realFs.rmSync(realPath.join(tmpDir, 'package.json'), { force: true });
    mockServiceListBranches.mockResolvedValue([]);
    mockServiceRemoteBranches.mockResolvedValue([]);

    // Cannot use vi.useFakeTimers() because gitClone now uses fsPromises
    // (real I/O) in the pre-clone section, which does not resolve under
    // fake timers. Instead monkey-patch setTimeout + Date.now so the probe
    // loop fires quickly and the elapsed check quickly exceeds 30s.
    const origSetTimeout = global.setTimeout;
    global.setTimeout = (fn, _ms, ...args) => origSetTimeout(fn, 5, ...args);
    const realStart = Date.now();
    const origDateNow = Date.now;
    let dateOffset = 0;
    Date.now = () => realStart + (dateOffset += 2000);
    try {
      const err = await handler.gitClone(url, tmpDir, sendOutput).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/empty clone|diretório está vazio/i);
    } finally {
      global.setTimeout = origSetTimeout;
      Date.now = origDateNow;
    }

    // Multiple probes happened before giving up...
    expect(mockGitGetRemoteInfo.mock.calls.length).toBeGreaterThanOrEqual(2);
    // ...and clone was still attempted (fallback)...
    expect(mockServiceClone).toHaveBeenCalledTimes(1);
  });
});

// ── _probeRemoteRefs: SHA / undefined HEAD handling ─────────────────────────
//
// After template/fork creation, getRemoteInfo may return info.HEAD as a 40-char
// SHA (commit hash) instead of a branch name due to GitHub propagation lag.
// _probeRemoteRefs must detect and reject SHA values, falling back to the first
// discovered branch. When HEAD is undefined entirely, same fallback applies.
describe('_probeRemoteRefs SHA/undefined HEAD handling', () => {
  let handler;
  let mockLogger;
  const mockHttp = {};
  const testUrl = 'https://github.com/foo/bar.git';
  const auth = { username: 'token', password: 'x-oauth-basic' };
  // _probeRemoteRefs(git, http, url, auth) only consumes git.getRemoteInfo.
  const mockGit = {
    getRemoteInfo: mockGitGetRemoteInfo,
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const { ProjectCreationHandler } = await import('../../src/ipc/projectCreation.js');
    handler = Object.create(ProjectCreationHandler.prototype);
    handler.logger = mockLogger;
    handler.gitOps = mockGitOps;
  });

  it('returns head=main, headSource=top when HEAD is a branch name', async () => {
    mockGitGetRemoteInfo.mockResolvedValue({
      capabilities: ['shallow'],
      HEAD: 'main',
      refs: { heads: { main: 'abc123' } },
    });

    const result = await handler._probeRemoteRefs(mockGit, mockHttp, testUrl, auth);

    expect(result).not.toBeNull();
    expect(result.head).toBe('main');
    expect(result.headSource).toBe('top');
    expect(result.branches).toEqual(['main']);
  });

  it('returns head=first-branch, headSource=sha-rejected when HEAD is a 40-char SHA', async () => {
    const sha = 'abc123def456abc789def012abc345def678abcd';
    mockGitGetRemoteInfo.mockResolvedValue({
      capabilities: ['shallow'],
      HEAD: sha,
      refs: { heads: { main: 'abc123' } },
    });

    const result = await handler._probeRemoteRefs(mockGit, mockHttp, testUrl, auth);

    expect(result).not.toBeNull();
    expect(result.head).toBe('main');
    expect(result.headSource).toBe('first-branch');
    expect(result.branches).toEqual(['main']);
  });

  it('returns head=first-branch, headSource=first-branch when HEAD is undefined but branches exist', async () => {
    mockGitGetRemoteInfo.mockResolvedValue({
      capabilities: ['shallow'],
      refs: { heads: { main: 'abc123' } },
    });

    const result = await handler._probeRemoteRefs(mockGit, mockHttp, testUrl, auth);

    expect(result).not.toBeNull();
    expect(result.head).toBe('main');
    expect(result.headSource).toBe('first-branch');
    expect(result.branches).toEqual(['main']);
  });

  it('returns null when HEAD is undefined/SHA and NO branches exist', async () => {
    mockGitGetRemoteInfo.mockResolvedValue({
      capabilities: [],
      refs: { heads: {} },
    });

    const result = await handler._probeRemoteRefs(mockGit, mockHttp, testUrl, auth);

    expect(result).toBeNull();
  });

  it('returns null when getRemoteInfo throws', async () => {
    mockGitGetRemoteInfo.mockRejectedValue(new Error('network error'));

    const result = await handler._probeRemoteRefs(mockGit, mockHttp, testUrl, auth);

    expect(result).toBeNull();
  });
});

// ── gitClone: branch mismatch retry ─────────────────────────────────────────
//
// After clone completes, gitClone verifies that the local branch matches the
// expected branch (derived from remote Info). If the branch differs (e.g. got
// "master" instead of "main"), gitClone cleans the directory and retries up
// to 3 total attempts.
describe('ProjectCreationHandler.gitClone branch mismatch retry', () => {
  let handler;
  let mockLogger;
  let sendOutput;
  let tmpDir;

  beforeEach(async () => {
    vi.clearAllMocks();

    tmpDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'gitclone-retry-'));
    // Seed a fresh-looking empty dir (no .git, so pre-clone helpers see an empty dir)
    realFs.mkdirSync(realPath.join(tmpDir, '.git'), { recursive: true });
    realFs.writeFileSync(realPath.join(tmpDir, 'package.json'), '{}');

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    sendOutput = vi.fn();
    mockServiceClone.mockResolvedValue(undefined);
    mockServiceListBranches.mockResolvedValue(['main']);
    mockServiceRemoteBranches.mockResolvedValue(['origin/main']);
    mockGitOps.getGitHubToken.mockResolvedValue('ghp_fake_token');
    // Remote has HEAD -> main but we'll mock listBranches to return wrong branch
    mockGitGetRemoteInfo.mockResolvedValue({
      capabilities: ['shallow'],
      HEAD: 'main',
      refs: { heads: { main: 'abc123' } },
    });

    const { ProjectCreationHandler } = await import('../../src/ipc/projectCreation.js');
    handler = Object.create(ProjectCreationHandler.prototype);
    handler.logger = mockLogger;
    handler.gitOps = mockGitOps;
  });

  afterEach(() => {
    if (tmpDir && realFs.existsSync(tmpDir)) {
      realFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('succeeds on first attempt when branch matches expectation', async () => {
    const url = 'https://github.com/foo/bar.git';
    mockServiceListBranches.mockResolvedValue(['main']);

    const result = await handler.gitClone(url, tmpDir, sendOutput);

    expect(result).toBe(true);
    expect(mockServiceClone).toHaveBeenCalledTimes(1);
  });

  it('retries up to 3 times when branch does not match, then throws', async () => {
    const url = 'https://github.com/foo/bar.git';
    // Prevent rm -rf via execSync from actually destroying the temp dir
    const execSpy = vi.spyOn(realChildProcess, 'execSync').mockReturnValue(Buffer.from(''));
    mockServiceListBranches.mockResolvedValue(['master']);

    await expect(handler.gitClone(url, tmpDir, sendOutput)).rejects.toThrow(
      /Clone falhou após 3 tentativas.*main.*master/
    );

    expect(mockServiceClone).toHaveBeenCalledTimes(3);
    execSpy.mockRestore();
  });

  it('succeeds after retry when second attempt produces correct branch', async () => {
    const url = 'https://github.com/foo/bar.git';
    const execSpy = vi.spyOn(realChildProcess, 'execSync').mockReturnValue(Buffer.from(''));
    mockServiceListBranches.mockReset()
      .mockResolvedValueOnce(['master'])
      .mockResolvedValueOnce(['main'])
      .mockResolvedValue(['main']);

    const result = await handler.gitClone(url, tmpDir, sendOutput);

    expect(result).toBe(true);
    expect(mockServiceClone).toHaveBeenCalledTimes(2);
    execSpy.mockRestore();
  });
});

// ── gitClone: pre-clone residual file cleanup ──────────────────────────────
//
// When a previous failed clone attempt left stale working-tree files, gitClone
// must remove them (retaining .git) before the next clone attempt.
// must remove them (retaining .git) before the next clone attempt.
describe('ProjectCreationHandler.gitClone pre-clone cleanup', () => {
  let handler;
  let mockLogger;
  let sendOutput;
  let tmpDir;

  beforeEach(async () => {
    vi.clearAllMocks();

    tmpDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'gitclone-clean-'));
    realFs.mkdirSync(realPath.join(tmpDir, '.git'), { recursive: true });
    realFs.writeFileSync(realPath.join(tmpDir, 'stale-config.json'), '{"prev": true}');
    realFs.writeFileSync(realPath.join(tmpDir, 'stale-output.log'), 'previous run log');
    realFs.mkdirSync(realPath.join(tmpDir, 'node_modules'), { recursive: true });
    realFs.writeFileSync(realPath.join(tmpDir, 'node_modules', 'dep.js'), 'stale');

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    sendOutput = vi.fn();
    mockServiceClone.mockResolvedValue(undefined);
    mockServiceListBranches.mockResolvedValue(['main']);
    mockServiceRemoteBranches.mockResolvedValue(['origin/main']);
    mockGitOps.getGitHubToken.mockResolvedValue('ghp_fake_token');
    mockGitGetRemoteInfo.mockResolvedValue({
      capabilities: ['shallow'],
      HEAD: 'main',
      refs: { heads: { main: 'abc123' } },
    });

    const { ProjectCreationHandler } = await import('../../src/ipc/projectCreation.js');
    handler = Object.create(ProjectCreationHandler.prototype);
    handler.logger = mockLogger;
    handler.gitOps = mockGitOps;
  });

  afterEach(() => {
    if (tmpDir && realFs.existsSync(tmpDir)) {
      realFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('removes residual files before clone, preserving .git', async () => {
    const url = 'https://github.com/foo/bar.git';

    expect(realFs.existsSync(realPath.join(tmpDir, 'stale-config.json'))).toBe(true);
    expect(realFs.existsSync(realPath.join(tmpDir, 'stale-output.log'))).toBe(true);
    expect(realFs.existsSync(realPath.join(tmpDir, 'node_modules', 'dep.js'))).toBe(true);
    expect(realFs.existsSync(realPath.join(tmpDir, '.git'))).toBe(true);

    await handler.gitClone(url, tmpDir, sendOutput);

    expect(realFs.existsSync(realPath.join(tmpDir, '.git'))).toBe(true);
  });
});
