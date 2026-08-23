/**
 * @fileoverview Regression tests for GitOperations.gitCheckoutBranch.
 *
 * Focus: the "remote branch exists, local does not" path must create the
 * local branch pointing to the SAME SHA as origin/<branch> (via the
 * isomorphic-git `object` parameter) and set up tracking config.
 *
 * Uses REAL isomorphic-git against a temp filesystem fixture (no mocks
 * for git/fs/path), so the SHA equality is genuinely verified.
 *
 * @author Documental Team
 * @since 1.0.0
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// These modules are globally mocked by tests/setup.js. We need the REAL
// implementations to build a genuine fixture and verify real SHAs.
vi.unmock('fs');
vi.unmock('path');
vi.unmock('isomorphic-git');

// secureTokenService is pulled in at require-time by gitOperations.js
// and reads electron safeStorage/app; stub it out so the require doesn't
// touch the global electron mock unexpectedly.
vi.mock('../../src/services/secureTokenService.js', () => ({
  secureTokenService: { getToken: vi.fn(), setToken: vi.fn(), deleteToken: vi.fn() },
}));

const git = require('isomorphic-git');
const realListBranches = git.listBranches;
const realFs = require('fs');
const fsp = realFs.promises;
const path = require('path');
const os = require('os');

const { GitOperations } = require('../../src/ipc/gitOperations.js');

// ─── Fixture helpers ───────────────────────────────────────────────────────

let tmpRoot;
let localDir; // the repo gitCheckoutBranch runs in

/**
 * Recursively remove a directory (rm -rf), tolerant of missing paths.
 * @param {string} p - Path to remove.
 */
async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

/**
 * Build a local repo that looks like a fresh clone of a remote with two
 * branches: `main` (checked out) and `preview` (only present as a remote
 * tracking ref, so the "remote-only" code path is exercised).
 *
 * We avoid isomorphic-git network transports (file:// is unsupported) by
 * constructing the repo directly: commit history first, then simulate the
 * clone by adding origin tracking refs via writeRef and deleting the local
 * preview branch. The preview SHA is a distinct later commit, so any code
 * that wrongly points preview at HEAD/main will be caught.
 */
async function buildFixture() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitops-test-'));
  localDir = path.join(tmpRoot, 'local');

  const author = { name: 'Test', email: 'test@example.com', timestamp: 1700000000, timezoneOffset: 0 };

  // 1. init local repo on main, add one commit
  await fsp.mkdir(localDir, { recursive: true });
  await git.init({ fs: realFs, dir: localDir, defaultBranch: 'main' });
  await fsp.writeFile(path.join(localDir, 'README.md'), '# main\n');
  await git.add({ fs: realFs, dir: localDir, filepath: 'README.md' });
  const mainSha = await git.commit({ fs: realFs, dir: localDir, message: 'main commit', author });

  // 2. create preview with a DIFFERENT file + commit (distinct SHA)
  await git.branch({ fs: realFs, dir: localDir, ref: 'preview', checkout: true });
  await fsp.writeFile(path.join(localDir, 'PREVIEW.md'), '# preview\n');
  await git.add({ fs: realFs, dir: localDir, filepath: 'PREVIEW.md' });
  const previewSha = await git.commit({ fs: realFs, dir: localDir, message: 'preview commit', author });

  // 3. simulate "clone" state: back to main, register an origin remote,
  //    write origin-tracking refs for both branches, then DELETE the local
  //    preview branch so only origin/preview remains.
  await git.checkout({ fs: realFs, dir: localDir, ref: 'main' });
  await git.addRemote({ fs: realFs, dir: localDir, remote: 'origin', url: 'https://example.com/test.git' });
  await git.writeRef({ fs: realFs, dir: localDir, ref: 'refs/remotes/origin/main', value: mainSha });
  await git.writeRef({ fs: realFs, dir: localDir, ref: 'refs/remotes/origin/preview', value: previewSha });
  await git.deleteBranch({ fs: realFs, dir: localDir, ref: 'preview' });

  // sanity: HEAD is on main, no local preview, origin/preview exists
  const remoteBranches = await git.listBranches({ fs: realFs, dir: localDir, remote: 'origin' });
  if (!remoteBranches.includes('preview')) {
    throw new Error('fixture setup failed: origin/preview missing');
  }

  return { mainSha, previewSha };
}

describe('GitOperations.gitCheckoutBranch', () => {
  let ops;
  let outputs;
  let listBranchesSpy;

  beforeEach(async () => {
    vi.clearAllMocks();
    outputs = [];
    const sendOutput = (msg) => { outputs.push(msg); };
    ops = new GitOperations({
      logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      databaseManager: {},
    });
    ops._sendOutput = sendOutput;
    await buildFixture();
    // gitCheckoutBranch lists branches in a single call expecting both local
    // and remote names. Real isomorphic-git only returns remote names when
    // given `remote: 'origin'`, so stub the listing to mimic the shape the
    // production code assumes (local + origin/* combined), while leaving
    // branch/checkout/setConfig real and dynamic per-repo state.
    listBranchesSpy = vi.spyOn(git, 'listBranches').mockImplementation(async (args) => {
      const local = await realListBranches({ ...args, remote: undefined });
      const remote = (await realListBranches({ ...args, remote: 'origin' }))
        .filter(b => b !== 'HEAD')
        .map(b => `origin/${b}`);
      return [...local, ...remote];
    });
  });

  afterEach(async () => {
    if (listBranchesSpy) listBranchesSpy.mockRestore();
    if (tmpRoot) await rmrf(tmpRoot);
  });

  describe('checkout — remote-only branch creates local pointing at origin SHA', () => {
    it('should create local preview at the SAME sha as origin/preview (not HEAD/main)', async () => {
      const sendOutput = ops._sendOutput;

      await ops.gitCheckoutBranch(localDir, 'preview', sendOutput);

      const localPreviewSha = await git.resolveRef({ fs: realFs, dir: localDir, ref: 'refs/heads/preview' });
      const remotePreviewSha = await git.resolveRef({ fs: realFs, dir: localDir, ref: 'refs/remotes/origin/preview' });
      const mainSha = await git.resolveRef({ fs: realFs, dir: localDir, ref: 'refs/heads/main' });

      expect(localPreviewSha).toBe(remotePreviewSha);
      // The bug would make this equal mainSha instead.
      expect(localPreviewSha).not.toBe(mainSha);
    });

    it('should set tracking config branch.preview.remote=origin', async () => {
      const sendOutput = ops._sendOutput;
      await ops.gitCheckoutBranch(localDir, 'preview', sendOutput);

      const remote = await git.getConfig({ fs: realFs, dir: localDir, path: 'branch.preview.remote' });
      expect(remote).toBe('origin');
    });

    it('should set tracking config branch.preview.merge=refs/heads/preview', async () => {
      const sendOutput = ops._sendOutput;
      await ops.gitCheckoutBranch(localDir, 'preview', sendOutput);

      const merge = await git.getConfig({ fs: realFs, dir: localDir, path: 'branch.preview.merge' });
      expect(merge).toBe('refs/heads/preview');
    });

    it('should NOT use the non-existent objectRef parameter (regression guard)', async () => {
      const sendOutput = ops._sendOutput;
      const branchSpy = vi.spyOn(git, 'branch');

      await ops.gitCheckoutBranch(localDir, 'preview', sendOutput);

      const call = branchSpy.mock.calls.find(c => c[0] && c[0].ref === 'preview');
      expect(call).toBeDefined();
      // The correct parameter is `object`, and it must resolve to origin/<branch>.
      expect(call[0].object).toBe('origin/preview');
      // objectRef does not exist in isomorphic-git and must never be used.
      expect(call[0].objectRef).toBeUndefined();
      // Ensure the working tree was actually checked out.
      expect(call[0].checkout).toBe(true);

      branchSpy.mockRestore();
    });

    it('should leave the working tree on the preview branch', async () => {
      const sendOutput = ops._sendOutput;
      await ops.gitCheckoutBranch(localDir, 'preview', sendOutput);

      const cur = await git.currentBranch({ fs: realFs, dir: localDir, fullname: false });
      expect(cur).toBe('preview');
    });
  });

  describe('checkout — existing local branch', () => {
    it('should checkout a local branch that already exists', async () => {
      const sendOutput = ops._sendOutput;
      // create a local branch first
      await git.branch({ fs: realFs, dir: localDir, ref: 'feature', checkout: false });

      await ops.gitCheckoutBranch(localDir, 'feature', sendOutput);

      const cur = await git.currentBranch({ fs: realFs, dir: localDir, fullname: false });
      expect(cur).toBe('feature');
    });
  });

  describe('checkout — missing branch', () => {
    it('should throw when the branch does not exist locally or remotely', async () => {
      const sendOutput = ops._sendOutput;
      await expect(ops.gitCheckoutBranch(localDir, 'nope', sendOutput)).rejects.toThrow(/not found/);
    });
  });
});

describe('GitOperations._pushWithRetry', () => {
  let ops;
  let outputs;
  let pushSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    outputs = [];
    ops = new GitOperations({
      logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      databaseManager: {},
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (pushSpy) pushSpy.mockRestore();
  });

  const sendOutput = (msg) => { outputs.push(msg); };
  const pushArgs = ['/repo', 'https://example.com/test.git', { token: 'token' }, 'preview', 'preview'];

  it('should succeed on 1st attempt without retry', async () => {
    pushSpy = vi.spyOn(git, 'push').mockResolvedValue({ ok: true });

    await ops._pushWithRetry(...pushArgs, sendOutput);

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(outputs).toEqual([]);
  });

  it('should succeed on 2nd attempt after transient failure (1s backoff)', async () => {
    pushSpy = vi.spyOn(git, 'push')
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ ok: true });

    const promise = ops._pushWithRetry(...pushArgs, sendOutput);

    // 1s backoff not yet elapsed → still only the first attempt
    await vi.advanceTimersByTimeAsync(999);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(pushSpy).toHaveBeenCalledTimes(2);
    expect(outputs.join('')).toContain('Tentativa 1 falhou');
    expect(outputs.join('')).toContain('Retentando em 1s');
  });

  it('should fail after 3 attempts with clear actionable error', async () => {
    const transient = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    pushSpy = vi.spyOn(git, 'push').mockRejectedValue(transient);

    const promise = ops._pushWithRetry(...pushArgs, sendOutput);
    promise.catch(() => {}); // pre-register handler to avoid unhandled-rejection warning

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(promise).rejects.toThrow('Falha ao criar branch preview remota após 3 tentativas');
    expect(pushSpy).toHaveBeenCalledTimes(3);
    expect(outputs.join('')).toContain('Tentativa 1 falhou');
    expect(outputs.join('')).toContain('Retentando em 1s');
    expect(outputs.join('')).toContain('Tentativa 2 falhou');
    expect(outputs.join('')).toContain('Retentando em 2s');
  });

  it('should pass auth in the provider contract shape (auth.token)', async () => {
    const servicePushSpy = vi.spyOn(ops.git, 'push').mockResolvedValue({ ok: true });

    await ops._pushWithRetry(...pushArgs, sendOutput);

    expect(servicePushSpy).toHaveBeenCalledTimes(1);
    const callArgs = servicePushSpy.mock.calls[0][1];
    expect(callArgs.ref).toBe('preview');
    expect(callArgs.remoteRef).toBe('preview');
    expect(callArgs.auth).toEqual({ token: 'token' });
    expect(callArgs.onAuth).toBeUndefined();
    servicePushSpy.mockRestore();
  });

  it('should abort immediately on non-retriable error (HTTP 403) without retry', async () => {
    const forbidden = Object.assign(new Error('Resource not accessible by integration'), { response: { status: 403 } });
    pushSpy = vi.spyOn(git, 'push').mockRejectedValue(forbidden);

    await expect(ops._pushWithRetry(...pushArgs, sendOutput)).rejects.toThrow('Resource not accessible by integration');

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(outputs).toEqual([]);
  });

  it('regression task 6: HTTP 401 (bad/anonymous-gated token) is classified NON-retriable by _isRetriablePushError', () => {
    expect(ops._isRetriablePushError(
      Object.assign(new Error('No anonymous write access'), { response: { status: 401 } })
    )).toBe(false);
    expect(ops._isRetriablePushError(
      Object.assign(new Error('auth via cause'), { cause: { response: { status: 401 } } })
    )).toBe(false);
    expect(ops._isRetriablePushError(
      Object.assign(new Error('bad credentials'), { response: { status: 403 } })
    )).toBe(false);
  });
});

// ─── gitEnsurePreviewBranch push-failure propagation ───────────────────────
//
// Regression guard: push failures during preview branch creation MUST be
// surfaced via the return value (`pushFailed: true` + `pushError` string)
// instead of being silently swallowed. The caller relies on these fields to
// show a visible warning while still allowing the project to open.
describe('GitOperations.gitEnsurePreviewBranch — push failure propagation', () => {
  let ops;
  let outputs;

  beforeEach(() => {
    vi.clearAllMocks();
    outputs = [];
    ops = new GitOperations({
      logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      databaseManager: {},
    });
  });

  /**
   * Drive gitEnsurePreviewBranch down the "create preview" path by stubbing
   * every collaborator. `impl` receives the ops instance so each test can
   * program _pushWithRetry's behavior.
   */
  async function runCreatePath(impl) {
    const sendOutput = (msg) => { outputs.push(msg); };
    ops.gitCheckoutBranch = vi.fn().mockResolvedValue(undefined);
    ops.gitCreateBranch = vi.fn().mockResolvedValue(undefined);
    ops.gitGetRemoteUrl = vi.fn().mockResolvedValue('https://github.com/acme/repo.git');
    ops.getGitHubToken = vi.fn().mockResolvedValue('fake-token-1234567890');
    // statusMatrix dirty-check — return clean tree (all rows in agreement)
    vi.spyOn(git, 'statusMatrix').mockResolvedValue([['file.txt', 1, 1, 1]]);
    // listBranches — no preview locally or remotely forces the create path
    vi.spyOn(git, 'listBranches').mockResolvedValue(['main']);
    impl(ops);
    return ops.gitEnsurePreviewBranch('/repo', sendOutput);
  }

  it('returns pushFailed:true and pushError string when _pushWithRetry throws', async () => {
    const result = await runCreatePath((o) => {
      o._pushWithRetry = vi.fn().mockRejectedValue(new Error('auth failure 401'));
    });

    expect(result).toMatchObject({
      created: true,
      checkedOut: true,
      pushFailed: true,
    });
    expect(typeof result.pushError).toBe('string');
    expect(result.pushError).toContain('auth failure 401');
    // Warning guidance must still reach the user-visible output buffer.
    expect(outputs.join('')).toContain('git push -u origin preview');
  });

  it('returns pushFailed:false (not true) when push succeeds', async () => {
    const result = await runCreatePath((o) => {
      o._pushWithRetry = vi.fn().mockResolvedValue(undefined);
    });

    expect(result).toMatchObject({ created: true, checkedOut: true });
    expect(result.pushFailed).not.toBe(true);
  });

  it('returns pushFailed:false when no remote is configured (skip is expected, not a failure)', async () => {
    const result = await runCreatePath((o) => {
      // Override remoteUrl to empty — push is skipped (not attempted)
      o.gitGetRemoteUrl = vi.fn().mockResolvedValue('');
      o._pushWithRetry = vi.fn(); // must NOT be called
    });

    expect(result).toMatchObject({ created: true, checkedOut: true });
    expect(result.pushFailed).not.toBe(true);
    expect(ops._pushWithRetry).not.toHaveBeenCalled();
  });

  it('returns pushFailed:false when no token is available (skip is expected, not a failure)', async () => {
    const result = await runCreatePath((o) => {
      o.getGitHubToken = vi.fn().mockResolvedValue(null);
      o._pushWithRetry = vi.fn(); // must NOT be called
    });

    expect(result).toMatchObject({ created: true, checkedOut: true });
    expect(result.pushFailed).not.toBe(true);
    expect(ops._pushWithRetry).not.toHaveBeenCalled();
  });

  it('does NOT set pushFailed when preview already exists (early-return path)', async () => {
    const sendOutput = (msg) => { outputs.push(msg); };
    // Force the "already exists" branch: preview present as a local branch.
    vi.spyOn(git, 'listBranches').mockResolvedValue(['main', 'preview']);
    ops.gitCheckoutBranch = vi.fn().mockResolvedValue(undefined);
    ops._pushWithRetry = vi.fn(); // must never be invoked on this path

    const result = await ops.gitEnsurePreviewBranch('/repo', sendOutput);

    expect(result).toMatchObject({ created: false, checkedOut: true });
    expect(result.pushFailed).not.toBe(true);
    expect(ops._pushWithRetry).not.toHaveBeenCalled();
  });
});
