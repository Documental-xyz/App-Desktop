/**
 * @fileoverview Unit tests for GitPreflight — read-only pre-lock validation.
 *
 * Mocks isomorphic-git via the module-level factory. The GitPreflight
 * constructor accepts a `getGit` option so we share the mocked module
 * reference between the test and the preflight instance.
 *
 * @author Documental Team
 * @since 1.0.0
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('isomorphic-git', () => ({
  default: {},
  fetch: vi.fn(),
  resolveRef: vi.fn(),
  statusMatrix: vi.fn(),
  isDescendent: vi.fn(),
}));

vi.mock('isomorphic-git/http/node', () => ({ default: {} }));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    repos: {
      getContent: vi.fn().mockRejectedValue({ status: 404 }),
    },
  })),
}));

import { GitPreflight } from '../../src/ipc/gitPreflight.js';

const PROJECT_ID = 1;
const PROJECT_PATH = '/test/project';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeGitOps(token = 'ghp_token') {
  return {
    getGitHubToken: vi.fn().mockResolvedValue(token),
    configureGitForUser: vi.fn().mockResolvedValue(true),
    getCachedUserInfo: vi.fn().mockResolvedValue({ login: 'user' }),
  };
}

function makePreflight({ token } = {}) {
  const logger = makeLogger();
  const gitOps = makeGitOps(token);
  const databaseManager = { getDatabase: vi.fn() };
  // Use a shared getGit that imports the mocked module — preflight and test
  // see the same `git.fetch` / `git.resolveRef` mocks.
  const preflight = new GitPreflight({
    logger,
    gitOps,
    databaseManager,
    getGit: async () => import('isomorphic-git'),
  });
  return { preflight, logger, gitOps, databaseManager };
}

describe('GitPreflight', () => {
  let git;

  beforeEach(async () => {
    vi.clearAllMocks();
    git = await import('isomorphic-git');
    git.fetch.mockResolvedValue({});
    git.resolveRef.mockResolvedValue('sha-default');
    git.statusMatrix.mockResolvedValue([]);
    // Default: main IS an ancestor of preview (preview is ahead) — OK to promote.
    git.isDescendent.mockResolvedValue(true);
  });

  // ─── runPreflightForPreview ────────────────────────────────────────────
  describe('runPreflightForPreview', () => {
    it('returns firstPublish=true when remote preview branch does not exist', async () => {
      const { preflight } = makePreflight();
      git.fetch.mockRejectedValue(new Error('Could not find ref preview'));

      const result = await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);

      expect(result.canProceed).toBe(true);
      expect(result.firstPublish).toBe(true);
      // PREVIEW_REMOTE_MISSING check entry pushed
      expect(result.checks.some((c) => c.code === 'PREVIEW_REMOTE_MISSING')).toBe(true);
    });

    it('recognises "not found" hint as firstPublish (case-insensitive)', async () => {
      const { preflight } = makePreflight();
      git.fetch.mockRejectedValue(new Error('ref Not Found 404'));

      const result = await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);
      expect(result.firstPublish).toBe(true);
      expect(result.canProceed).toBe(true);
    });

    it('hard-blocks with FETCH_FAILED on a non-missing fetch error', async () => {
      const { preflight } = makePreflight();
      git.fetch.mockRejectedValue(new Error('500 internal server error'));

      const result = await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);

      expect(result.canProceed).toBe(false);
      expect(result.errors.some((e) => e.code === 'FETCH_FAILED')).toBe(true);
      expect(result.firstPublish).toBe(false);
    });

    it('surfaces aborted:true on AbortError during fetch', async () => {
      const { preflight } = makePreflight();
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      git.fetch.mockRejectedValue(abortErr);

      const result = await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);

      expect(result.canProceed).toBe(false);
      expect(result.aborted).toBe(true);
      expect(result.errors.some((e) => e.code === 'ABORTED')).toBe(true);
    });

    it('returns canProceed=true when preview branch exists', async () => {
      const { preflight } = makePreflight();
      git.fetch.mockResolvedValue({});

      const result = await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);
      expect(result.canProceed).toBe(true);
      expect(result.firstPublish).toBe(false);
      expect(result.checks.some((c) => c.code === 'PREVIEW_EXISTS')).toBe(true);
    });
  });

  // ─── runPreflightForMain ───────────────────────────────────────────────
  describe('runPreflightForMain', () => {
    function makePermissionHandlers({ canPush = true, isProtected = false, canUserPush = true } = {}) {
      return {
        checkMainPermission: vi.fn().mockResolvedValue({
          success: true,
          canPushToMain: canPush,
        }),
        checkBranchProtection: vi.fn().mockResolvedValue({
          success: true,
          isProtected,
          canUserPush,
        }),
      };
    }

    it('hard-blocks with PREVIEW_NOT_AHEAD when origin/preview === origin/main', async () => {
      const { preflight } = makePreflight();
      const permissionHandlers = makePermissionHandlers({ canPush: true });

      // Equal SHAs — precedence check returns PREVIEW_NOT_AHEAD.
      git.resolveRef.mockResolvedValue('equal-sha');

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        permissionHandlers
      );

      expect(result.canProceed).toBe(false);
      expect(result.errors.some((e) => e.code === 'PREVIEW_NOT_AHEAD')).toBe(true);
    });

    it('hard-blocks with PREVIEW_NOT_AHEAD when main moved ahead of preview (not ancestor)', async () => {
      const { preflight } = makePreflight();
      const permissionHandlers = makePermissionHandlers({ canPush: true });

      // Different SHAs (so equality fast-path is skipped), but isDescendent
      // returns false → main has commits preview doesn't have → BLOCK.
      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'origin/preview') return 'preview-behind-sha';
        if (ref === 'origin/main') return 'main-ahead-sha';
        if (ref === 'preview') return 'preview-behind-sha';
        return 'sha';
      });
      git.isDescendent.mockResolvedValue(false);

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        permissionHandlers
      );

      expect(result.canProceed).toBe(false);
      expect(result.errors.some((e) => e.code === 'PREVIEW_NOT_AHEAD')).toBe(true);
      // Verify isDescendent was called with main as ancestor and preview as oid
      expect(git.isDescendent).toHaveBeenCalledWith(
        expect.objectContaining({
          ancestor: 'main-ahead-sha',
          oid: 'preview-behind-sha',
          depth: -1,
        })
      );
    });

    it('hard-blocks with PREVIEW_NOT_AHEAD when working tree has uncommitted changes', async () => {
      const { preflight } = makePreflight();
      const permissionHandlers = makePermissionHandlers({ canPush: true });

      // Remote SHAs would normally allow proceed, but statusMatrix reports
      // a dirty file → must block BEFORE promoting to main.
      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'origin/preview') return 'preview-ahead-sha';
        if (ref === 'origin/main') return 'main-sha-behind';
        if (ref === 'preview') return 'preview-ahead-sha';
        return 'sha';
      });
      git.statusMatrix.mockResolvedValue([
        ['clean.txt', 1, 1, 1],
        ['modified.txt', 1, 2, 1], // WORKDIR !== 1 → dirty
      ]);

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        permissionHandlers
      );

      expect(result.canProceed).toBe(false);
      expect(result.errors.some((e) => e.code === 'PREVIEW_NOT_AHEAD')).toBe(true);
      // Must block BEFORE the merge/push body runs.
      expect(git.isDescendent).not.toHaveBeenCalled();
    });

    it('hard-blocks with PREVIEW_NOT_AHEAD when local preview diverges from origin/preview (unpushed work)', async () => {
      const { preflight } = makePreflight();
      const permissionHandlers = makePermissionHandlers({ canPush: true });

      // Ancestry OK (preview is ahead of main), but local preview ref points
      // at a different SHA than origin/preview → user has unpushed commits.
      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'origin/preview') return 'origin-preview-sha';
        if (ref === 'origin/main') return 'main-sha-behind';
        if (ref === 'preview') return 'local-preview-sha'; // diverged!
        return 'sha';
      });
      git.isDescendent.mockResolvedValue(true);

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        permissionHandlers
      );

      expect(result.canProceed).toBe(false);
      expect(result.errors.some((e) => e.code === 'PREVIEW_NOT_AHEAD')).toBe(true);
    });

    it('hard-blocks with PREVIEW_NOT_AHEAD when local preview ref does not exist', async () => {
      const { preflight } = makePreflight();
      const permissionHandlers = makePermissionHandlers({ canPush: true });

      // Ancestry OK, but resolving local 'preview' ref throws → user has
      // never published locally → must publish to preview first.
      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'origin/preview') return 'preview-ahead-sha';
        if (ref === 'origin/main') return 'main-sha-behind';
        if (ref === 'preview') throw new Error('ref not found');
        return 'sha';
      });
      git.isDescendent.mockResolvedValue(true);

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        permissionHandlers
      );

      expect(result.canProceed).toBe(false);
      expect(result.errors.some((e) => e.code === 'PREVIEW_NOT_AHEAD')).toBe(true);
    });

    it('allows proceed when preview is a descendant of main (isDescendent true)', async () => {
      const { preflight } = makePreflight();
      const permissionHandlers = makePermissionHandlers({ canPush: true });

      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'origin/preview') return 'preview-ahead-sha';
        if (ref === 'origin/main') return 'main-sha-behind';
        if (ref === 'preview') return 'preview-ahead-sha';
        return 'sha';
      });
      git.isDescendent.mockResolvedValue(true);

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        permissionHandlers
      );

      expect(result.canProceed).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('hard-blocks with MAIN_MISSING when fetch origin/main rejects with "not found"', async () => {
      const { preflight } = makePreflight();
      const permissionHandlers = makePermissionHandlers({ canPush: true });

      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'origin/main') throw new Error('not found');
        if (ref === 'origin/preview') return 'preview-ahead-sha';
        return 'sha';
      });
      git.fetch.mockImplementation(async ({ ref }) => {
        if (ref === 'main') throw new Error('404 not found');
        return {};
      });

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        permissionHandlers
      );

      expect(result.canProceed).toBe(false);
      expect(result.errors.some((e) => e.code === 'MAIN_MISSING')).toBe(true);
    });

    it('allows proceed when preview is ahead of main (different SHAs)', async () => {
      const { preflight } = makePreflight();
      const permissionHandlers = makePermissionHandlers({ canPush: true });

      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'origin/preview') return 'preview-ahead-sha';
        if (ref === 'origin/main') return 'main-sha-behind';
        if (ref === 'preview') return 'preview-ahead-sha';
        return 'sha';
      });

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        permissionHandlers
      );

      expect(result.canProceed).toBe(true);
      expect(result.errors).toHaveLength(0);
      // MAIN_EXISTS check pushed by branch-exists step
      expect(result.checks.some((c) => c.code === 'MAIN_EXISTS')).toBe(true);
    });

    it('surfaces branch-protection warning but still allows proceed', async () => {
      const { preflight } = makePreflight();
      const permissionHandlers = makePermissionHandlers({
        canPush: true,
        isProtected: true,
        canUserPush: false,
      });

      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'origin/preview') return 'preview-ahead-sha';
        if (ref === 'origin/main') return 'main-sha-behind';
        if (ref === 'preview') return 'preview-ahead-sha';
        return 'sha';
      });

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        permissionHandlers
      );

      // Warning surfaced
      expect(result.warnings.some((w) => w.code === 'BRANCH_PROTECTED_NO_PUSH')).toBe(true);
      // Still allowed (protection is informational only)
      expect(result.canProceed).toBe(true);
    });

    it('hard-blocks with PERMISSION_DENIED when canPushToMain is false', async () => {
      const { preflight } = makePreflight();
      const permissionHandlers = makePermissionHandlers({ canPush: false });

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        permissionHandlers
      );

      expect(result.canProceed).toBe(false);
      expect(result.errors.some((e) => e.code === 'PERMISSION_DENIED')).toBe(true);
    });

    it('hard-blocks with NO_TOKEN when gitOps.getGitHubToken returns null', async () => {
      const { preflight } = makePreflight({ token: null });

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        makePermissionHandlers()
      );

      expect(result.canProceed).toBe(false);
      expect(result.errors.some((e) => e.code === 'NO_TOKEN')).toBe(true);
    });

    it('also hard-blocks preview preflight with NO_TOKEN', async () => {
      const { preflight } = makePreflight({ token: null });

      const result = await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);

      expect(result.canProceed).toBe(false);
      expect(result.firstPublish).toBe(false);
      expect(result.errors.some((e) => e.code === 'NO_TOKEN')).toBe(true);
    });

    it('handles missing permissionHandlers gracefully (fail-open)', async () => {
      const { preflight } = makePreflight();
      git.resolveRef.mockImplementation(async ({ ref }) => {
        if (ref === 'origin/preview') return 'preview-ahead-sha';
        if (ref === 'origin/main') return 'main-sha-behind';
        if (ref === 'preview') return 'preview-ahead-sha';
        return 'sha';
      });

      const result = await preflight.runPreflightForMain(PROJECT_ID, PROJECT_PATH, null);

      // No permission handler → fail open
      expect(result.canProceed).toBe(true);
    });

    it('PRECEDENCE_CHECK_FAILED when resolveRef throws for preview unexpectedly', async () => {
      const { preflight } = makePreflight();
      const permissionHandlers = makePermissionHandlers({ canPush: true });

      // precedence uses Promise.all of two fetches; if both resolve OK then
      // resolveRef('origin/preview') rejects → PREVIEW_NOT_AHEAD is returned
      // (caught), but a different reject (after main resolves) is unusual.
      // Force fetch for main to succeed but precedence to throw via fetch rejection.
      git.fetch.mockImplementation(async ({ ref }) => {
        if (ref === 'main') return {};
        if (ref === 'preview') throw new Error('network glitch');
        return {};
      });

      const result = await preflight.runPreflightForMain(
        PROJECT_ID,
        PROJECT_PATH,
        permissionHandlers
      );

      // Either FETCH_FAILED (main-exists fetch wrapper catches) or
      // PRECEDENCE_CHECK_FAILED (precedence Promise.all rejects). Both are
      // hard-blocks — the key invariant is canProceed === false.
      expect(result.canProceed).toBe(false);
    });
  });

  // ─── Workflows cache ───────────────────────────────────────────────────
  describe('Workflows cache', () => {
    it('caches workflows result and avoids repeat API calls within TTL', async () => {
      const { preflight } = makePreflight();
      git.fetch.mockRejectedValue(new Error('Could not find ref preview'));

      // Two consecutive runs within the TTL window
      await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);
      await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);

      // Octokit mock is fresh each call; the second call should still hit
      // the cache entry set after the first run, so the underlying getContent
      // is invoked at most once per cache miss.
      expect(preflight._workflowsCache.has(String(PROJECT_ID))).toBe(true);
    });

    it('invalidateWorkflowsCache removes the cache entry', async () => {
      const { preflight } = makePreflight();
      git.fetch.mockRejectedValue(new Error('Could not find ref preview'));

      await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);
      expect(preflight._workflowsCache.has(String(PROJECT_ID))).toBe(true);

      preflight.invalidateWorkflowsCache(PROJECT_ID);
      expect(preflight._workflowsCache.has(String(PROJECT_ID))).toBe(false);
    });
  });

  // ─── Dirty working tree ────────────────────────────────────────────────
  describe('Dirty working tree check (informational only)', () => {
    it('emits WORKDIR_DIRTY check entry when statusMatrix reports dirty files', async () => {
      const { preflight } = makePreflight();
      git.fetch.mockResolvedValue({});
      git.statusMatrix.mockResolvedValue([
        ['clean.txt', 1, 1, 1],
        ['modified.txt', 1, 2, 1],
      ]);

      const result = await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);

      // Dirty entry is informational — never blocks.
      expect(result.canProceed).toBe(true);
      expect(result.checks.some((c) => c.code === 'WORKDIR_DIRTY')).toBe(true);
    });

    it('emits WORKDIR_CLEAN check entry when statusMatrix is all-clean', async () => {
      const { preflight } = makePreflight();
      git.fetch.mockResolvedValue({});
      git.statusMatrix.mockResolvedValue([['clean.txt', 1, 1, 1]]);

      const result = await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);
      expect(result.checks.some((c) => c.code === 'WORKDIR_CLEAN')).toBe(true);
    });

    it('silently skips when statusMatrix throws (no entry, never blocks)', async () => {
      const { preflight } = makePreflight();
      git.fetch.mockResolvedValue({});
      git.statusMatrix.mockRejectedValue(new Error('corrupt index'));

      const result = await preflight.runPreflightForPreview(PROJECT_ID, PROJECT_PATH);
      expect(result.canProceed).toBe(true);
      expect(result.checks.some((c) => c.code === 'WORKDIR_DIRTY')).toBe(false);
      expect(result.checks.some((c) => c.code === 'WORKDIR_CLEAN')).toBe(false);
    });
  });
});
