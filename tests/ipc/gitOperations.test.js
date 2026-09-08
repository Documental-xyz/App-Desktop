/**
 * @fileoverview GitOperations tests — checkout/preview-branch/push-retry.
 *
 * Backend seam (publish-update-resilience T16): the REAL dugite provider
 * (through GitService, as constructed in production) drives every
 * repository fixture; spies are installed on the GitService facade
 * (`ops.git`) — the old isomorphic-git module spies died with the
 * provider (T15). Fixtures and SHA verification use the bundled git CLI
 * (gitSetup), not a second JS git implementation.
 *
 * KNOWN REGRESSION PINNED (T15/T16): DugiteProvider.listBranches lists
 * ONLY refs/heads (local); GitOperations.gitCheckoutBranch's remote-only
 * detection expects local + 'origin/*' combined (the iso contract), so
 * checking out a remote-only branch currently throws "Branch not found".
 * The remote-only describe pins the CURRENT behavior as a T17 tripwire —
 * fixing listBranches (or the call site) flips it back to the
 * tracking-branch assertions.
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

vi.mock('../../src/services/secureTokenService.js', () => ({
  secureTokenService: { getToken: vi.fn(), setToken: vi.fn(), deleteToken: vi.fn() },
}));

const realFs = require('fs');
const fsp = realFs.promises;
const path = require('path');
const os = require('os');

import { gitSetup } from '../git-providers/harness.js';
const { GitOperations } = require('../../src/ipc/gitOperations.js');

// ─── Fixture helpers ───────────────────────────────────────────────────────

let tmpRoot;
let localDir;

/**
 * Recursively remove a directory (rm -rf), tolerant of missing paths.
 * @param {string} p - Path to remove.
 */
async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

/** rev-parse inside the fixture repo. */
async function revParse(ref) {
  return (await gitSetup(['rev-parse', `${ref}^{commit}`], localDir)).stdout.trim();
}

/**
 * Build a local repo that looks like a fresh clone of a remote with two
 * branches: `main` (checked out) and `preview` (only present as a remote
 * tracking ref, so the "remote-only" code path is exercised).
 *
 * Constructed with the bundled git CLI: commit history first, then
 * simulate the clone by adding origin tracking refs and deleting the
 * local preview branch. The preview SHA is a distinct later commit, so
 * any code that wrongly points preview at HEAD/main will be caught.
 */
async function buildFixture() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitops-test-'));
  localDir = path.join(tmpRoot, 'local');

  await fsp.mkdir(localDir, { recursive: true });
  await gitSetup(['init', '-b', 'main', '.'], localDir);
  await fsp.writeFile(path.join(localDir, 'README.md'), '# main\n');
  await gitSetup(['add', 'README.md'], localDir);
  await gitSetup(['commit', '-m', 'main commit'], localDir);
  const mainSha = await revParse('HEAD');

  await gitSetup(['branch', 'preview'], localDir);
  await gitSetup(['checkout', 'preview'], localDir);
  await fsp.writeFile(path.join(localDir, 'PREVIEW.md'), '# preview\n');
  await gitSetup(['add', 'PREVIEW.md'], localDir);
  await gitSetup(['commit', '-m', 'preview commit'], localDir);
  const previewSha = await revParse('HEAD');

  await gitSetup(['checkout', 'main'], localDir);
  await gitSetup(['remote', 'add', 'origin', 'https://example.com/test.git'], localDir);
  await gitSetup(['update-ref', 'refs/remotes/origin/main', mainSha], localDir);
  await gitSetup(['update-ref', 'refs/remotes/origin/preview', previewSha], localDir);
  await gitSetup(['branch', '-D', 'preview'], localDir);

  return { mainSha, previewSha };
}

describe('GitOperations.gitCheckoutBranch', () => {
  let ops;
  let outputs;

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
  });

  afterEach(async () => {
    if (tmpRoot) await rmrf(tmpRoot);
  });

  describe('checkout — remote-only branch (T15/T16 regression PINNED)', () => {
    // TRIPWIRE: DugiteProvider.listBranches returns LOCAL branches only,
    // so gitCheckoutBranch cannot see origin/preview and throws. When
    // T17 restores combined local+origin/* listing (or a fetch-aware
    // call site), flip this back to the tracking-branch assertions:
    //   local preview created AT origin/preview's SHA (not HEAD/main),
    //   tracking config branch.preview.remote/merge set, tree on preview.
    it('currently throws "not found" for a remote-only branch (T17: restore tracking-branch creation)', async () => {
      const sendOutput = ops._sendOutput;

      await expect(
        ops.gitCheckoutBranch(localDir, 'preview', sendOutput)
      ).rejects.toThrow(/Branch 'preview' not found/);

      // Nothing was created: no local preview ref.
      const localPreview = await gitSetup(
        ['rev-parse', '--verify', 'refs/heads/preview'], localDir
      ).then(() => true, () => false);
      expect(localPreview).toBe(false);
    });
  });

  describe('checkout — existing local branch', () => {
    it('should checkout a local branch that already exists', async () => {
      const sendOutput = ops._sendOutput;
      await gitSetup(['branch', 'feature'], localDir);

      await ops.gitCheckoutBranch(localDir, 'feature', sendOutput);

      expect((await gitSetup(['rev-parse', '--abbrev-ref', 'HEAD'], localDir)).stdout.trim())
        .toBe('feature');
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
    pushSpy = vi.spyOn(ops.git, 'push').mockResolvedValue({ ok: true });

    await ops._pushWithRetry(...pushArgs, sendOutput);

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(outputs).toEqual([]);
  });

  it('should succeed on 2nd attempt after transient failure (1s backoff)', async () => {
    pushSpy = vi.spyOn(ops.git, 'push')
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
    pushSpy = vi.spyOn(ops.git, 'push').mockRejectedValue(transient);

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
    pushSpy = vi.spyOn(ops.git, 'push').mockRejectedValue(forbidden);

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
    vi.spyOn(ops.git, 'statusMatrix').mockResolvedValue([['file.txt', 1, 1, 1]]);
    // listBranches — no preview locally forces the create path
    vi.spyOn(ops.git, 'listBranches').mockResolvedValue(['main']);
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
    vi.spyOn(ops.git, 'listBranches').mockResolvedValue(['main', 'preview']);
    ops.gitCheckoutBranch = vi.fn().mockResolvedValue(undefined);
    ops._pushWithRetry = vi.fn(); // must never be invoked on this path

    const result = await ops.gitEnsurePreviewBranch('/repo', sendOutput);

    expect(result).toMatchObject({ created: false, checkedOut: true });
    expect(result.pushFailed).not.toBe(true);
    expect(ops._pushWithRetry).not.toHaveBeenCalled();
  });
});
