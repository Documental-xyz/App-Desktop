/**
 * @fileoverview Task 8 (git-sync-strategy): publish-main flow rewritten
 * as lock + WIP commit + mandatory backup + merge PREVIEW-WINS.
 *
 * Integration tests against REAL repositories (isomorphic-git over a
 * loopback http bare origin — see tests/git/fixtures/harness.js), driven
 * through the production GitHandlers class. Scenarios (plan QA):
 *   (a) ANTI-INVERSION — same conflicting fixture shape as the Task 7
 *       refresh flow, but here PREVIEW wins the merged line on
 *       origin/main (the OPPOSITE winner of refresh);
 *   (b) post-success: working branch back on `preview`, origin/main
 *       contains a merge commit (two parents), local unpublished WIP
 *       stays on preview (NOT auto-moved to main);
 *   (c) push rejected → typed PUSH_REJECTED error, local intact
 *       (backup retained, WIP commit preserved on preview).
 *
 * @vitest-environment node
 */

import { vi } from 'vitest';

// tests/setup.js mocks fs/path globally — these fixtures need the REAL fs.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import gitModule from 'isomorphic-git';

import { createRepoPair, commitFile, makeDirty } from './fixtures/harness.js';
import { GitHandlers } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { providerFactory } from '../git-providers/harness.js';

const git = gitModule.default || gitModule;

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
  vi.spyOn(handlers.gitOps, 'getGitHubUserInfo').mockResolvedValue({ login: 'testuser' });
  // Preflight probes the real GitHub remote; the flow under test detects
  // missing branches by itself (typed MAIN_MISSING from its own fetch).
  handlers.gitPreflight = null;
  return handlers;
}

const BASE = 'line1\nline2\nline3\n';
const MAIN_VERSION = 'line1\nline2-MAIN\nline3\n';
const PREVIEW_VERSION = 'line1\nline2-PREVIEW\nline3\n';

/**
 * Build the promotable state:
 *   - origin/main = base + MAIN conflicting edit (by the colleague)
 *   - local on `preview` = base + PREVIEW conflicting edit, pushed
 *   - local dirty file (unpublished WIP) that must STAY on preview
 */
async function setupPromotable(pair) {
  // Colleague advances origin/main with a conflicting edit of line 2.
  await commitFile(pair.remote, 'conflict.txt', MAIN_VERSION, 'main: edit line2');
  await pair.remote.push('main');

  // Local branches preview at the common base and publishes the preview
  // side of the conflict.
  const baseOid = await pair.local.head();
  await git.branch({ fs, dir: pair.local.dir, ref: 'preview', object: baseOid });
  await git.checkout({ fs, dir: pair.local.dir, ref: 'preview' });
  await commitFile(pair.local, 'conflict.txt', PREVIEW_VERSION, 'preview: edit line2');
  await pair.local.push('preview');

  // Unpublished local-only work (dirty tree → WIP auto-commit in the flow).
  makeDirty(pair.local, { 'local-note.md': 'unpublished WIP\n' });
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

describe('gitPublishMain — preview-wins promote', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({
      branch: 'main',
      files: { 'conflict.txt': BASE },
    });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('ANTI-INVERSION: preview wins the conflicting line on origin/main (opposite of refresh)', async () => {
    await setupPromotable(pair);

    const result = await handlers.gitPublishMain(1);

    expect(result.success).toBe(true);

    // Round-trip through the REAL remote: colleague fetches and sees the
    // promoted content — the PREVIEW version of the conflicting line.
    // (checkout origin/main — the colleague's own local main is stale.)
    await pair.remote.fetch();
    await git.checkout({ fs, dir: pair.remote.dir, ref: 'origin/main', force: true });
    const promoted = await pair.remote.readFile('conflict.txt');
    expect(promoted).toContain('line2-PREVIEW');
    expect(promoted).not.toContain('line2-MAIN');

    // The unpublished WIP file was NOT auto-moved to main.
    expect(fs.existsSync(path.join(pair.remote.dir, 'local-note.md'))).toBe(false);
  });

  it('post-success: back on preview, merge commit on origin/main, WIP retained locally', async () => {
    await setupPromotable(pair);

    const result = await handlers.gitPublishMain(1);

    expect(result.success).toBe(true);
    expect(result.branch).toBe('preview');

    // Working branch is back on preview, with the WIP file materialized.
    expect(await handlers.git.currentBranch(pair.local.dir)).toBe('preview');
    expect(fs.existsSync(path.join(pair.local.dir, 'local-note.md'))).toBe(true);

    // origin/main advanced to a MERGE commit (two parents — no fast-forward).
    const originMain = await pair.local.resolveRef('refs/remotes/origin/main');
    const { commit } = await git.readCommit({
      fs, dir: pair.local.dir, oid: originMain,
    });
    expect(commit.parent).toHaveLength(2);
    expect(commit.message).toMatch(/promote/i);

    // The WIP commit stays on LOCAL preview only (login-stamped).
    const previewLog = await git.log({ fs, dir: pair.local.dir, ref: 'preview', depth: 10 });
    const messages = previewLog.map((c) => c.commit.message);
    expect(messages.some((m) => m.startsWith('WIP by testuser at'))).toBe(true);

    // Lock released.
    expect(handlers.gitOperationInProgress).toBe(false);
  });

  it('push rejected → typed PUSH_REJECTED, local intact (backup + WIP preserved)', async () => {
    await setupPromotable(pair);

    vi.spyOn(handlers.git, 'push').mockRejectedValue(
      Object.assign(new Error('push rejected: non-fast-forward'), {
        code: 'PushRejectedError',
      })
    );

    const result = await handlers.gitPublishMain(1);

    // Typed error + guidance for the renderer ("update first").
    expect(result.success).toBe(false);
    expect(result.code).toBe('PUSH_REJECTED');
    expect(result.error).toMatch(/atualiz/i);

    // Local intact: preview branch keeps the preview edit AND the WIP commit.
    const previewLog = await git.log({ fs, dir: pair.local.dir, ref: 'preview', depth: 10 });
    const messages = previewLog.map((c) => c.commit.message);
    expect(messages.some((m) => m.includes('preview: edit line2'))).toBe(true);
    expect(messages.some((m) => m.startsWith('WIP by testuser at'))).toBe(true);

    // Mandatory backup exists and was NOT deleted.
    const branches = await handlers.git.listBranches(pair.local.dir);
    const names = branches.map((b) => (typeof b === 'string' ? b : b.name));
    expect(names.some((n) => n.startsWith('backup/'))).toBe(true);

    // Lock released.
    expect(handlers.gitOperationInProgress).toBe(false);
  });
});
