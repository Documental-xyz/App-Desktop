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
  mockGitClone,
  mockGitGetRemoteInfo,
  mockGitListBranches,
  mockGitOps,
  mockElectron,
} = vi.hoisted(() => ({
  mockGitClone: vi.fn(),
  mockGitGetRemoteInfo: vi.fn(),
  mockGitListBranches: vi.fn(),
  mockGitOps: { getGitHubToken: vi.fn() },
  mockElectron: {
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    app: { getPath: vi.fn(() => '/tmp/test') },
  },
}));

// ── Module._load monkey-patch for electron and isomorphic-git ──────────────
// vi.mock() does NOT intercept native require() in CJS source files.
// We patch Module._load to ensure mocks are returned for these dependencies.

const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'electron') {
    return mockElectron;
  }
  if (request === 'isomorphic-git') {
    return {
      clone: mockGitClone,
      getRemoteInfo: mockGitGetRemoteInfo,
      listBranches: mockGitListBranches,
    };
  }
  if (request === 'isomorphic-git/http/node') {
    return {};
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
    mockGitClone.mockResolvedValue(undefined);
    mockGitOps.getGitHubToken.mockResolvedValue('ghp_fake_token');
    // Remote reports a "main" branch + HEAD -> main so the probe succeeds
    // immediately and clone proceeds with an explicit ref.
    mockGitGetRemoteInfo.mockResolvedValue({
      capabilities: ['shallow'],
      HEAD: 'main',
      refs: { heads: { main: 'abc123' } },
    });
    // listBranches runs after clone; return ['main'] so post-clone
    // verification sees a populated repo and does not throw.
    mockGitListBranches.mockResolvedValue(['main']);

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
    expect(mockGitClone).toHaveBeenCalledTimes(1);

    const callArg = mockGitClone.mock.calls[0][0];
    expect(callArg.url).toBe(url);
    // onAuth callback must yield undefined (no credentials) for non-GitHub URLs
    expect(callArg.onAuth()).toBeUndefined();
    expect(callArg.auth).toBeUndefined();
  });

  // ── GitHub URL: token retrieved, auth populated via onAuth ─────────────

  it('calls getGitHubToken for github.com URL and clones with auth populated via onAuth', async () => {
    const url = 'https://github.com/foo/bar.git';

    await handler.gitClone(url, tmpDir, sendOutput);

    expect(mockGitOps.getGitHubToken).toHaveBeenCalledTimes(1);
    expect(mockGitClone).toHaveBeenCalledTimes(1);

    const callArg = mockGitClone.mock.calls[0][0];
    expect(callArg.url).toBe(url);
    // The token must be delivered through the onAuth callback, never as a
    // top-level `auth` property (isomorphic-git only honors onAuth).
    expect(callArg.onAuth()).toEqual({
      username: 'ghp_fake_token',
      password: 'x-oauth-basic',
    });
    expect(callArg.auth).toBeUndefined();

    // The discovered default branch must be passed as an explicit ref so
    // singleBranch clone does not depend on HEAD symref resolution.
    expect(callArg.ref).toBe('main');
  });

  // ── Case-insensitive host match ────────────────────────────────────────

  it('uses auth for uppercase GITHUB.com URL (case-insensitive regex)', async () => {
    const url = 'https://GITHUB.com/foo/bar.git';

    await handler.gitClone(url, tmpDir, sendOutput);

    expect(mockGitOps.getGitHubToken).toHaveBeenCalledTimes(1);
    expect(mockGitClone).toHaveBeenCalledTimes(1);

    const callArg = mockGitClone.mock.calls[0][0];
    expect(callArg.onAuth()).toEqual({
      username: 'ghp_fake_token',
      password: 'x-oauth-basic',
    });
    expect(callArg.auth).toBeUndefined();
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
    mockGitClone.mockResolvedValue(undefined);
    mockGitOps.getGitHubToken.mockResolvedValue('ghp_fake_token');
    mockGitListBranches.mockResolvedValue(['main']);

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
    const realSetTimeout = setTimeout;

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

    // Speed up the probe backoff so the test doesn't wait 4 real seconds.
    vi.useFakeTimers();
    try {
      const promise = handler.gitClone(url, tmpDir, sendOutput);
      // Attach handlers synchronously to avoid unhandled rejection warnings.
      const assertion = promise.then(
        (v) => v,
        (e) => { throw e; },
      );
      // Advance past the two 2000ms probe intervals.
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    expect(mockGitGetRemoteInfo).toHaveBeenCalledTimes(3);
    expect(mockGitClone).toHaveBeenCalledTimes(1);
    const callArg = mockGitClone.mock.calls[0][0];
    expect(callArg.ref).toBe('main');
    expect(callArg.singleBranch).toBe(true);
  });

  it('clones even if the probe never sees refs (timeout fallback), then throws on empty result', async () => {
    const url = 'https://github.com/foo/bar.git';

    // Remote never exposes refs — probe always returns null-ish.
    mockGitGetRemoteInfo.mockResolvedValue({ capabilities: [], refs: {} });
    // Simulate the silent empty clone: no .git, no branches, no files.
    // Wipe the seeded state so post-clone verification sees emptiness.
    realFs.rmSync(realPath.join(tmpDir, '.git'), { recursive: true, force: true });
    realFs.rmSync(realPath.join(tmpDir, 'package.json'), { force: true });
    mockGitListBranches.mockResolvedValue([]);

    // Shrink the probe timeout via fake timers so we don't wait 30s.
    vi.useFakeTimers();
    try {
      const promise = handler.gitClone(url, tmpDir, sendOutput);
      // Attach rejection handler synchronously to avoid unhandled rejection.
      const assertion = promise.catch((err) => err);
      // Advance well beyond the 30s probe timeout.
      await vi.advanceTimersByTimeAsync(31000);
      const err = await assertion;
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/empty clone|diretório está vazio/i);
    } finally {
      vi.useRealTimers();
    }

    // Multiple probes happened before giving up...
    expect(mockGitGetRemoteInfo.mock.calls.length).toBeGreaterThanOrEqual(2);
    // ...and clone was still attempted (fallback)...
    expect(mockGitClone).toHaveBeenCalledTimes(1);
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
  const mockGit = {
    getRemoteInfo: mockGitGetRemoteInfo,
    clone: mockGitClone,
    listBranches: mockGitListBranches,
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
    mockGitClone.mockResolvedValue(undefined);
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
    mockGitListBranches.mockResolvedValue(['main']);

    const result = await handler.gitClone(url, tmpDir, sendOutput);

    expect(result).toBe(true);
    expect(mockGitClone).toHaveBeenCalledTimes(1);
  });

  it('retries up to 3 times when branch does not match, then throws', async () => {
    const url = 'https://github.com/foo/bar.git';
    // Prevent rm -rf via execSync from actually destroying the temp dir
    const execSpy = vi.spyOn(realChildProcess, 'execSync').mockReturnValue(Buffer.from(''));
    mockGitListBranches.mockResolvedValue(['master']);

    await expect(handler.gitClone(url, tmpDir, sendOutput)).rejects.toThrow(
      /Clone falhou após 3 tentativas.*main.*master/
    );

    expect(mockGitClone).toHaveBeenCalledTimes(3);
    execSpy.mockRestore();
  });

  it('succeeds after retry when second attempt produces correct branch', async () => {
    const url = 'https://github.com/foo/bar.git';
    const execSpy = vi.spyOn(realChildProcess, 'execSync').mockReturnValue(Buffer.from(''));
    mockGitListBranches.mockReset()
      .mockResolvedValueOnce(['master'])
      .mockResolvedValueOnce(['main'])
      .mockResolvedValue(['main']);

    const result = await handler.gitClone(url, tmpDir, sendOutput);

    expect(result).toBe(true);
    expect(mockGitClone).toHaveBeenCalledTimes(2);
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
    mockGitClone.mockResolvedValue(undefined);
    mockGitOps.getGitHubToken.mockResolvedValue('ghp_fake_token');
    mockGitGetRemoteInfo.mockResolvedValue({
      capabilities: ['shallow'],
      HEAD: 'main',
      refs: { heads: { main: 'abc123' } },
    });
    mockGitListBranches.mockResolvedValue(['main']);

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
