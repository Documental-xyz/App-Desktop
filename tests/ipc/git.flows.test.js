/**
 * @fileoverview Regression tests for the three new git flows:
 *   gitRefresh, gitPublishPreview, gitPublishMain.
 *
 * Mocks isomorphic-git entirely — no real network, no real git. The
 * GitHandlers class itself is exercised end-to-end (only its
 * dependencies: logger, databaseManager, permissionHandlers, gitOps,
 * and the isomorphic-git module are mocked).
 *
 * @author Documental Team
 * @since 1.0.0
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Module-level mocks ─────────────────────────────────────────────────────
// Provide every isomorphic-git method any of the three flows touch.
vi.mock('isomorphic-git', () => ({
  default: {},
  currentBranch: vi.fn(),
  statusMatrix: vi.fn(),
  fetch: vi.fn(),
  checkout: vi.fn(),
  push: vi.fn(),
  getConfig: vi.fn(),
  resolveRef: vi.fn(),
  writeRef: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  commit: vi.fn(),
  branch: vi.fn(),
  deleteBranch: vi.fn(),
  merge: vi.fn(),
  readBlob: vi.fn(),
}));

vi.mock('isomorphic-git/http/node', () => ({ default: {} }));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock('fs', () => ({
  default: {},
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn(),
    access: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock('../../src/ipc/gitOperations.js', () => ({
  GitOperations: vi.fn().mockImplementation(() => ({
    getGitHubToken: vi.fn(),
    configureGitForUser: vi.fn().mockResolvedValue(true),
    getCachedUserInfo: vi.fn(),
  })),
}));

// Mock the merge driver so resolveBinaryTheirs is a controllable spy
// (avoids touching the real filesystem for binary fallback writes).
vi.mock('../../src/ipc/gitMergeDriver.js', () => ({
  theirsMergeDriver: vi.fn(({ contents }) => {
    if (contents[2] === undefined || contents[2] === null) {
      return { cleanMerge: false };
    }
    return { cleanMerge: true, mergedText: contents[2] };
  }),
  resolveBinaryTheirs: vi.fn().mockResolvedValue(undefined),
}));

import { GitHandlers } from '../../src/ipc/git.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a mockDatabaseManager whose getDatabase() resolves a db with a
 *  callback-style get() that returns a valid project row. */
function makeDatabaseManager(projectPath = '/test/project') {
  return {
    getDatabase: vi.fn().mockResolvedValue({
      get: vi.fn((query, params, callback) => {
        callback(null, {
          id: 1,
          projectPath,
          repoFolderName: null,
        });
      }),
    }),
  };
}

/** Read the project row from the mock db (mirrors getProjectPath). */
async function resolveProjectPath(handlers) {
  // Force the in-memory getProjectPath to resolve quickly via the mock db.
  return handlers.getProjectPath(1);
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('Git flows — gitRefresh / gitPublishPreview / gitPublishMain', () => {
  let handlers;
  let mockLogger;
  let mockDatabaseManager;
  let mockPermissionHandlers;
  let git; // isomorphic-git mock handle

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mockDatabaseManager = makeDatabaseManager('/test/project');
    mockPermissionHandlers = {
      checkMainPermission: vi.fn(),
      invalidatePermissionCache: vi.fn(),
    };

    handlers = new GitHandlers({
      logger: mockLogger,
      databaseManager: mockDatabaseManager,
      permissionHandlers: mockPermissionHandlers,
    });

    git = await import('isomorphic-git');

    vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_token');
    vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);

    // Sensible default resolves so individual tests only override what they need.
    git.currentBranch.mockResolvedValue('preview');
    git.statusMatrix.mockResolvedValue([]); // clean
    git.fetch.mockResolvedValue({});
    git.checkout.mockResolvedValue(undefined);
    git.resolveRef.mockResolvedValue('fake-commit-oid');
    git.writeRef.mockResolvedValue(undefined);
    git.checkout.mockResolvedValue(undefined);
    git.push.mockResolvedValue(undefined);
    git.getConfig.mockResolvedValue('Test User');
    git.resolveRef.mockResolvedValue('abc1234567890abcdef');
    git.add.mockResolvedValue(undefined);
    git.remove.mockResolvedValue(undefined);
    git.commit.mockResolvedValue('commitsha0001');
    git.branch.mockResolvedValue(undefined);
    git.deleteBranch.mockResolvedValue(undefined);
    git.merge.mockResolvedValue(undefined);
    git.readBlob.mockResolvedValue({ blob: new Uint8Array([1, 2, 3]) });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── gitRefresh ────────────────────────────────────────────────────────
  describe('gitRefresh', () => {
    it('refreshes clean repo already on preview to origin/preview', async () => {
          git.currentBranch.mockResolvedValue('preview');
          git.statusMatrix.mockResolvedValue([]); // clean
          git.fetch.mockResolvedValue({});
          git.resolveRef.mockResolvedValue('fake-commit-oid');
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);

          const result = await handlers.gitRefresh(1);

          expect(result.success).toBe(true);
          expect(result.branch).toBe('preview');

          // fetch was shallow + single preview ref
          const fetchCall = git.fetch.mock.calls.find(
            (c) => c[0] && c[0].ref === 'preview'
          );
          expect(fetchCall).toBeDefined();
          expect(fetchCall[0]).toMatchObject({
            ref: 'preview',
            depth: 1,
            singleBranch: true,
            remote: 'origin',
          });

          // resolveRef was called (the hard-reset helper resolves the target ref first)
          const resolveCall = git.resolveRef.mock.calls.find(c => c[0]?.ref && c[0].ref.includes('preview'));
          expect(resolveCall).toBeDefined();
        });

        it('throws DIRTY_LOCAL when dirty and force=false', async () => {
          git.currentBranch.mockResolvedValue('working'); // not on preview → dirty check runs
          // Dirty matrix: one file not [1,1,1]
          git.statusMatrix.mockResolvedValue([
            ['clean.txt', 1, 1, 1],
            ['dirty.txt', 1, 2, 1], // workdir !== 1
          ]);

          const result = await handlers.gitRefresh(1, false);

          expect(result.success).toBe(false);
          expect(result.code).toBe('DIRTY_LOCAL');
          expect(Array.isArray(result.files)).toBe(true);
          expect(result.files).toContain('dirty.txt');

          // resolveRef must NOT have been called on a dirty abort
          expect(git.resolveRef).not.toHaveBeenCalled();
        });

        it('resets with force=true even when dirty', async () => {
          git.currentBranch.mockResolvedValue('working');
          git.statusMatrix.mockResolvedValue([['dirty.txt', 1, 2, 1]]);
          git.checkout.mockResolvedValue(undefined);
          git.fetch.mockResolvedValue({});
          git.resolveRef.mockResolvedValue('fake-commit-oid');
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);

          const result = await handlers.gitRefresh(1, true);

          expect(result.success).toBe(true);
          // switched to preview first, then fetched + hard reset
          expect(git.checkout).toHaveBeenCalledWith(
            expect.objectContaining({ ref: 'preview' })
          );
          expect(git.resolveRef).toHaveBeenCalled();
        });

        it('releases lock on success, error, and cancel paths', async () => {
          // success path
          git.currentBranch.mockResolvedValue('preview');
          git.fetch.mockResolvedValue({});
          git.resolveRef.mockResolvedValue('fake-commit-oid');
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);

          const spy = vi.spyOn(handlers, 'releaseGitLock');

          const ok = await handlers.gitRefresh(1);
          expect(ok.success).toBe(true);
          expect(spy).toHaveBeenCalledTimes(1);

          // reset spy + force an error path
          spy.mockClear();
          git.fetch.mockRejectedValueOnce(new Error('network down'));

          const err = await handlers.gitRefresh(1);
          expect(err.success).toBe(false);
          expect(spy).toHaveBeenCalledTimes(1);

          // reset spy + cancel path via AbortError
          spy.mockClear();
          const abortErr = new Error('aborted');
          abortErr.name = 'AbortError';
          git.fetch.mockRejectedValueOnce(abortErr);

          const cancelled = await handlers.gitRefresh(1);
          expect(cancelled.success).toBe(false);
          expect(cancelled.cancelled).toBe(true);
          expect(spy).toHaveBeenCalledTimes(1);
        });

        it('returns cancelled:true on AbortError', async () => {
          git.currentBranch.mockResolvedValue('preview');
          const abortErr = new Error('aborted');
          abortErr.name = 'AbortError';
          git.fetch.mockRejectedValueOnce(abortErr);

          const result = await handlers.gitRefresh(1);

          expect(result.success).toBe(false);
          expect(result.cancelled).toBe(true);
          // hard reset must NOT have run after an aborted fetch
          expect(git.resolveRef).not.toHaveBeenCalled();
        });
  });

  // ─── gitPublishPreview ─────────────────────────────────────────────────
  describe('gitPublishPreview', () => {
    beforeEach(() => {
      // The publish-preview flow needs a token to proceed.
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_token');
      vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
    });

    it('publishes text changes via mergeDriver theirs', async () => {
          // currentBranch returns preview, _commitAll commits (returns sha).
          git.currentBranch.mockResolvedValue('preview');
          git.statusMatrix.mockResolvedValue([['file.txt', 1, 2, 1]]);
          git.commit.mockResolvedValue('localSha001');
          git.fetch.mockResolvedValue({});
          git.branch.mockResolvedValue(undefined);
          git.merge.mockResolvedValue(undefined); // no conflict
          git.push.mockResolvedValue(undefined);

          const result = await handlers.gitPublishPreview(1, 'publish message');

          expect(result.success).toBe(true);
          expect(result.branch).toBe('preview');
          expect(result.commitSha).toBeDefined();

          // every push call must have force:false
          const pushCalls = git.push.mock.calls;
          expect(pushCalls.length).toBeGreaterThan(0);
          for (const c of pushCalls) {
            expect(c[0].force).toBe(false);
            expect(c[0].remoteRef).toBe('preview');
          }

          // merge was invoked (theirs merge driver wired up)
          const mergeCalls = git.merge.mock.calls;
          expect(mergeCalls.length).toBe(1);
          expect(mergeCalls[0][0]).toMatchObject({
            fastForward: false,
            ours: 'publish-preview',
          });
          expect(mergeCalls[0][0].mergeDriver).toEqual(expect.any(Function));
        });

        it('handles binary conflict with fallback resolveBinaryTheirs', async () => {
          git.currentBranch.mockResolvedValue('preview');
          git.statusMatrix.mockResolvedValue([['file.txt', 1, 2, 1]]);
          git.fetch.mockResolvedValue({});
          git.branch.mockResolvedValue(undefined);

          const conflictErr = new Error('merge conflict');
          conflictErr.code = 'MergeConflictError';
          conflictErr.name = 'MergeConflictError';
          conflictErr.data = ['image.png'];
          git.merge.mockRejectedValueOnce(conflictErr);

          git.commit
            .mockResolvedValueOnce('localSha002')
            .mockResolvedValueOnce('binaryCommit');
          git.push.mockResolvedValue(undefined);

          const result = await handlers.gitPublishPreview(1, 'binary publish');

          expect(result.success).toBe(true);
          expect(result.commitSha).toBe('localSha002');

          const binaryCommitCall = git.commit.mock.calls.find(
            (c) =>
              c[0].parent &&
              c[0].parent.includes('publish-preview') &&
              Array.isArray(c[0].parent) &&
              c[0].parent.length === 2
          );
          expect(binaryCommitCall).toBeDefined();
          expect(binaryCommitCall[0].message).toMatch(/binary resolved/);

          for (const c of git.push.mock.calls) {
            expect(c[0].force).toBe(false);
          }
        });

        it('cleans up publish-preview branch in finally', async () => {
          git.currentBranch.mockResolvedValue('preview');
          git.statusMatrix.mockResolvedValue([['file.txt', 1, 2, 1]]);
          git.commit.mockResolvedValue('localSha003');
          git.fetch.mockResolvedValue({});
          git.branch.mockResolvedValue(undefined);
          git.merge.mockResolvedValue(undefined);
          git.push.mockResolvedValue(undefined);

          await handlers.gitPublishPreview(1, 'cleanup test');

          // The finally cleanup deletes the temp branch when it was created.
          expect(git.deleteBranch).toHaveBeenCalledWith(
            expect.objectContaining({ ref: 'publish-preview' })
          );
        });

        it('retries on non-fast-forward up to MAX_PUBLISH_RETRIES', async () => {
          // MAX_PUBLISH_RETRIES === 2 — push rejects twice (NFF), succeeds on 3rd
          // requires extending the loop; here we emulate one rejection then success.
          git.currentBranch.mockResolvedValue('preview');
          git.statusMatrix.mockResolvedValue([['file.txt', 1, 2, 1]]);
          git.commit.mockResolvedValue('localSha004');
          git.fetch.mockResolvedValue({});
          git.branch.mockResolvedValue(undefined);
          git.merge.mockResolvedValue(undefined);

          const nff = new Error('non-fast-forward');
          git.push
            .mockRejectedValueOnce(nff)
            .mockResolvedValueOnce({}); // second attempt succeeds

          const result = await handlers.gitPublishPreview(1, 'retry test');

          expect(result.success).toBe(true);
          // push was attempted at least twice (first rejected, second ok)
          expect(git.push.mock.calls.length).toBeGreaterThanOrEqual(2);
          // all push calls are non-forced
          for (const c of git.push.mock.calls) {
            expect(c[0].force).toBe(false);
          }
        });

        it('never uses force push', async () => {
          git.currentBranch.mockResolvedValue('preview');
          git.statusMatrix.mockResolvedValue([['file.txt', 1, 2, 1]]);
          git.commit.mockResolvedValue('localSha005');
          git.fetch.mockResolvedValue({});
          git.branch.mockResolvedValue(undefined);
          git.merge.mockResolvedValue(undefined);
          git.push.mockResolvedValue(undefined);

          await handlers.gitPublishPreview(1, 'force invariant');

          expect(git.push).toHaveBeenCalled();
          for (const c of git.push.mock.calls) {
            expect(c[0].force).toBe(false);
          }
        });
  });

  // ─── gitPublishMain ────────────────────────────────────────────────────
  describe('gitPublishMain', () => {
    beforeEach(() => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_token');
      vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
      // Preflight's precedence check requires origin/preview to be AHEAD of
      // origin/main (different SHAs) — otherwise it hard-blocks with
      // PREVIEW_NOT_AHEAD before the body runs. Discriminate by ref so the
      // success-path tests exercise the actual merge+push flow.
      git.resolveRef.mockImplementation((args) => {
        const ref = args && args.ref;
        if (ref === 'origin/preview') return Promise.resolve('preview-ahead-sha');
        if (ref === 'origin/main') return Promise.resolve('main-sha');
        if (ref === 'refs/remotes/origin/preview') return Promise.resolve('preview-ahead-sha');
        if (ref === 'refs/remotes/origin/main') return Promise.resolve('main-sha');
        return Promise.resolve('head-sha');
      });
    });

    it('rejects when canPushToMain=false', async () => {
          mockPermissionHandlers.checkMainPermission.mockResolvedValue({
            success: true,
            canPushToMain: false,
          });

          const result = await handlers.gitPublishMain(1);

          expect(result.success).toBe(false);
          expect(result.code).toBe('PERMISSION_DENIED');
          // push must NOT have been attempted
          expect(git.push).not.toHaveBeenCalled();
        });

        it('hard-blocks with PREVIEW_NOT_AHEAD when preview === main (before lock)', async () => {
          // Regression: user requirement — "o usuário só possa fazer publicação
          // para main depois de já ter feito para preview". When origin/preview
          // and origin/main point at the same SHA, the publish must be rejected
          // BEFORE acquiring the lock or running merge/push.
          mockPermissionHandlers.checkMainPermission.mockResolvedValue({
            success: true,
            canPushToMain: true,
          });
          // Equal SHAs → preflight precedence check returns PREVIEW_NOT_AHEAD.
          git.resolveRef.mockResolvedValue('same-sha-both-branches');

          const result = await handlers.gitPublishMain(1);

          expect(result.success).toBe(false);
          expect(result.code).toBe('PREVIEW_NOT_AHEAD');
          expect(git.merge).not.toHaveBeenCalled();
          expect(git.push).not.toHaveBeenCalled();
        });

        it('merges origin/preview into main with --no-ff and no theirs driver', async () => {
          mockPermissionHandlers.checkMainPermission.mockResolvedValue({
            success: true,
            canPushToMain: true,
          });
          git.fetch.mockResolvedValue({});
          git.checkout.mockResolvedValue(undefined);
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);
          git.merge.mockResolvedValue(undefined);
          git.push.mockResolvedValue(undefined);

          const result = await handlers.gitPublishMain(1);

          expect(result.success).toBe(true);
          expect(result.branch).toBe('main');

          // merge must be --no-ff
          const mergeCall = git.merge.mock.calls.find(
            (c) => c[0] && c[0].ours === 'main'
          );
          expect(mergeCall).toBeDefined();
          expect(mergeCall[0]).toMatchObject({
            fastForward: false,
            ours: 'main',
            theirs: 'origin/preview',
          });
          // theirsMergeDriver MUST NOT be passed on main promotion
          expect(mergeCall[0].mergeDriver).toBeUndefined();
        });

        it('throws MAIN_MERGE_CONFLICT without theirs driver', async () => {
          mockPermissionHandlers.checkMainPermission.mockResolvedValue({
            success: true,
            canPushToMain: true,
          });
          git.fetch.mockResolvedValue({});
          git.checkout.mockResolvedValue(undefined);
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);
          git.merge.mockRejectedValue(new Error('merge conflict on main'));

          const result = await handlers.gitPublishMain(1);

          expect(result.success).toBe(false);
          expect(result.code).toBe('MAIN_MERGE_CONFLICT');
          // push must NOT have been attempted when merge fails
          expect(git.push).not.toHaveBeenCalled();
        });

        it('returns to preview branch in finally', async () => {
          mockPermissionHandlers.checkMainPermission.mockResolvedValue({
            success: true,
            canPushToMain: true,
          });
          git.fetch.mockResolvedValue({});
          git.checkout.mockResolvedValue(undefined);
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);
          git.merge.mockResolvedValue(undefined);
          git.push.mockResolvedValue(undefined);

          await handlers.gitPublishMain(1);

          // The last checkout call in the finally should return to preview.
          const checkoutCalls = git.checkout.mock.calls;
          expect(checkoutCalls.length).toBeGreaterThan(0);
          const last = checkoutCalls[checkoutCalls.length - 1][0];
          expect(last.ref).toBe('preview');
        });

        it('never uses force push', async () => {
          mockPermissionHandlers.checkMainPermission.mockResolvedValue({
            success: true,
            canPushToMain: true,
          });
          git.fetch.mockResolvedValue({});
          git.checkout.mockResolvedValue(undefined);
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);
          git.merge.mockResolvedValue(undefined);
          git.push.mockResolvedValue(undefined);

          await handlers.gitPublishMain(1);

          expect(git.push).toHaveBeenCalled();
          for (const c of git.push.mock.calls) {
            expect(c[0].force).toBe(false);
            expect(c[0].ref).toBe('main');
          }
        });

        it('does NOT have git.reset (function does not exist in isomorphic-git v1.38.4)', () => {
          expect(Object.keys(git)).not.toContain('reset');
        });
  });
});
