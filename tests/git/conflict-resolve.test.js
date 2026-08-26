/**
 * @fileoverview conflict-strategy-modal Task 3: IPC pending-confirmation
 * roundtrip in the 3 sync flows (publish / refresh / publish-main).
 *
 * Contract under test:
 *   1. REAL conflict → typed CONFLICT_PENDING result (flow, files,
 *      strategies, resumeToken) with ZERO merge mutation — no merge
 *      commit, HEAD unmoved, WIP commit + backup retained, lock released.
 *   2. gitResolveConflict(token, strategy) resumes the flow with the
 *      chosen driver — each of the 4 strategies resolves with the right
 *      winner, both sides stay in history, the push completes.
 *   3. CANCEL = clean abort (repo intact, token consumed).
 *   4. Token security: single-use, TTL expiry, forged tokens rejected.
 *
 * @vitest-environment node
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';

import { createRepoPair, makeDivergent, makeDirty } from './fixtures/harness.js';
import { httpBackendAvailable } from './fixtures/harness.js';
import { GitHandlers } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { providerFactory } from '../git-providers/harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

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
    gitService: new GitService({ provider: providerFactory('isomorphic-git')() }),
  });
  vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('test-token');
  vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
  vi.spyOn(handlers.gitOps, 'getGitHubUserInfo').mockResolvedValue({ login: 'testuser' });
  handlers.gitPreflight = null;
  return handlers;
}

const A_BASE = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
const A_LOCAL = A_BASE.replace('line5', 'line5-LOCAL');
const A_REMOTE = A_BASE.replace('line5', 'line5-REMOTE');

async function conflictPair(handlersFactory) {
  const pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
  const handlers = handlersFactory(pair.local.dir);
  await makeDivergent(pair, {
    remoteFiles: { 'a.md': A_REMOTE, 'new-remote.md': 'from remote\n' },
    remoteMessage: 'remote: conflict edit',
  });
  makeDirty(pair.local, { 'a.md': A_LOCAL });
  return { pair, handlers };
}

function backupNames(handlers, dir) {
  return handlers.git.listBranches(dir).then((bs) =>
    bs.map((b) => (typeof b === 'string' ? b : b.name)).filter((n) => n.startsWith('backup/'))
  );
}

// ─── 1. Detection → CONFLICT_PENDING (no merge mutation) ─────────────────────

describe.skipIf(!httpBackendAvailable)('publish — real conflict returns CONFLICT_PENDING without merging', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  let pair;
  let handlers;
  let headBefore;

  beforeEach(async () => {
    ({ pair, handlers } = await conflictPair(makeHandlers));
    headBefore = await pair.local.head();
  });
  afterEach(() => pair.dispose());

  it('returns the typed payload and mutates nothing beyond WIP commit + backup', async () => {
    const result = await handlers.gitPublishPreview(1, 'local: conflicting edit');

    expect(result.success).toBe(false);
    expect(result.code).toBe('CONFLICT_PENDING');
    expect(result.flow).toBe('publish');
    expect(result.files).toContain('a.md');
    expect(result.strategies).toEqual([
      'MERGE_LOCAL', 'MERGE_REMOTE', 'FULL_LOCAL', 'FULL_REMOTE',
    ]);
    expect(typeof result.resumeToken).toBe('string');
    expect(result.resumeToken.length).toBeGreaterThanOrEqual(32);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.detail.ours).toBeTruthy();
    expect(result.detail.theirs).toBeTruthy();

    // No merge ran: no merge commit, HEAD only advanced by the WIP commit
    // (still NOT merged with the remote edit).
    const messages = (await pair.local.log(20)).map((c) => c.commit.message);
    expect(messages.some((m) => /merge/i.test(m))).toBe(false);
    const aMd = await pair.local.readFile('a.md');
    expect(aMd).toContain('line5-LOCAL');
    expect(aMd).not.toContain('line5-REMOTE');
    expect(fs.existsSync(path.join(pair.local.dir, 'new-remote.md'))).toBe(false);

    // Protection already in place: WIP commit + mandatory backup retained.
    expect(messages.some((m) => m.includes('local: conflicting edit'))).toBe(true);
    expect((await backupNames(handlers, pair.local.dir)).length).toBeGreaterThan(0);

    // Lock released while the decision is pending.
    expect(handlers.gitOperationInProgress).toBe(false);
    void headBefore;
  });
});

describe.skipIf(!httpBackendAvailable)('refresh — real conflict returns CONFLICT_PENDING', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  let pair;
  let handlers;

  beforeEach(async () => {
    ({ pair, handlers } = await conflictPair(makeHandlers));
  });
  afterEach(() => pair.dispose());

  it('returns the typed payload for the refresh flow, no merge commit', async () => {
    const result = await handlers.gitRefresh(1);

    expect(result.success).toBe(false);
    expect(result.code).toBe('CONFLICT_PENDING');
    expect(result.flow).toBe('refresh');
    expect(result.files).toContain('a.md');

    const messages = (await pair.local.log(20)).map((c) => c.commit.message);
    expect(messages.some((m) => /merge/i.test(m))).toBe(false);
    expect(messages.some((m) => m.startsWith('WIP by testuser at'))).toBe(true);
    expect(handlers.gitOperationInProgress).toBe(false);
  });
});

// ─── 2. Resume with each of the 4 strategies ─────────────────────────────────

describe.skipIf(!httpBackendAvailable).each([
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  ['MERGE_LOCAL', 'line5-LOCAL', 'line5-REMOTE'],
  ['FULL_LOCAL', 'line5-LOCAL', 'line5-REMOTE'],
  ['MERGE_REMOTE', 'line5-REMOTE', 'line5-LOCAL'],
  ['FULL_REMOTE', 'line5-REMOTE', 'line5-LOCAL'],
])('publish resume [%s]', (strategy, winner, loser) => {
  let pair;
  let handlers;

  beforeEach(async () => {
    ({ pair, handlers } = await conflictPair(makeHandlers));
  });
  afterEach(() => pair.dispose());

  it(`resumes with ${winner} winning; push completes; both sides in history`, async () => {
    const pending = await handlers.gitPublishPreview(1, 'local: conflicting edit');
    expect(pending.code).toBe('CONFLICT_PENDING');

    const result = await handlers.gitResolveConflict(pending.resumeToken, strategy);

    expect(result.success).toBe(true);
    expect(result.branch).toBe('preview');

    const aMd = await pair.local.readFile('a.md');
    expect(aMd).toContain(winner);
    expect(aMd).not.toContain(loser);
    // Non-conflicting remote content integrated in every strategy.
    expect(fs.existsSync(path.join(pair.local.dir, 'new-remote.md'))).toBe(true);

    // Push completed: local HEAD == origin/preview.
    expect(await pair.local.resolveRef('HEAD')).toBe(
      await pair.local.resolveRef('refs/remotes/origin/preview')
    );

    // Both versions stay reachable (merge commit + both edits in history).
    const messages = (await pair.local.log(20)).map((c) => c.commit.message);
    expect(messages.some((m) => m.includes('remote: conflict edit'))).toBe(true);
    expect(messages.some((m) => m.includes('local: conflicting edit'))).toBe(true);
    expect(messages.some((m) => new RegExp(`merge.*${strategy}`, 'i').test(m))).toBe(true);

    expect(handlers.gitOperationInProgress).toBe(false);

    // Single-use: the consumed token cannot resume again.
    const reuse = await handlers.gitResolveConflict(pending.resumeToken, strategy);
    expect(reuse.success).toBe(false);
    expect(reuse.code).toBe('INVALID_TOKEN');
  });
});

// ─── 3. CANCEL = clean abort ─────────────────────────────────────────────────

describe.skipIf(!httpBackendAvailable)('CANCEL — clean abort, repo intact', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  let pair;
  let handlers;

  beforeEach(async () => {
    ({ pair, handlers } = await conflictPair(makeHandlers));
  });
  afterEach(() => pair.dispose());

  it('returns CANCELLED, keeps WIP + backup, never merges, consumes the token', async () => {
    const pending = await handlers.gitPublishPreview(1, 'local: conflicting edit');
    expect(pending.code).toBe('CONFLICT_PENDING');
    const backupsAtPending = (await backupNames(handlers, pair.local.dir)).length;
    expect(backupsAtPending).toBeGreaterThan(0);

    const result = await handlers.gitResolveConflict(pending.resumeToken, 'CANCEL');

    expect(result.success).toBe(false);
    expect(result.code).toBe('CANCELLED');

    // Nothing beyond what was already safe: no merge commit, local version
    // intact, backup kept, remote file NOT integrated.
    const messages = (await pair.local.log(20)).map((c) => c.commit.message);
    expect(messages.some((m) => /merge/i.test(m))).toBe(false);
    expect(await pair.local.readFile('a.md')).toContain('line5-LOCAL');
    expect(fs.existsSync(path.join(pair.local.dir, 'new-remote.md'))).toBe(false);
    expect((await backupNames(handlers, pair.local.dir)).length).toBe(backupsAtPending);
    expect(handlers.gitOperationInProgress).toBe(false);

    // Token consumed — a later strategy call is rejected.
    const late = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
    expect(late.code).toBe('INVALID_TOKEN');
  });
});

// ─── 4. Token security: expiry, forgery, invalid strategy ────────────────────

describe.skipIf(!httpBackendAvailable)('resume token security', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  let pair;
  let handlers;

  beforeEach(async () => {
    ({ pair, handlers } = await conflictPair(makeHandlers));
  });
  afterEach(() => pair.dispose());

  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    const pending = await handlers.gitPublishPreview(1, 'local: conflicting edit');
    const entry = handlers._pendingConflicts.get(pending.resumeToken);
    entry.expiresAt = Date.now() - 1000;

    const result = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');

    expect(result.success).toBe(false);
    expect(result.code).toBe('TOKEN_EXPIRED');
    expect(handlers.gitOperationInProgress).toBe(false);
  });

  it('rejects a forged/unknown token with INVALID_TOKEN', async () => {
    const result = await handlers.gitResolveConflict('forged-token-123', 'MERGE_LOCAL');
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_TOKEN');
  });

  it('rejects an invalid strategy without consuming the token', async () => {
    const pending = await handlers.gitPublishPreview(1, 'local: conflicting edit');

    const bad = await handlers.gitResolveConflict(pending.resumeToken, 'KEEP_BOTH');
    expect(bad.success).toBe(false);
    expect(bad.code).toBe('INVALID_STRATEGY');

    // Token survives an INVALID_STRATEGY attempt — a valid resume still works.
    const ok = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
    expect(ok.success).toBe(true);
  });
});

// ─── 5. publish-main: preview/main mapping ───────────────────────────────────

describe.skipIf(!httpBackendAvailable)('publish-main — conflict pending + resume mapping', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'main', files: { 'conflict.txt': 'line1\nline2\nline3\n' } });
    handlers = makeHandlers(pair.local.dir);
  });
  afterEach(() => pair.dispose());

  beforeEach(async () => {
    // origin/main advances with a MAIN conflicting edit (colleague).
    pair.remote.writeFiles({ 'conflict.txt': 'line1\nline2-MAIN\nline3\n' });
    await pair.remote.commit('main: edit line2', 'conflict.txt');
    await pair.remote.push('main');
    // local preview publishes the PREVIEW side of the conflict.
    const git = (await import('isomorphic-git')).default;
    const fsReal = fs;
    const baseOid = await pair.local.head();
    await git.branch({ fs: fsReal, dir: pair.local.dir, ref: 'preview', object: baseOid });
    await git.checkout({ fs: fsReal, dir: pair.local.dir, ref: 'preview' });
    pair.local.writeFiles({ 'conflict.txt': 'line1\nline2-PREVIEW\nline3\n' });
    await pair.local.commit('preview: edit line2', 'conflict.txt');
    await pair.local.push('preview');
  });

  it('MERGE_REMOTE keeps PREVIEW (their side) on origin/main after resume', async () => {
    const pending = await handlers.gitPublishMain(1);
    expect(pending.success).toBe(false);
    expect(pending.code).toBe('CONFLICT_PENDING');
    expect(pending.flow).toBe('publish-main');
    expect(pending.files).toContain('conflict.txt');
    // Back on the preview working branch while pending.
    expect(await handlers.git.currentBranch(pair.local.dir)).toBe('preview');

    const result = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_REMOTE');
    expect(result.success).toBe(true);

    // Round-trip through the REAL remote.
    const git = (await import('isomorphic-git')).default;
    await pair.remote.fetch();
    await git.checkout({ fs, dir: pair.remote.dir, ref: 'origin/main', force: true });
    const promoted = await pair.remote.readFile('conflict.txt');
    expect(promoted).toContain('line2-PREVIEW');
    expect(promoted).not.toContain('line2-MAIN');
    expect(handlers.gitOperationInProgress).toBe(false);
  });

  it('MERGE_LOCAL keeps MAIN (our side) on origin/main after resume', async () => {
    const pending = await handlers.gitPublishMain(1);
    expect(pending.code).toBe('CONFLICT_PENDING');

    const result = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
    expect(result.success).toBe(true);

    const git = (await import('isomorphic-git')).default;
    await pair.remote.fetch();
    await git.checkout({ fs, dir: pair.remote.dir, ref: 'origin/main', force: true });
    const promoted = await pair.remote.readFile('conflict.txt');
    expect(promoted).toContain('line2-MAIN');
    expect(promoted).not.toContain('line2-PREVIEW');
  });
});
