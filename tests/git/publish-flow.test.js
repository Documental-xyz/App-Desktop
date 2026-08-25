/**
 * @fileoverview Task 6 (git-sync-strategy): publish flow rewritten as
 * commit-first + merge LOCAL-WINS.
 *
 * Integration tests against REAL repositories (isomorphic-git over a
 * loopback http bare origin — see tests/git/fixtures/harness.js), driven
 * through the production GitHandlers class. Scenarios (plan QA):
 *   (a) publish with non-conflicting remote divergence → push ok, both
 *       contents coexist, history has both commits;
 *   (b) push rejected (mocked) → typed PUSH_REJECTED error, working tree
 *       intact, backup branch exists.
 *
 * @vitest-environment node
 */

import { vi } from 'vitest';

// tests/setup.js mocks fs/path globally — these fixtures need the REAL fs.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';

import { createRepoPair, makeDivergent, makeDirty } from './fixtures/harness.js';
import { GitHandlers } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { providerFactory } from '../git-providers/harness.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** GitHandlers whose getProjectPath(1) resolves to `projectPath`. */
function makeHandlers(projectPath) {
  const databaseManager = {
    getDatabase: vi.fn().mockResolvedValue({
      get: (_query, _params, callback) =>
        callback(null, { id: 1, projectPath, repoFolderName: null }),
    }),
  };
  // Pinned to isomorphic-git: these are the iso-git integration suites
  // (Tasks 6-8); dual-provider parity lives in tests/git/parity-suite.test.js
  // (describe.each by provider). Without pinning, GIT_PROVIDER=dugite would
  // silently re-bind these suites to DugiteProvider.
  const handlers = new GitHandlers({
    logger: makeLogger(),
    databaseManager,
    gitService: new GitService({
      provider: providerFactory('isomorphic-git')(),
    }),
  });
  vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('test-token');
  vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
  // Preflight does network probing of the real GitHub remote; the flow
  // under test detects "first publish" by itself (missing origin ref).
  handlers.gitPreflight = null;
  return handlers;
}

const A_MD_BASE = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';

/** Local dirty edit of a.md line 5 (the "local wins" line). */
const A_MD_LOCAL = A_MD_BASE.replace('line5', 'line5-LOCAL');

// ─── Scenario (a): publish with non-conflicting divergence ──────────────────

describe('gitPublishPreview — divergent remote, local-wins merge', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({
      branch: 'preview',
      files: { 'a.md': A_MD_BASE },
    });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('pushes merged result: local edit + remote file coexist in tree and history', async () => {
    // Remote diverges: colleague adds c.md and pushes to origin/preview.
    await makeDivergent(pair, {
      remoteFiles: { 'c.md': 'remote content\n' },
      remoteMessage: 'remote: add c.md',
    });
    // Local dirty edit (uncommitted — publish must commit it first).
    makeDirty(pair.local, { 'a.md': A_MD_LOCAL });

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

    expect(result.success).toBe(true);
    expect(result.branch).toBe('preview');

    // Working tree keeps the LOCAL version of the edited line...
    const aMd = await pair.local.readFile('a.md');
    expect(aMd).toContain('line5-LOCAL');
    // ...and received the remote non-conflicting file.
    expect(fs.existsSync(path.join(pair.local.dir, 'c.md'))).toBe(true);
    expect(await pair.local.readFile('c.md')).toBe('remote content\n');

    // History contains BOTH sides + a merge commit + the publish commit.
    const messages = (await pair.local.log(20)).map((c) => c.commit.message);
    expect(messages.some((m) => m.includes('remote: add c.md'))).toBe(true);
    expect(messages.some((m) => m.includes('local: edit a.md'))).toBe(true);
    expect(messages.some((m) => /merge/i.test(m))).toBe(true);

    // Local branch is in sync with origin (push happened, no reset):
    const head = await pair.local.resolveRef('HEAD');
    const origin = await pair.local.resolveRef('refs/remotes/origin/preview');
    expect(head).toBe(origin);

    // Backup was created (dirty tree) and RETAINED (never deleted on success).
    const branches = await handlers.git.listBranches(pair.local.dir);
    const names = branches.map((b) => (typeof b === 'string' ? b : b.name));
    expect(names.some((n) => n.startsWith('backup/'))).toBe(true);
  });

  it('conflicting line: CONFLICT_PENDING, then MERGE_LOCAL resume keeps LOCAL + remote-only files', async () => {
    // Remote edits line 5 differently (CONFLICT on same hunk).
    const remoteEdit = A_MD_BASE.replace('line5', 'line5-REMOTE');
    await makeDivergent(pair, {
      remoteFiles: { 'a.md': remoteEdit, 'new-remote.md': 'from remote\n' },
      remoteMessage: 'remote: conflict edit',
    });
    makeDirty(pair.local, { 'a.md': A_MD_LOCAL });

    const result = await handlers.gitPublishPreview(1, 'local: conflicting edit');

    // Task 3 (conflict-strategy-modal): a REAL conflict never auto-merges —
    // the flow pauses for a user decision.
    expect(result.success).toBe(false);
    expect(result.code).toBe('CONFLICT_PENDING');
    expect(result.flow).toBe('publish');
    expect(result.files).toContain('a.md');
    expect(result.strategies).toEqual([
      'MERGE_LOCAL', 'MERGE_REMOTE', 'FULL_LOCAL', 'FULL_REMOTE',
    ]);
    expect(handlers.gitOperationInProgress).toBe(false);

    const resumed = await handlers.gitResolveConflict(result.resumeToken, 'MERGE_LOCAL');

    expect(resumed.success).toBe(true);
    const aMd = await pair.local.readFile('a.md');
    // LOCAL wins the conflicting hunk...
    expect(aMd).toContain('line5-LOCAL');
    expect(aMd).not.toContain('line5-REMOTE');
    // ...remote non-conflicting file still integrated.
    expect(fs.existsSync(path.join(pair.local.dir, 'new-remote.md'))).toBe(true);
  });
});

// ─── Scenario (b): push rejected → typed error, zero local loss ─────────────

describe('gitPublishPreview — push rejected (PUSH_REJECTED)', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({
      branch: 'preview',
      files: { 'a.md': A_MD_BASE },
    });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('returns typed PUSH_REJECTED with intact working tree and retained backup', async () => {
    await makeDivergent(pair, {
      remoteFiles: { 'c.md': 'remote content\n' },
      remoteMessage: 'remote: add c.md',
    });
    makeDirty(pair.local, { 'a.md': A_MD_LOCAL });

    // Mock the FINAL push to be rejected by the remote (non-fast-forward).
    vi.spyOn(handlers.git, 'push').mockRejectedValue(
      Object.assign(new Error('push rejected: non-fast-forward'), {
        code: 'PushRejectedError',
      })
    );

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

    // Typed error + guidance for the renderer ("update first").
    expect(result.success).toBe(false);
    expect(result.code).toBe('PUSH_REJECTED');
    expect(result.error).toMatch(/atualiz/i);

    // Zero local loss: working tree still has the local edit (committed
    // by the flow, never reset) and the remote file integration.
    const aMd = await pair.local.readFile('a.md');
    expect(aMd).toContain('line5-LOCAL');

    // Mandatory backup exists and was NOT deleted.
    const branches = await handlers.git.listBranches(pair.local.dir);
    const names = branches.map((b) => (typeof b === 'string' ? b : b.name));
    expect(names.some((n) => n.startsWith('backup/'))).toBe(true);

    // Lock released.
    expect(handlers.gitOperationInProgress).toBe(false);
  });
});

// ─── T11-D1 regression: push ref-lock race classified as PUSH_REJECTED ──────

describe('_isPushRejected — ref-lock race variants (T11-D1)', () => {
  const RACE_MESSAGE =
    "remote: error: cannot lock ref 'refs/heads/preview': is at 3f2a1b but expected 9c8d7e " +
    '! [remote rejected] refs/heads/preview -> refs/heads/preview (incorrect old value provided)';

  it('classifies the E2E-captured race message as rejected', () => {
    const handlers = makeHandlers('/unused');
    expect(handlers._isPushRejected(new Error(RACE_MESSAGE))).toBe(true);
    expect(handlers._isPushRejected(new Error('cannot lock ref'))).toBe(true);
    expect(handlers._isPushRejected(new Error('push failed: incorrect old value provided'))).toBe(true);
    expect(handlers._isPushRejected(new Error('[remote rejected] preview (fetch first)'))).toBe(true);
  });

  it('does not swallow unrelated errors', () => {
    const handlers = makeHandlers('/unused');
    expect(handlers._isPushRejected(new Error('HTTP Error: 401 Unauthorized'))).toBe(false);
    expect(handlers._isPushRejected(new Error('ECONNREFUSED network down'))).toBe(false);
    expect(handlers._isPushRejected(new Error('disk full'))).toBe(false);
  });
});

// ─── F3-D1 regression: publish recovers after guided refresh ────────────────
//
// Post-recovery topology (PUSH_REJECTED → Atualizar → re-publish):
// origin/preview is an ANCESTOR of HEAD, but the depth:1 fetch +
// iso-git's broken canFastForward (module has NO such export — the
// provider call always threw) forced the merge path, where
// findMergeBase returns NON-MINIMAL multiple bases and iso-git merge
// dies with MergeNotSupportedError. Recovery must skip the merge
// entirely (local strictly ahead) and push.

describe('F3-D1 — re-publish after PUSH_REJECTED + guided refresh', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({
      branch: 'preview',
      files: { 'a.md': A_MD_BASE, 'docs.txt': 'v0\n' },
    });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('provider canFastForward resolves ancestry (isomorphic-git has no native export)', async () => {
    await makeDivergent(pair, {
      localFiles: { 'docs.txt': 'local\n' },
      localMessage: 'local: ahead',
    });
    await pair.local.fetch();
    // local HEAD is a strict descendant of origin/preview
    await expect(
      handlers.git.canFastForward(pair.local.dir, { ref: 'origin/preview', target: 'HEAD' })
    ).resolves.toBe(true);
    // reverse direction is false
    await expect(
      handlers.git.canFastForward(pair.local.dir, { ref: 'HEAD', target: 'origin/preview' })
    ).resolves.toBe(false);
  });

  it('re-publish after recovery skips the merge (local ahead) and succeeds', async () => {
    // 1. healthy publish establishes origin/preview
    makeDirty(pair.local, { 'docs.txt': 'v1\n' });
    let result = await handlers.gitPublishPreview(1, 'publish 1');
    expect(result.success).toBe(true);

    // 2. origin advances (the advertisement race the UI cannot absorb)
    await makeDivergent(pair, {
      remoteFiles: { 'c.md': 'remote race\n' },
      remoteMessage: 'remote: race commit',
    });

    // 3. publish with the push rejected → typed PUSH_REJECTED
    makeDirty(pair.local, { 'docs.txt': 'v2\n' });
    const pushSpy = vi.spyOn(handlers.git, 'push').mockRejectedValueOnce(
      Object.assign(new Error('! [remote rejected] preview (incorrect old value provided)'), {
        code: 'PushRejectedError',
      })
    );
    result = await handlers.gitPublishPreview(1, 'publish 2 (rejected)');
    pushSpy.mockRestore();
    expect(result.success).toBe(false);
    expect(result.code).toBe('PUSH_REJECTED');

    // 4. guided recovery: Atualizar merges the remote race commit
    result = await handlers.gitRefresh(1);
    expect(result.success).toBe(true);

    // 5. re-publish MUST succeed and MUST NOT enter the merge path —
    //    origin/preview is now an ancestor of the local HEAD
    makeDirty(pair.local, { 'docs.txt': 'v3\n' });
    const mergeSpy = vi.spyOn(handlers.git, 'merge');
    result = await handlers.gitPublishPreview(1, 'publish 3 (recovery)');
    expect(result.success).toBe(true);
    expect(mergeSpy).not.toHaveBeenCalled();

    // origin has everything: race commit + all three publishes
    const head = await pair.local.resolveRef('HEAD');
    const origin = await pair.local.resolveRef('refs/remotes/origin/preview');
    expect(head).toBe(origin);
    expect((await pair.local.readFile('docs.txt')).trim()).toBe('v3');
    expect(await pair.local.readFile('c.md')).toBe('remote race\n');
  });
});

// ─── No-upstream compensation (backup path) ─────────────────────────────────

describe('gitPushToBranch — no upstream treated as all-unpushed', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    // No base files → local commits exist but origin has NO branch yet.
    pair = await createRepoPair({ branch: 'preview' });
    await pair.local.writeFiles({ 'a.md': A_MD_BASE });
    await pair.local.commit('local: initial', 'a.md');
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('creates a backup even with a CLEAN tree when origin/<branch> is missing', async () => {
    // Spy at the gitSafety boundary: backup decision must see "unpushed"
    // even though the working tree is clean and the remote ref is absent.
    const result = await handlers.gitPushToBranch(pair.local.dir, 'preview', null);

    expect(result.success).toBe(true);
    const branches = await handlers.git.listBranches(pair.local.dir);
    const names = branches.map((b) => (typeof b === 'string' ? b : b.name));
    expect(names.some((n) => n.startsWith('backup/'))).toBe(true);
    // First publish created the remote branch.
    const origin = await pair.local.resolveRef('refs/remotes/origin/preview');
    expect(origin).toBe(await pair.local.resolveRef('HEAD'));
  });
});
