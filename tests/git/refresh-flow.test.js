/**
 * @fileoverview Task 7 (git-sync-strategy): refresh flow rewritten as
 * WIP auto-commit + merge LOCAL-WINS — the END of the hard reset.
 *
 * Integration tests against REAL repositories (isomorphic-git over a
 * loopback http bare origin — see tests/git/fixtures/harness.js), driven
 * through the production GitHandlers class. Scenarios (plan QA):
 *   (a) dirty tree + remote edits the SAME file on a DIFFERENT line →
 *       BOTH edits in the working tree; WIP commit + merge commit in
 *       history; NO hard reset anywhere;
 *   (b) dirty tree + conflict on the SAME line → LOCAL version in the
 *       working tree; remote commit still reachable in history (merge);
 *   (c) repo without origin/preview → typed NO_UPSTREAM friendly error
 *       guiding the user to publish first.
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
  const handlers = new GitHandlers({
    logger: makeLogger(),
    databaseManager,
  });
  vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('test-token');
  vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
  vi.spyOn(handlers.gitOps, 'getGitHubUserInfo').mockResolvedValue({ login: 'testuser' });
  handlers.gitPreflight = null;
  return handlers;
}

const B_MD_BASE = Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join('\n') + '\n';

// ─── Scenario (a): dirty tree + remote same-file edit (different lines) ─────

describe('gitRefresh — dirty tree + remote divergence, no hard reset', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({
      branch: 'preview',
      files: { 'b.md': B_MD_BASE },
    });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('keeps BOTH edits in the working tree and WIP + merge commits in history', async () => {
    // Remote (colleague) edits line 50 of the SAME file and pushes.
    await makeDivergent(pair, {
      remoteFiles: { 'b.md': B_MD_BASE.replace('line50', 'line50-REMOTE') },
      remoteMessage: 'remote: edit line 50',
    });
    // Local dirty edit on a DIFFERENT line (line 10), uncommitted.
    makeDirty(pair.local, { 'b.md': B_MD_BASE.replace('line10', 'line10-LOCAL') });

    const result = await handlers.gitRefresh(1);

    expect(result.success).toBe(true);
    expect(result.branch).toBe('preview');

    // The working tree has BOTH the local dirty edit AND the remote edit —
    // the old hard reset would have wiped line10-LOCAL.
    const bMd = await pair.local.readFile('b.md');
    expect(bMd).toContain('line10-LOCAL');
    expect(bMd).toContain('line50-REMOTE');

    // History: WIP auto-commit (login-stamped) + the remote commit + a
    // merge commit integrating both sides.
    const messages = (await pair.local.log(20)).map((c) => c.commit.message);
    expect(messages.some((m) => m.startsWith('WIP by testuser at'))).toBe(true);
    expect(messages.some((m) => m.includes('remote: edit line 50'))).toBe(true);
    expect(messages.some((m) => /merge/i.test(m))).toBe(true);

    // A backup branch was created (dirty tree → WIP commit → unpushed) and
    // retained (never deleted).
    const branches = await handlers.git.listBranches(pair.local.dir);
    const names = branches.map((b) => (typeof b === 'string' ? b : b.name));
    expect(names.some((n) => n.startsWith('backup/'))).toBe(true);

    // Lock released.
    expect(handlers.gitOperationInProgress).toBe(false);
  });
});

// ─── Scenario (b): dirty tree + conflict on the SAME line ───────────────────

describe('gitRefresh — same-line conflict: LOCAL wins, remote preserved in history', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({
      branch: 'preview',
      files: { 'b.md': 'line1\nline2\nline3\n' },
    });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('keeps the LOCAL version in the working tree while the remote commit stays reachable', async () => {
    // Remote commits line2 → REMOTE and pushes; local edits line2 → LOCAL
    // WITHOUT committing (dirty tree).
    await makeDivergent(pair, {
      remoteFiles: { 'b.md': 'line1\nline2-REMOTE\nline3\n' },
      remoteMessage: 'remote: edit line2',
    });
    makeDirty(pair.local, { 'b.md': 'line1\nline2-LOCAL\nline3\n' });

    const result = await handlers.gitRefresh(1);

    expect(result.success).toBe(true);
    const bMd = await pair.local.readFile('b.md');
    expect(bMd).toContain('line2-LOCAL');
    expect(bMd).not.toContain('line2-REMOTE');

    // Remote commit reachable in history (merge commit parent).
    const messages = (await pair.local.log(20)).map((c) => c.commit.message);
    expect(messages.some((m) => m.includes('remote: edit line2'))).toBe(true);
    expect(messages.some((m) => /merge/i.test(m))).toBe(true);
    expect(messages.some((m) => m.startsWith('WIP by testuser at'))).toBe(true);
  });
});

// ─── Scenario (c): no origin/preview → typed NO_UPSTREAM ────────────────────

describe('gitRefresh — missing upstream (origin/preview does not exist)', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    // No base files → local repo has commits but origin has NO branch.
    pair = await createRepoPair({ branch: 'preview' });
    await pair.local.writeFiles({ 'a.md': 'local only\n' });
    await pair.local.commit('local: initial', 'a.md');
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('returns a typed NO_UPSTREAM error guiding the user to publish first', async () => {
    const result = await handlers.gitRefresh(1);

    expect(result.success).toBe(false);
    expect(result.code).toBe('NO_UPSTREAM');
    expect(result.error).toMatch(/publish|publicar/i);

    // Local work untouched.
    expect(await pair.local.readFile('a.md')).toBe('local only\n');
    expect(handlers.gitOperationInProgress).toBe(false);
  });
});
