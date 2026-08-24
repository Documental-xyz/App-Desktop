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
  isDescendent: vi.fn().mockResolvedValue(true),
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

// Mock the merge drivers so binary fallbacks are controllable spies
// (avoids touching the real filesystem for binary fallback writes).
// Both directions are provided — the publish flow uses OURS (local wins),
// publish-main uses THEIRS (preview wins).
vi.mock('../../src/ipc/gitMergeDriver.js', () => ({
  theirsMergeDriver: vi.fn(({ contents }) => {
    if (contents[2] === undefined || contents[2] === null) {
      return { cleanMerge: false };
    }
    return { cleanMerge: true, mergedText: contents[2] };
  }),
  resolveBinaryTheirs: vi.fn().mockResolvedValue(undefined),
  oursMergeDriver: vi.fn(({ contents }) => {
    if (contents[1] === undefined || contents[1] === null) {
      return { cleanMerge: false };
    }
    return { cleanMerge: true, mergedText: contents[1] };
  }),
  resolveBinaryOurs: vi.fn().mockResolvedValue(undefined),
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
      checkMainPermission: vi.fn().mockResolvedValue({
        success: true,
        canPushToMain: true,
      }),
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
    vi.spyOn(handlers.gitOps, 'getGitHubUserInfo').mockResolvedValue({ login: 'tester' });

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

        it('auto-commits a dirty tree as WIP instead of blocking (DIRTY_LOCAL is GONE)', async () => {
          git.currentBranch.mockResolvedValue('preview');
          // Dirty matrix: one file not [1,1,1]
          git.statusMatrix.mockResolvedValue([
            ['clean.txt', 1, 1, 1],
            ['dirty.txt', 1, 2, 1], // workdir !== 1
          ]);

          const result = await handlers.gitRefresh(1, false);

          // Dirty tree no longer blocks: it is committed as WIP (Task 7 —
          // the "discard changes" option is gone).
          expect(result.success).toBe(true);
          expect(result.code).toBeUndefined();
          const wipCommit = git.commit.mock.calls.find(
            (c) => typeof c[0]?.message === 'string' && c[0].message.startsWith('WIP by tester at')
          );
          expect(wipCommit).toBeDefined();
        });

        it('force=true no longer hard-resets — merge-based refresh, no writeRef to the branch', async () => {
          git.currentBranch.mockResolvedValue('working');
          git.statusMatrix.mockResolvedValue([['dirty.txt', 1, 2, 1]]);
          git.checkout.mockResolvedValue(undefined);
          git.fetch.mockResolvedValue({});
          git.resolveRef.mockResolvedValue('fake-commit-oid');
          git.writeRef.mockResolvedValue(undefined);

          const result = await handlers.gitRefresh(1, true);

          expect(result.success).toBe(true);
          expect(git.checkout).toHaveBeenCalledWith(
            expect.objectContaining({ ref: 'preview' })
          );
          expect(git.resolveRef).toHaveBeenCalled();
          // NO hard reset on any refresh path (Task 7): the branch ref is
          // never force-written.
          const branchWrite = git.writeRef.mock.calls.find(
            (c) => c[0] && String(c[0].ref || '').startsWith('refs/heads/preview')
          );
          expect(branchWrite).toBeUndefined();
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
          // no merge / no worktree materialization after an aborted fetch
          expect(git.merge).not.toHaveBeenCalled();
          const forceCheckout = git.checkout.mock.calls.find(
            (c) => c[0] && c[0].force === true
          );
          expect(forceCheckout).toBeUndefined();
        });
  });

  // ─── gitPublishPreview (Task 6: commit-first + merge LOCAL-wins) ───────
  describe('gitPublishPreview', () => {
    beforeEach(() => {
      vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('ghp_token');
      vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
      // Divergence fixture: local HEAD ≠ origin/preview (merge path).
      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'refs/remotes/origin/preview' || ref === 'origin/preview') {
          return 'origin-sha-1';
        }
        return 'local-head-sha';
      });
    });

    it('merges origin/preview into the working branch with the OURS driver (local wins)', async () => {
      git.currentBranch.mockResolvedValue('preview');
      git.statusMatrix.mockResolvedValue([['file.txt', 1, 2, 1]]);
      git.commit.mockResolvedValue('localSha001');
      git.fetch.mockResolvedValue({});
      git.merge.mockResolvedValue(undefined); // no conflict
      git.push.mockResolvedValue(undefined);

      const result = await handlers.gitPublishPreview(1, 'publish message');

      expect(result.success).toBe(true);
      expect(result.branch).toBe('preview');
      expect(result.commitSha).toBeDefined();

      // merge runs ON the working branch with oursMergeDriver wired
      const mergeCalls = git.merge.mock.calls;
      expect(mergeCalls.length).toBe(1);
      expect(mergeCalls[0][0]).toMatchObject({
        fastForward: false,
        ours: 'preview',
        theirs: 'origin/preview',
      });
      expect(mergeCalls[0][0].mergeDriver).toEqual(expect.any(Function));

      // every push call must be remote origin, target preview, non-forced
      const pushCalls = git.push.mock.calls;
      expect(pushCalls.length).toBeGreaterThan(0);
      for (const c of pushCalls) {
        expect(c[0].force).toBe(false);
        expect(c[0].remoteRef).toBe('preview');
        expect(c[0].remote).toBe('origin');
      }

      // NO hard reset / temp-branch machinery after the push
      expect(git.writeRef).not.toHaveBeenCalled();
      expect(git.branch).not.toHaveBeenCalledWith(
        '/test/project', 'publish-preview', expect.anything()
      );
    });

    it('handles binary conflict with fallback resolveBinaryOurs (local version)', async () => {
      git.currentBranch.mockResolvedValue('preview');
      git.statusMatrix.mockResolvedValue([['file.txt', 1, 2, 1]]);
      git.commit.mockResolvedValue('localSha002');
      git.fetch.mockResolvedValue({});

      const conflictErr = new Error('merge conflict');
      conflictErr.code = 'MergeConflictError';
      conflictErr.name = 'MergeConflictError';
      conflictErr.data = ['image.png'];
      git.merge.mockRejectedValueOnce(conflictErr);

      git.readBlob.mockResolvedValue({ blob: new Uint8Array([1, 2, 3]) });
      git.push.mockResolvedValue(undefined);

      const result = await handlers.gitPublishPreview(1, 'binary publish');

      expect(result.success).toBe(true);

      // binary fallback read the LOCAL blob (ours) for the conflict file
      const readBlobCall = git.readBlob.mock.calls.find(
        (c) => c[0] && c[0].filepath === 'image.png'
      );
      expect(readBlobCall).toBeDefined();

      // the manual merge commit carries both parents
      const binaryCommitCall = git.commit.mock.calls.find(
        (c) => c[0].parent && Array.isArray(c[0].parent) && c[0].parent.length === 2
      );
      expect(binaryCommitCall).toBeDefined();
      expect(binaryCommitCall[0].message).toMatch(/binary resolved/);

      for (const c of git.push.mock.calls) {
        expect(c[0].force).toBe(false);
      }
    });

    it('materializes the merged tree with a post-merge checkout of the working branch', async () => {
      git.currentBranch.mockResolvedValue('preview');
      git.statusMatrix.mockResolvedValue([['file.txt', 1, 2, 1]]);
      git.commit.mockResolvedValue('localSha003');
      git.fetch.mockResolvedValue({});
      git.merge.mockResolvedValue(undefined);
      git.push.mockResolvedValue(undefined);

      await handlers.gitPublishPreview(1, 'materialize test');

      // iso-git merge does NOT touch the working tree — the flow must
      // checkout the branch (force, backup-guarded) after the merge.
      const checkoutCalls = git.checkout.mock.calls.filter(
        (c) => c[0] && c[0].ref === 'preview'
      );
      expect(checkoutCalls.length).toBeGreaterThan(0);
    });

    it('returns typed PUSH_REJECTED (no retry) when the push is rejected', async () => {
      git.currentBranch.mockResolvedValue('preview');
      git.statusMatrix.mockResolvedValue([['file.txt', 1, 2, 1]]);
      git.commit.mockResolvedValue('localSha004');
      git.fetch.mockResolvedValue({});
      git.merge.mockResolvedValue(undefined);

      const nff = new Error('non-fast-forward');
      git.push.mockRejectedValue(nff);

      const result = await handlers.gitPublishPreview(1, 'rejected test');

      expect(result.success).toBe(false);
      expect(result.code).toBe('PUSH_REJECTED');
      expect(result.error).toMatch(/atualiz/i);
      // single attempt — the renderer guides the user to update first
      expect(git.push.mock.calls.length).toBe(1);
    });

    it('never uses force push', async () => {
      git.currentBranch.mockResolvedValue('preview');
      git.statusMatrix.mockResolvedValue([['file.txt', 1, 2, 1]]);
      git.commit.mockResolvedValue('localSha005');
      git.fetch.mockResolvedValue({});
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
      // Precedence ancestry check: preview IS a descendant of main → OK to publish.
      git.isDescendent.mockResolvedValue(true);
      // Preflight's precedence check requires origin/preview to be AHEAD of
      // origin/main (different SHAs) — otherwise it hard-blocks with
      // PREVIEW_NOT_AHEAD before the body runs. It also requires the LOCAL
      // preview ref to equal origin/preview (no unpushed work) and the
      // working tree to be clean. Discriminate by ref so the success-path
      // tests exercise the actual merge+push flow.
      git.resolveRef.mockImplementation((args) => {
        const ref = args && args.ref;
        if (ref === 'origin/preview') return Promise.resolve('preview-ahead-sha');
        if (ref === 'origin/main') return Promise.resolve('main-sha');
        if (ref === 'refs/remotes/origin/preview') return Promise.resolve('preview-ahead-sha');
        if (ref === 'refs/remotes/origin/main') return Promise.resolve('main-sha');
        if (ref === 'preview' || ref === 'refs/heads/preview') return Promise.resolve('preview-ahead-sha');
        return Promise.resolve('head-sha');
      });
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

        it('merges origin/preview into main with --no-ff and theirs driver', async () => {
          git.fetch.mockResolvedValue({});
          git.checkout.mockResolvedValue(undefined);
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);
          git.merge.mockResolvedValue(undefined);
          git.push.mockResolvedValue(undefined);

          const result = await handlers.gitPublishMain(1);

          expect(result.success).toBe(true);
          // Task 8 contract: success returns to the preview working branch.
          expect(result.branch).toBe('preview');

          const mergeCall = git.merge.mock.calls.find(
            (c) => c[0] && c[0].ours === 'main'
          );
          expect(mergeCall).toBeDefined();
          expect(mergeCall[0]).toMatchObject({
            fastForward: false,
            ours: 'main',
            theirs: 'origin/preview',
          });
          expect(mergeCall[0].mergeDriver).toEqual(expect.any(Function));
        });

        it('resolves text conflicts with theirs strategy (preview wins)', async () => {
          git.fetch.mockResolvedValue({});
          git.checkout.mockResolvedValue(undefined);
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);
          git.merge.mockImplementation(async (args) => {
            // Without the theirs driver, text conflicts throw. With it,
            // isomorphic-git resolves them (theirs/preview content wins).
            if (typeof args.mergeDriver !== 'function') {
              const err = new Error('merge conflict (text)');
              err.code = 'MergeConflictError';
              err.name = 'MergeConflictError';
              err.data = ['conflict.txt'];
              throw err;
            }
            return undefined;
          });
          git.commit.mockResolvedValue('resolvedTextSha');
          git.push.mockResolvedValue(undefined);

          const result = await handlers.gitPublishMain(1);

          expect(result.success).toBe(true);
          expect(result.code).not.toBe('MAIN_MERGE_CONFLICT');
          // The theirs driver must be wired so text conflicts resolve, not abort.
          const mergeCall = git.merge.mock.calls.find(
            (c) => c[0] && c[0].ours === 'main'
          );
          expect(mergeCall[0].mergeDriver).toEqual(expect.any(Function));
        });

        it('resolves binary conflicts with resolveBinaryTheirs fallback', async () => {
          git.fetch.mockResolvedValue({});
          git.checkout.mockResolvedValue(undefined);
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);

          const conflictErr = new Error('merge conflict');
          conflictErr.code = 'MergeConflictError';
          conflictErr.name = 'MergeConflictError';
          conflictErr.data = ['image.png'];
          git.merge.mockRejectedValueOnce(conflictErr);

          git.readBlob.mockResolvedValue({ blob: new Uint8Array([1, 2, 3]) });
          git.add.mockResolvedValue(undefined);
          git.commit.mockResolvedValue('binaryCommitMain');
          git.push.mockResolvedValue(undefined);

          const result = await handlers.gitPublishMain(1);

          expect(result.success).toBe(true);
          // The REAL resolveBinaryTheirs calls readBlob on the conflict filepath.
          // Asserting on the spy from vi.mock fails because the module-level
          // require() in git.js bypasses vitest's ESM interceptor (Node 24
          // native require). Verify the actual side-effect instead.
          const readBlobCall = git.readBlob.mock.calls.find(
            (c) => typeof c[0].filepath === 'string' && c[0].filepath.includes('image.png')
          );
          expect(readBlobCall).toBeDefined();
          expect(readBlobCall[0].filepath).toBe('image.png');
        });

        it('handles deleted-in-preview file (modify/delete conflict)', async () => {
          git.fetch.mockResolvedValue({});
          git.checkout.mockResolvedValue(undefined);
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);

          git.merge.mockImplementation(async (args) => {
            // If no theirs driver is wired, a modify/delete conflict throws.
            // With the driver, isomorphic-git resolves it (theirs wins).
            if (typeof args.mergeDriver !== 'function') {
              const err = new Error('modify/delete conflict');
              err.code = 'MergeConflictError';
              err.name = 'MergeConflictError';
              err.data = ['old.md'];
              throw err;
            }
            return undefined;
          });
          git.commit.mockResolvedValue('deleteCommitSha');
          git.push.mockResolvedValue(undefined);

          const result = await handlers.gitPublishMain(1);

          expect(result.success).toBe(true);
          // The theirs driver must be wired into git.merge so modify/delete
          // conflicts resolve with theirs (deletion) winning. The mock above
          // throws when no driver is present — success proves the driver was passed.
          const mergeCall = git.merge.mock.calls.find(
            (c) => c[0] && c[0].ours === 'main'
          );
          expect(mergeCall).toBeDefined();
          expect(mergeCall[0].mergeDriver).toEqual(expect.any(Function));
        });

        it('aborts merge and restores state on partial failure', async () => {
          git.fetch.mockResolvedValue({});
          git.checkout.mockResolvedValue(undefined);
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);
          git.merge.mockRejectedValue(new Error('disk full'));

          const safeSpy = handlers.gitSafety
            ? vi.spyOn(handlers.gitSafety, '_safeResetOrCheckout')
            : null;

          const result = await handlers.gitPublishMain(1);

          expect(result.success).toBe(false);
          if (safeSpy) {
            expect(safeSpy).toHaveBeenCalled();
          }
          expect(handlers.gitOperationInProgress).toBe(false);
          const checkoutCalls = git.checkout.mock.calls;
          expect(checkoutCalls.length).toBeGreaterThan(0);
          // Task 8 contract: return-to-preview happens ONLY on success; on
          // failure main is restored to origin/main (backup-guarded) and the
          // repo stays on main — nothing is reset back to preview blindly.
          const last = checkoutCalls[checkoutCalls.length - 1][0];
          expect(last.ref).toBe('main');
        });

        it('captures 403 from final push with clear PT-BR message', async () => {
          mockPermissionHandlers.checkMainPermission.mockResolvedValue({
            success: true,
            canPushToMain: true,
          });
          git.fetch.mockResolvedValue({});
          git.checkout.mockResolvedValue(undefined);
          git.writeRef.mockResolvedValue(undefined);
          git.checkout.mockResolvedValue(undefined);
          git.merge.mockResolvedValue(undefined);
          const forbidden = Object.assign(new Error('403 Forbidden'), {
            data: { code: 403 },
          });
          git.push.mockRejectedValue(forbidden);

          const result = await handlers.gitPublishMain(1);

          expect(result.success).toBe(false);
          expect(result.code).toBe('PUSH_FORBIDDEN');
          expect(result.error).toMatch(/permissão|protegida|Push rejeitado/i);
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

  // ─── Precedence enforcement regression ────────────────────────────────
  describe('Precedence enforcement before lock (Wave 2-3 regression)', () => {
    it('gitPublishMain does NOT acquire the lock on PREVIEW_NOT_AHEAD', async () => {
      mockPermissionHandlers.checkMainPermission.mockResolvedValue({
        success: true,
        canPushToMain: true,
      });
      git.resolveRef.mockResolvedValue('identical-sha');

      const lockSpy = vi.spyOn(handlers, 'acquireGitLock');

      const result = await handlers.gitPublishMain(1);

      expect(result.success).toBe(false);
      expect(result.code).toBe('PREVIEW_NOT_AHEAD');
      expect(lockSpy).not.toHaveBeenCalled();
      expect(handlers.gitOperationInProgress).toBe(false);
    });

    it('gitPublishMain does NOT acquire the lock on MAIN_MISSING', async () => {
      mockPermissionHandlers.checkMainPermission.mockResolvedValue({
        success: true,
        canPushToMain: true,
      });
      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'origin/preview') return 'preview-ahead-sha';
        if (ref === 'origin/main') throw new Error('not found');
        if (ref === 'preview') return 'preview-ahead-sha';
        return 'sha';
      });
      git.fetch.mockImplementation(async ({ ref }) => {
        if (ref === 'main') throw new Error('404 not found');
        return {};
      });

      const lockSpy = vi.spyOn(handlers, 'acquireGitLock');

      const result = await handlers.gitPublishMain(1);

      expect(result.success).toBe(false);
      expect(lockSpy).not.toHaveBeenCalled();
      expect(handlers.gitOperationInProgress).toBe(false);
    });
  });

  // ─── gitRefresh data-loss safety wrapper (Wave 1-3 regression) ────────
  describe('gitRefresh — merge-based sync (Task 7: no reset on any path)', () => {
    it('merges origin/preview LOCAL-wins instead of routing through _safeResetOrCheckout', async () => {
      git.currentBranch.mockResolvedValue('preview');
      git.statusMatrix.mockResolvedValue([]);
      git.fetch.mockResolvedValue({});
      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'HEAD') return 'local-head-sha';
        if (ref === 'refs/remotes/origin/preview') return 'remote-preview-sha';
        if (ref === 'origin/preview') return 'remote-preview-sha';
        return 'sha';
      });
      git.writeRef.mockResolvedValue(undefined);
      git.checkout.mockResolvedValue(undefined);
      git.branch.mockResolvedValue(undefined);
      git.commit.mockResolvedValue('backup-sha');

      expect(handlers.gitSafety).not.toBeNull();
      const safeSpy = vi.spyOn(handlers.gitSafety, '_safeResetOrCheckout');

      const result = await handlers.gitRefresh(1);

      expect(result.success).toBe(true);
      // Task 7: refresh NEVER resets — divergent state is merged.
      expect(safeSpy).not.toHaveBeenCalled();
      const mergeCall = git.merge.mock.calls.find(
        (c) => c[0] && c[0].theirs === 'origin/preview'
      );
      expect(mergeCall).toBeDefined();
      expect(mergeCall[0]).toMatchObject({ ours: 'preview', fastForward: false });
      // Task 5 regression guards (still true): no raw hard-reset helper.
      expect('_hardResetBranch' in handlers).toBe(false);
      expect(typeof handlers._safeResetToOrigin).toBe('function');
    });

    it('wraps the merge core in the mandatory backup when local has unpushed work', async () => {
      git.currentBranch.mockResolvedValue('preview');
      git.statusMatrix.mockResolvedValue([]);
      git.fetch.mockResolvedValue({});
      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'HEAD') return 'local-head';
        if (ref === 'refs/remotes/origin/preview') return 'remote-sha';
        if (ref === 'origin/preview') return 'remote-sha';
        return 'sha';
      });
      git.writeRef.mockResolvedValue(undefined);
      git.checkout.mockResolvedValue(undefined);
      git.branch.mockResolvedValue(undefined);

      const backupSpy = vi
        .spyOn(handlers.gitSafety, 'withMandatoryBackup')
        .mockImplementation(async (_ops, _fs, _dir, operation) => ({
          backupBranch: 'backup/preview-abc-1700000000000',
          result: await operation(),
        }));

      const result = await handlers.gitRefresh(1);

      expect(result.success).toBe(true);
      expect(result.branch).toBe('preview');
      expect(backupSpy).toHaveBeenCalledTimes(1);
    });

    it('propagates backup failure as a typed non-success result (aborts before any mutation)', async () => {
      git.currentBranch.mockResolvedValue('preview');
      git.statusMatrix.mockResolvedValue([]);
      git.fetch.mockResolvedValue({});
      git.resolveRef.mockResolvedValue('sha');

      const { GitSafetyError } = await import('../../src/ipc/gitSafety.js');
      vi.spyOn(handlers.gitSafety, 'withMandatoryBackup').mockRejectedValue(
        new GitSafetyError('BACKUP_FAILED', 'Backup obrigatório falhou — operação abortada para proteger seus dados (backup creation failed)')
      );

      const result = await handlers.gitRefresh(1);

      expect(result.success).toBe(false);
      expect(result.code).toBe('BACKUP_FAILED');
      expect(result.error).toMatch(/backup creation failed/);
      expect(git.merge).not.toHaveBeenCalled();
      expect(handlers.gitOperationInProgress).toBe(false);
    });
  });
});
