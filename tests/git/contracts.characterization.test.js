/**
 * @fileoverview publish-update-resilience Task 1 — CHARACTERIZATION
 * (tripwire) tests for the 3 FROZEN contracts. Written BEFORE any change
 * to the publish/update flows: green against the CURRENT code on
 * purpose. If a future task breaks one of these asserts, that task
 * either broke a contract the renderer/T7 depends on — or must
 * consciously re-freeze the contract HERE, with a justification.
 *
 *   Block 1 — CONFLICT_PENDING IPC result (git.js _mintConflictPending):
 *             exact field-by-field shape, single-use resumeToken,
 *             15-min TTL (TOKEN_EXPIRED), CANCEL leaves the repo
 *             untouched (branch/HEAD/worktree).
 *   Block 2 — RECOVERY contract (git.js:3024 comment + gitSafety.js):
 *             cancel mid-publish KEEPS the backup branch; backup
 *             naming `backup/<branch>-<sha7>-<epoch>`; pruneOldBackups
 *             deletes only backups older than 7 days.
 *   Block 3 — dirty-tree capture (LOAD-BEARING, gitSafety.js:268-277):
 *             the backup branch created by withMandatoryBackup contains
 *             the UNCOMMITTED working tree (snapshot commit) — the
 *             property task 7 (auto-restore) depends on.
 *
 * Canonical structure inherited from tests/git/{publish-flow,
 * conflict-resolve}.test.js: real repos over the loopback
 * git-http-backend, dugite provider, DI of GitHandlers, direct method
 * calls (no electron IPC layer).
 *
 * @vitest-environment node
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// tests/setup.js mocks fs/path globally (setupFiles vi.mock) — these
// fixtures need the REAL filesystem (temp repos, http server).
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import gitModule from 'isomorphic-git';

import {
  createRepoPair,
  makeDivergent,
  makeDirty,
  httpBackendAvailable,
} from './fixtures/harness.js';
import { GitHandlers } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { providerFactory } from '../git-providers/harness.js';
import { createObjectStyleOps } from '../../src/ipc/gitSafety.js';
import { BACKUP_BRANCH_PREFIX } from '../../src/ipc/gitFlowTypes.js';

const git = gitModule.default || gitModule;

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ─── Canonical DI helpers (publish-flow.test.js structure) ───────────────────

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Production GitHandlers whose getProjectPath(1) resolves to
 * `projectPath`, PINNED to the dugite provider (the provider active in
 * the app — .env GIT_PROVIDER=dugite).
 */
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
    gitService: new GitService({ provider: providerFactory('dugite')() }),
  });
  vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('test-token');
  vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
  vi.spyOn(handlers.gitOps, 'getGitHubUserInfo').mockResolvedValue({ login: 'testuser' });
  handlers.gitPreflight = null;
  return handlers;
}

/** Local branch list (dugite returns strings; iso objects — map both). */
function branchNames(handlers, dir) {
  return handlers.git
    .listBranches(dir)
    .then((bs) => bs.map((b) => (typeof b === 'string' ? b : b.name)));
}

function backupNames(handlers, dir) {
  return branchNames(handlers, dir).then((names) =>
    names.filter((n) => n.startsWith(BACKUP_BRANCH_PREFIX))
  );
}

/**
 * Read a file's blob content straight from a branch ref (no checkout,
 * no working-tree side effects) — the read-only oracle for Block 3.
 */
async function blobAt(repo, ref, filepath) {
  const oid = await repo.resolveRef(ref);
  const { blob } = await git.readBlob({ fs, dir: repo.dir, oid, filepath });
  return Buffer.from(blob).toString('utf8');
}

/**
 * Seed a backup-named branch whose TIP COMMIT carries a committer
 * timestamp `ageDays` in the past — pruneOldBackups reads that clock
 * (readCommit), same pattern as tests/git/gitSafety-pruning.test.js.
 */
async function seedBackupAtAge(repo, name, ageDays) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const ts = Math.floor((Date.now() - ageDays * DAY_MS) / 1000);
  const file = `seed-${name.replace(/[^a-z0-9]/gi, '_')}.txt`;
  repo.writeFiles({ [file]: name });
  await git.add({ fs, dir: repo.dir, filepath: file });
  await git.commit({
    fs,
    dir: repo.dir,
    message: `seed backup ${name}`,
    author: { name: 'test', email: 'test@test.local', timestamp: ts },
  });
  await git.branch({ fs, dir: repo.dir, ref: name, checkout: false });
}

// Distinct-content fixtures (10 lines; the edited line changes LENGTH —
// iso-git's same-second stat-cache gotcha documented in the notepad).
const A_BASE = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
const A_LOCAL = A_BASE.replace('line5', 'line5-LOCAL-EDIT');
const A_REMOTE = A_BASE.replace('line5', 'line5-REMOTE-EDIT');

/**
 * Real-conflict scenario: origin/preview advanced with a conflicting
 * edit of a.md + a clean remote-only file; the local edit is DIRTY.
 * `gitPublishPreview` must return CONFLICT_PENDING for it.
 */
async function conflictPair() {
  const pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
  const baseSha = await pair.local.head();
  const { originHead } = await makeDivergent(pair, {
    remoteFiles: { 'a.md': A_REMOTE, 'new-remote.md': 'from remote\n' },
    remoteMessage: 'remote: conflict edit',
  });
  makeDirty(pair.local, { 'a.md': A_LOCAL });
  const handlers = makeHandlers(pair.local.dir);
  return { pair, handlers, baseSha, originHead };
}

// ─── BLOCK 1 — CONFLICT_PENDING result + token lifecycle ────────────────────

describe.skipIf(!httpBackendAvailable)('CONTRACT 1 — CONFLICT_PENDING result shape + token lifecycle', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  let pair;
  let handlers;
  let baseSha;
  let originHead;

  beforeEach(async () => {
    ({ pair, handlers, baseSha, originHead } = await conflictPair());
  });
  afterEach(() => pair.dispose());

  it('real conflict: field-by-field frozen result shape (IPC contract)', async () => {
    const result = await handlers.gitPublishPreview(1, 'local: conflicting edit');

    // Exact key set — adding/removing a field is a contract change.
    expect(Object.keys(result).sort()).toEqual([
      'code', 'detail', 'error', 'expiresAt', 'files', 'flow', 'resumeToken', 'strategies', 'success',
    ]);

    expect(result.success).toBe(false);
    expect(result.code).toBe('CONFLICT_PENDING');
    expect(result.flow).toBe('publish');
    expect(result.files).toEqual(['a.md']);
    expect(result.strategies).toEqual([
      'MERGE_LOCAL', 'MERGE_REMOTE', 'FULL_LOCAL', 'FULL_REMOTE',
    ]);
    // Single-use crypto token: 16 random bytes, hex-encoded.
    expect(result.resumeToken).toMatch(/^[0-9a-f]{32}$/);
    // TTL minted "now": expires within the 15-minute window.
    expect(result.expiresAt - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect(result.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(result.error).toMatch(/Conflito de mesclagem detectado/i);

    // detail oids mirror the REAL repo state at detection time:
    // ours = post-WIP HEAD, theirs = origin/preview, base = ancestor.
    expect(result.detail.ours).toBe(await pair.local.resolveRef('HEAD'));
    expect(result.detail.theirs).toBe(
      await pair.local.resolveRef('refs/remotes/origin/preview')
    );
    expect(result.detail.mergeBase).toBe(baseSha);

    // Paused, not merged: local version on disk, remote file absent.
    expect(await pair.local.readFile('a.md')).toBe(A_LOCAL);
    expect(fs.existsSync(path.join(pair.local.dir, 'new-remote.md'))).toBe(false);
    expect(originHead).toBeTruthy();
  });

  it('resumeToken is single-use: a second resolve with the same token → INVALID_TOKEN', async () => {
    const pending = await handlers.gitPublishPreview(1, 'local: conflicting edit');
    expect(pending.code).toBe('CONFLICT_PENDING');

    const first = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
    expect(first.success).toBe(true);

    const second = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
    expect(second.success).toBe(false);
    expect(second.code).toBe('INVALID_TOKEN');
    expect(second.error).toMatch(/inválido, expirado ou já utilizado/i);
  });

  it('token TTL is 15 min: an expired token → TOKEN_EXPIRED (and is purged)', async () => {
    const pending = await handlers.gitPublishPreview(1, 'local: conflicting edit');

    // TTL is EXACTLY 15 minutes on the in-memory registry entry.
    const entry = handlers._pendingConflicts.get(pending.resumeToken);
    expect(entry.expiresAt - entry.createdAt).toBe(15 * 60 * 1000);

    // Simulate the 15 minutes elapsing.
    entry.expiresAt = Date.now() - 1000;

    const result = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
    expect(result.success).toBe(false);
    expect(result.code).toBe('TOKEN_EXPIRED');
    expect(result.error).toMatch(/tempo para decidir expirou/i);

    // Expired token is deleted on use — a retry reports INVALID_TOKEN.
    const retry = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
    expect(retry.code).toBe('INVALID_TOKEN');

    // Nothing was merged while the decision was (not) made.
    expect(await pair.local.readFile('a.md')).toBe(A_LOCAL);
  });

  it("strategy 'CANCEL' leaves branch, HEAD and worktree untouched", async () => {
    const pending = await handlers.gitPublishPreview(1, 'local: conflicting edit');
    expect(pending.code).toBe('CONFLICT_PENDING');

    const headAtPending = await pair.local.resolveRef('HEAD');
    const backupsAtPending = await backupNames(handlers, pair.local.dir);
    expect(backupsAtPending.length).toBeGreaterThan(0);

    const result = await handlers.gitResolveConflict(pending.resumeToken, 'CANCEL');
    expect(result).toEqual({
      success: false,
      code: 'CANCELLED',
      message: 'Operação cancelada — sua versão local e o backup permanecem intactos.',
    });

    // Repo untouched: same branch, same HEAD, same worktree, no merge.
    expect(await handlers.git.currentBranch(pair.local.dir)).toBe('preview');
    expect(await pair.local.resolveRef('HEAD')).toBe(headAtPending);
    expect(await pair.local.readFile('a.md')).toBe(A_LOCAL);
    const messages = (await pair.local.log(20)).map((c) => c.commit.message);
    expect(messages.some((m) => /merge/i.test(m))).toBe(false);
    expect(fs.existsSync(path.join(pair.local.dir, 'new-remote.md'))).toBe(false);

    // Backup branches survive the cancel (kept, not garbage).
    expect(await backupNames(handlers, pair.local.dir)).toEqual(backupsAtPending);

    // Cancel consumed the token.
    const late = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
    expect(late.code).toBe('INVALID_TOKEN');
  });
});

// ─── BLOCK 2 — RECOVERY contract: backups survive cancel; naming; prune ──────

describe.skipIf(!httpBackendAvailable)('CONTRACT 2 — RECOVERY: backup survives cancellation, naming, 7-day prune', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
    handlers = makeHandlers(pair.local.dir);
  });
  afterEach(() => pair.dispose());

  it('requestCancel during publish: typed cancelled result and the backup branch is KEPT', async () => {
    const { originHead } = await makeDivergent(pair, {
      remoteFiles: { 'c.md': 'remote content\n' },
      remoteMessage: 'remote: add c.md',
    });
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    // User hits Cancel mid-flow: the flag goes up while the protected
    // body is executing (right at the merge step), after the mandatory
    // backup was already taken.
    const originalMerge = handlers.git.merge.bind(handlers.git);
    const mergeSpy = vi.spyOn(handlers.git, 'merge').mockImplementation(async (...args) => {
      handlers.requestCancel();
      return originalMerge(...args);
    });

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');
    mergeSpy.mockRestore();

    // Typed cancelled result (renderer contract).
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.message).toBe('Operation cancelled by user');
    expect(handlers.isCancelRequested()).toBe(true);

    // RECOVERY CONTRACT: the backup taken BEFORE the protected body is
    // never deleted on cancellation.
    const backups = await backupNames(handlers, pair.local.dir);
    expect(backups.length).toBeGreaterThan(0);
    for (const name of backups) {
      expect(name).toMatch(/^backup\/preview-/);
    }

    // The push never ran: origin/preview still at the pre-publish tip.
    expect(await pair.local.resolveRef('refs/remotes/origin/preview')).toBe(originHead);
  });

  it("backup branch naming is exactly `backup/<branch>-<sha7>-<epoch>` (prefix constant frozen)", async () => {
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');
    expect(result.success).toBe(true);

    // The frozen prefix constant itself.
    expect(BACKUP_BRANCH_PREFIX).toBe('backup/');

    const backups = await backupNames(handlers, pair.local.dir);
    expect(backups.length).toBeGreaterThan(0);
    const [name] = backups;
    // <branch> is the working branch; <sha7> is 7 hex chars; <epoch> is ms.
    expect(name).toMatch(/^backup\/preview-[0-9a-f]{7}-\d+$/);

    // <sha7> is the tip the backup points at (post-WIP HEAD at backup time).
    const backupTip = await pair.local.resolveRef(name);
    expect(name.startsWith(`backup/preview-${backupTip.slice(0, 7)}-`)).toBe(true);

    // <epoch> carries the creation Date.now() (the name-embedded clock).
    const epoch = Number(name.match(/-(\d+)$/)[1]);
    expect(epoch).toBeGreaterThan(Date.now() - 5 * 60 * 1000);
    expect(epoch).toBeLessThanOrEqual(Date.now());
  });

  it('pruneOldBackups deletes ONLY backups older than 7 days (committer-timestamp clock)', async () => {
    // A FRESH, flow-created backup (age ~0) via withMandatoryBackup.
    makeDirty(pair.local, { 'a.md': 'fresh dirty edit for backup\n' });
    const ops = createObjectStyleOps(handlers.git);
    const { backupBranch: freshBackup, result } = await handlers.gitSafety.withMandatoryBackup(
      ops, fs, pair.local.dir, async () => 'op-result'
    );
    expect(result).toBe('op-result');
    expect(freshBackup).toMatch(/^backup\//);

    // Synthetic backups 8 days old (prunable) and 6 days old (kept).
    await seedBackupAtAge(pair.local, 'backup/preview-old111-111', 8);
    await seedBackupAtAge(pair.local, 'backup/preview-new222-222', 6);

    const { pruned } = await handlers.gitSafety.pruneOldBackups(ops, fs, pair.local.dir, 7);

    expect(pruned).toEqual(['backup/preview-old111-111']);
    const names = await backupNames(handlers, pair.local.dir);
    expect(names).toContain(freshBackup);
    expect(names).toContain('backup/preview-new222-222');
    expect(names).not.toContain('backup/preview-old111-111');
  });
});

// ─── BLOCK 3 — dirty-tree capture (LOAD-BEARING for task 7 auto-restore) ─────

describe.skipIf(!httpBackendAvailable)('CONTRACT 3 — backup branch captures the UNCOMMITTED dirty tree', () => {
  // GATE (capability, never unconditional): this battery drives real
  // repos over the loopback git-http-backend server (createRepoPair);
  // skipped only where the bundled git lacks the CGI
  // (fixtures/harness.httpBackendAvailable probe) — re-opens by itself
  // when the runner ships http-backend. Mock/unit describes stay ungated.
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({
      branch: 'preview',
      files: { 'a.md': 'base content\n', 'keep.txt': 'keep me\n' },
    });
    handlers = makeHandlers(pair.local.dir);
  });
  afterEach(() => pair.dispose());

  it('withMandatoryBackup: the backup branch tree CONTAINS modified + untracked dirty files (snapshot commit)', async () => {
    const DIRTY_EDIT = 'dirty edit — uncommitted, never staged\n';
    const DIRTY_NEW = 'brand new untracked file\n';
    makeDirty(pair.local, { 'a.md': DIRTY_EDIT, 'untracked.txt': DIRTY_NEW });

    const ops = createObjectStyleOps(handlers.git);
    const { backupBranch, result } = await handlers.gitSafety.withMandatoryBackup(
      ops, fs, pair.local.dir, async () => 'op-result'
    );

    // Operation result is passed through.
    expect(result).toBe('op-result');
    expect(backupBranch).toMatch(/^backup\//);

    // LOAD-BEARING: the backup tree contains the dirty files — the
    // modified tracked file, the brand-new untracked file AND the
    // untouched pre-existing file (full-tree snapshot, not a diff).
    expect(await blobAt(pair.local, backupBranch, 'a.md')).toBe(DIRTY_EDIT);
    expect(await blobAt(pair.local, backupBranch, 'untracked.txt')).toBe(DIRTY_NEW);
    expect(await blobAt(pair.local, backupBranch, 'keep.txt')).toBe('keep me\n');

    // The snapshot is a real commit on the backup branch with the
    // frozen message pattern (gitSafety.js "snapshot de working tree").
    const tip = await pair.local.resolveRef(backupBranch);
    const { commit } = await git.readCommit({ fs, dir: pair.local.dir, oid: tip });
    expect(commit.message).toMatch(/^chore\(backup\): snapshot de working tree/);

    // After the snapshot the repo is back on the working branch.
    expect(await handlers.git.currentBranch(pair.local.dir)).toBe('preview');
  });

  it('flow-level: publish with a dirty tree leaves a backup branch that contains the dirty content', async () => {
    const DIRTY_FLOW = 'flow dirty content — committed first, then backed up\n';
    await makeDivergent(pair, {
      remoteFiles: { 'c.md': 'remote content\n' },
      remoteMessage: 'remote: add c.md',
    });
    makeDirty(pair.local, { 'a.md': DIRTY_FLOW });

    const result = await handlers.gitPublishPreview(1, 'local: publish with dirty tree');
    expect(result.success).toBe(true);

    const backups = await backupNames(handlers, pair.local.dir);
    expect(backups.length).toBeGreaterThan(0);

    // Every backup branch created by the flow contains the dirty edit
    // (commit-first ordering: WIP commit is the backup tip's history).
    for (const name of backups) {
      expect(await blobAt(pair.local, name, 'a.md')).toBe(DIRTY_FLOW);
    }
    expect(await blobAt(pair.local, backups[0], 'keep.txt')).toBe('keep me\n');
  });
});
