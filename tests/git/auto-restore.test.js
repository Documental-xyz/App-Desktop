/**
 * @fileoverview publish-update-resilience Task 7 — AUTO-RESTORE engine.
 *
 * Matrix (shouldRestore, PURE): one case per matrix row + precedence.
 * Engine (autoRestoreFromBackup) via the REAL flows over the loopback
 * git-http-backend (dugite provider — same DI structure as
 * contracts.characterization.test.js):
 *   (1)  merge failure post-backup        → dirty tree returned EXACT
 *        (tree-hash pre vs post), restored:true
 *   (2)  push rejected (remote ahead)     → RESTORE
 *   (3)  push "timeout" but the push LANDED (real push + injected timeout
 *        error) → ls-remote contains it → NO restore, partial informed
 *   (4)  auth failure post-WIP (401 at fetch) → RESTORE (dirty back)
 *   (5)  CONFLICT_PENDING                 → NEVER (token alive, untouched)
 *   (6)  failure BEFORE the first mutating command (STATUS_MATRIX_FAILED)
 *        → NO (writeRef never called)
 *   (7)  safety-backup fails during restore → ABORT (HEAD untouched,
 *        config.html manual-restore hint)
 *   (8)  restore checkout fails           → PARTIAL (exact state reported)
 *   (9)  repo conflict token invalidated post-restore → INVALID_TOKEN
 *   (10) restore runs INSIDE the lock (acquireGitLock called exactly once)
 *   (11) cancel post-merge pre-push       → RESTORE (same matrix)
 *   (12) nothing mutated + failure        → cheap probe skip
 *
 * Evidence: GENERATE_AUTO_RESTORE_EVIDENCE=1 writes
 * .omo/evidence/task-7-{restore-exact-state.json,push-landed-no-restore.txt,
 * safety-abort.txt,conflict-preserved.txt}.
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
import crypto from 'crypto';

import {
  createRepoPair,
  makeDivergent,
  makeDirty,
  httpBackendAvailable,
} from './fixtures/harness.js';
import { GitHandlers } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { providerFactory } from '../git-providers/harness.js';
import { shouldRestore, verifyRemoteState } from '../../src/ipc/gitSafety.js';
import { BACKUP_BRANCH_PREFIX } from '../../src/ipc/gitFlowTypes.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ─── DI helpers (characterization structure, dugite-pinned) ──────────────────

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
    gitService: new GitService({ provider: providerFactory('dugite')() }),
  });
  vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('test-token');
  vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
  vi.spyOn(handlers.gitOps, 'getGitHubUserInfo').mockResolvedValue({ login: 'testuser' });
  handlers.gitPreflight = null;
  return handlers;
}

async function branchNames(handlers, dir) {
  const branches = await handlers.git.listBranches(dir);
  return branches.map((b) => (typeof b === 'string' ? b : b.name));
}

async function backupNames(handlers, dir) {
  return (await branchNames(handlers, dir)).filter((n) => n.startsWith(BACKUP_BRANCH_PREFIX));
}

/**
 * Deterministic hash of the WORKING TREE (path + content per file, .git
 * excluded) — the "dirty tree returned EXACT" oracle.
 */
function treeHash(dir) {
  const entries = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      if (rel === '' && name === '.git') continue;
      const rel2 = rel ? `${rel}/${name}` : name;
      if (fs.statSync(path.join(dir, rel2)).isDirectory()) {
        walk(rel2);
      } else {
        const content = fs.readFileSync(path.join(dir, rel2));
        entries.push(`${rel2}\0${crypto.createHash('sha1').update(content).digest('hex')}`);
      }
    }
  };
  walk('');
  return crypto.createHash('sha1').update(entries.join('\n')).digest('hex');
}

const EVIDENCE_DIR = path.resolve(__dirname, '../../.omo/evidence');

function writeEvidence(name, content) {
  if (!process.env.GENERATE_AUTO_RESTORE_EVIDENCE) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, name),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  );
}

const A_BASE = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
const A_LOCAL = A_BASE.replace('line5', 'line5-LOCAL-EDIT');
const A_REMOTE = A_BASE.replace('line5', 'line5-REMOTE-EDIT');

// ─── Matrix unit battery (pure function) ─────────────────────────────────────

describe('shouldRestore — failure-trigger matrix (pure)', () => {
  it.each([
    // [row, context, expected action]
    ['local mutation fail (merge)', { failureClass: 'unknown', stage: 'merging' }, 'RESTORE'],
    ['local mutation fail (checkout)', { failureClass: 'unknown', stage: 'preparing' }, 'RESTORE'],
    ['local mutation fail (finalizing)', { failureClass: 'unknown', stage: 'finalizing' }, 'RESTORE'],
    ['push rejected (typed code)', { failureClass: 'conflict', stage: 'pushing', code: 'PUSH_REJECTED' }, 'RESTORE'],
    ['push rejected (forbidden)', { failureClass: 'auth', stage: 'pushing', code: 'PUSH_FORBIDDEN' }, 'RESTORE'],
    ['push rejected (large_file)', { failureClass: 'large_file', stage: 'pushing', code: 'PUSH_REJECTED' }, 'RESTORE'],
    ['push timeout (uncertain)', { failureClass: 'timeout', stage: 'pushing' }, 'VERIFY_THEN_RESTORE'],
    ['push network (uncertain)', { failureClass: 'network', stage: 'pushing' }, 'VERIFY_THEN_RESTORE'],
    ['push unknown outcome', { failureClass: 'unknown', stage: 'pushing' }, 'VERIFY_THEN_RESTORE'],
    ['cancel DURING push (uncertain)', { failureClass: 'cancel', stage: 'pushing', cancelled: true }, 'VERIFY_THEN_RESTORE'],
    ['auth post-mutations (fetch)', { failureClass: 'auth', stage: 'fetching' }, 'RESTORE'],
    ['auth during push (server refused)', { failureClass: 'auth', stage: 'pushing' }, 'RESTORE'],
    ['network at fetch (nothing landed)', { failureClass: 'network', stage: 'fetching' }, 'RESTORE'],
    ['cancel post-merge pre-push', { failureClass: 'cancel', stage: 'merging', cancelled: true }, 'RESTORE'],
    ['cancel at fetching post-WIP', { failureClass: 'cancel', stage: 'fetching', cancelled: true }, 'RESTORE'],
  ])('%s → %s', (_row, ctx, expected) => {
    expect(shouldRestore(ctx)).toMatchObject({ action: expected });
  });

  it('CONFLICT_PENDING → NEVER (any stage/class, flag or typed code)', () => {
    for (const ctx of [
      { failureClass: 'unknown', stage: 'merging', conflictPending: true },
      { failureClass: 'conflict', stage: 'merging', code: 'CONFLICT_PENDING' },
      { failureClass: 'cancel', stage: 'pushing', conflictPending: true, cancelled: true },
    ]) {
      const decision = shouldRestore(ctx);
      expect(decision.action).toBe('NO');
      expect(decision.reason).toMatch(/CONFLICT_PENDING/i);
    }
  });

  it('failure BEFORE the first mutating command → NO (preflight/status/backup block)', () => {
    for (const ctx of [
      { failureClass: 'unknown', stage: 'preparing', code: 'BACKUP_FAILED' },
      { failureClass: 'unknown', stage: 'preparing', code: 'STATUS_MATRIX_FAILED' },
      { failureClass: 'network', stage: 'preflight' },
    ]) {
      expect(shouldRestore(ctx).action).toBe('NO');
    }
  });

  it('cancel AFTER a successful push (finalizing) → NO', () => {
    const decision = shouldRestore({ failureClass: 'cancel', stage: 'finalizing', cancelled: true });
    expect(decision.action).toBe('NO');
  });

  it('returns a reason string for every decision', () => {
    for (const ctx of [
      { failureClass: 'unknown', stage: 'merging' },
      { failureClass: 'timeout', stage: 'pushing' },
      { failureClass: 'unknown', stage: 'preparing', code: 'BACKUP_FAILED' },
      {},
      undefined,
    ]) {
      const decision = shouldRestore(ctx);
      expect(decision.action).toMatch(/^(RESTORE|VERIFY_THEN_RESTORE|NO)$/);
      expect(typeof decision.reason).toBe('string');
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});

// ─── verifyRemoteState unit battery (ls-remote wrapper) ──────────────────────

describe('verifyRemoteState — unit (fake facade)', () => {
  it('exact tip match → remoteContains true', async () => {
    const git = {
      getConfig: vi.fn().mockResolvedValue('http://origin.git'),
      listServerRefs: vi.fn().mockResolvedValue([
        { ref: 'refs/heads/preview', oid: 'aaa' },
        { ref: 'refs/heads/main', oid: 'bbb' },
      ]),
    };
    const out = await verifyRemoteState(git, '/repo', 'preview', 'aaa');
    expect(out).toEqual({ remoteContains: true, remoteOid: 'aaa', verified: true });
  });

  it('tip moved / branch missing → remoteContains false (verified)', async () => {
    const git = {
      getConfig: vi.fn().mockResolvedValue('http://origin.git'),
      listServerRefs: vi.fn().mockResolvedValue([{ ref: 'refs/heads/preview', oid: 'ccc' }]),
    };
    expect((await verifyRemoteState(git, '/repo', 'preview', 'aaa')).remoteContains).toBe(false);
    expect((await verifyRemoteState(git, '/repo', 'main', 'bbb')).remoteContains).toBe(false);
  });

  it('ls-remote failure / missing URL → verified false (caller keeps state)', async () => {
    const down = {
      getConfig: vi.fn().mockResolvedValue('http://origin.git'),
      listServerRefs: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const out = await verifyRemoteState(down, '/repo', 'preview', 'aaa');
    expect(out.verified).toBe(false);
    expect(out.remoteContains).toBe(false);

    const noUrl = { getConfig: vi.fn().mockResolvedValue(null), listServerRefs: vi.fn() };
    expect((await verifyRemoteState(noUrl, '/repo', 'preview', 'aaa')).verified).toBe(false);
  });
});

// ─── invalidateConflictsForProject unit ───────────────────────────────────────

describe('invalidateConflictsForProject — selective by projectId/path', () => {
  it('removes only the target project tokens (id + legacy path match)', () => {
    const handlers = makeHandlers('/unused');
    handlers._mintConflictPending('/repoA', 'publish', { files: [], ours: 'a', theirs: 'b', mergeBase: null }, {}, 1);
    handlers._mintConflictPending('/repoB', 'publish', { files: [], ours: 'a', theirs: 'b', mergeBase: null }, {}, 2);
    // Legacy entry (pre-Task-7, no projectId) on the SAME path as project 1.
    handlers._mintConflictPending('/repoA', 'refresh', { files: [], ours: 'a', theirs: 'b', mergeBase: null }, {});

    const invalidated = handlers.invalidateConflictsForProject(1, '/repoA');
    expect(invalidated).toHaveLength(2); // projectId 1 + legacy path /repoA
    expect(handlers._pendingConflicts.size).toBe(1);

    const survivor = [...handlers._pendingConflicts.values()][0];
    expect(survivor.projectId).toBe(2);
  });

  it('_mintConflictPending registry entry carries projectId; RESULT keys stay frozen (9)', () => {
    const handlers = makeHandlers('/unused');
    const result = handlers._mintConflictPending(
      '/repoA', 'publish',
      { files: ['a.md'], ours: 'o', theirs: 't', mergeBase: 'b' },
      { auth: { token: 'x' }, author: { name: 'n', email: 'e' } },
      42,
    );
    expect(Object.keys(result).sort()).toEqual([
      'code', 'detail', 'error', 'expiresAt', 'files', 'flow', 'resumeToken', 'strategies', 'success',
    ]);
    const entry = handlers._pendingConflicts.get(result.resumeToken);
    expect(entry.projectId).toBe(42);
  });
});

// ─── Integration battery (real repos, dugite, loopback origin) ────────────────

describe.skipIf(!httpBackendAvailable)('auto-restore — engine via real flows', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({
      branch: 'preview',
      files: { 'a.md': A_BASE, 'keep.txt': 'keep me\n' },
    });
    handlers = makeHandlers(pair.local.dir);
  });
  afterEach(() => pair.dispose());

  async function divergeNonConflicting() {
    return makeDivergent(pair, {
      remoteFiles: { 'c.md': 'remote content\n' },
      remoteMessage: 'remote: add c.md',
    });
  }

  // (1) merge failure → EXACT dirty tree back
  it('merge failure post-backup restores the EXACT pre-op working tree', async () => {
    await divergeNonConflicting();
    makeDirty(pair.local, { 'a.md': A_LOCAL, 'untracked.txt': 'brand new\n' });
    const hashBefore = treeHash(pair.local.dir);

    vi.spyOn(handlers.git, 'merge').mockRejectedValue(new Error('fatal: loose object is corrupted'));
    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

    expect(result.success).toBe(false);
    expect(result.restored).toBe(true);
    expect(await handlers.git.currentBranch(pair.local.dir)).toBe('preview');
    expect(treeHash(pair.local.dir)).toBe(hashBefore);
    // The pre-op backup is RETAINED (never deleted by restore).
    const backups = await backupNames(handlers, pair.local.dir);
    expect(backups.length).toBeGreaterThan(0);

    writeEvidence('task-7-restore-exact-state.json', {
      scenario: 'merge failure post-backup → auto-restore',
      treeHashBefore: hashBefore,
      treeHashAfterRestore: treeHash(pair.local.dir),
      result: {
        success: result.success,
        error: result.error,
        restored: result.restored,
        restoredFrom: result.restoredFrom,
      },
      branch: await handlers.git.currentBranch(pair.local.dir),
      backupsRetained: backups,
    });
  });

  // (2) push rejected → RESTORE
  it('push rejected (remote ahead) → RESTORE, backup retained', async () => {
    await divergeNonConflicting();
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    vi.spyOn(handlers.git, 'push').mockRejectedValue(
      Object.assign(new Error('push rejected: non-fast-forward'), { code: 'PushRejectedError' })
    );
    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

    expect(result.success).toBe(false);
    expect(result.code).toBe('PUSH_REJECTED');
    expect(result.restored).toBe(true);
    // Working tree back at the pre-op dirty content (WIP snapshot in the backup).
    expect(await pair.local.readFile('a.md')).toBe(A_LOCAL);
    // The merge result did NOT survive locally (nothing landed remotely).
    expect(fs.existsSync(path.join(pair.local.dir, 'c.md'))).toBe(false);
    expect((await backupNames(handlers, pair.local.dir)).length).toBeGreaterThan(0);
  });

  // (3) push "timeout" but the push LANDED → verify → keep state + partial
  it('push timeout with landed push → ls-remote contains it → NO restore, partial informed', async () => {
    await divergeNonConflicting();
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    // The push REALLY lands, then the client reports a timeout (the
    // response-lost race the VERIFY row exists for).
    const realPush = handlers.git.push.bind(handlers.git);
    vi.spyOn(handlers.git, 'push').mockImplementation(async (p, opts) => {
      await realPush(p, opts);
      throw new Error('RPC failed; curl 28 Operation timed out');
    });
    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

    expect(result.success).toBe(false);
    expect(result.errorClass).toBe('timeout');
    expect(result.restored).toBe(false);
    expect(result.partial).toBe(true);
    // Remote HAS the push; local state kept in sync (NOT reverted).
    const head = await pair.local.resolveRef('HEAD');
    expect(await pair.local.resolveRef('refs/remotes/origin/preview')).toBe(head);
    expect(await pair.local.readFile('a.md')).toBe(A_LOCAL);
    expect(fs.existsSync(path.join(pair.local.dir, 'c.md'))).toBe(true);

    writeEvidence('task-7-push-landed-no-restore.txt', [
      'Cenário: push timeout (curl 28) MAS o push chegou ao remoto.',
      `Decisão da matriz: VERIFY_THEN_RESTORE → ls-remote contem o commit → NÃO restaurar.`,
      `resultado: success=${result.success} errorClass=${result.errorClass} partial=${result.partial} restored=${result.restored}`,
      `remoteOid reportado: ${result.remoteOid}`,
      `origin/preview === HEAD local: ${await pair.local.resolveRef('refs/remotes/origin/preview') === head}`,
      'Estado local mantido em sincronia — sucesso parcial informado ao usuário (T11 banner).',
    ].join('\n'));
  });

  // (4) auth failure post-WIP → RESTORE
  it('auth failure (401) at fetch post-WIP → dirty tree restored', async () => {
    await divergeNonConflicting();
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    vi.spyOn(handlers.git, 'fetch').mockRejectedValue(new Error('HTTP Error: 401 Unauthorized'));
    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

    expect(result.success).toBe(false);
    expect(result.errorClass).toBe('auth');
    expect(result.restored).toBe(true);
    expect(await pair.local.readFile('a.md')).toBe(A_LOCAL);
    expect(await handlers.git.currentBranch(pair.local.dir)).toBe('preview');
  });

  // (5) CONFLICT_PENDING → NEVER restore
  it('CONFLICT_PENDING → no restore: token alive, branch untouched', async () => {
    const { originHead } = await makeDivergent(pair, {
      remoteFiles: { 'a.md': A_REMOTE, 'new-remote.md': 'from remote\n' },
      remoteMessage: 'remote: conflict edit',
    });
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    const result = await handlers.gitPublishPreview(1, 'local: conflicting edit');
    expect(result.code).toBe('CONFLICT_PENDING');
    expect(result.restored).toBeUndefined();

    // Token still valid + branch state preserved for the user decision.
    expect(handlers._pendingConflicts.size).toBe(1);
    const entry = handlers._pendingConflicts.get(result.resumeToken);
    expect(entry.projectId).toBe(1);
    expect(await pair.local.readFile('a.md')).toBe(A_LOCAL);
    expect(await pair.local.resolveRef('refs/remotes/origin/preview')).toBe(originHead);

    const cancel = await handlers.gitResolveConflict(result.resumeToken, 'CANCEL');
    expect(cancel.code).toBe('CANCELLED');

    writeEvidence('task-7-conflict-preserved.txt', [
      'Cenário: CONFLICT_PENDING durante publish.',
      'Matriz: NUNCA restaurar (estado resolvível — decisão do usuário pendente).',
      `restored no result: ${result.restored === undefined}`,
      `tokens vivos no registry: ${handlers._pendingConflicts.size}`,
      `a.md preservado como versão local: ${(await pair.local.readFile('a.md')) === A_LOCAL}`,
      `origin/preview intocado: ${await pair.local.resolveRef('refs/remotes/origin/preview') === originHead}`,
      `resolve(CANCEL) posterior: ${cancel.code} (branch/HEAD/worktree intocados — contrato congelado)`,
    ].join('\n'));
  });

  // (6) failure BEFORE the first mutating command → NO
  it('STATUS_MATRIX_FAILED (pre-mutation block) → no restore, writeRef never called', async () => {
    // Local unpushed commit so the flow WOULD need a backup — but the
    // status assessment fails first (Task-5 hard block, zero mutations).
    pair.local.writeFiles({ 'local.md': 'unpushed work\n' });
    await pair.local.commit('local: unpushed', 'local.md');
    const headBefore = await pair.local.head();

    const statusSpy = vi.spyOn(handlers.git, 'statusMatrix')
      .mockRejectedValue(new Error('status boom'));
    const writeRefSpy = vi.spyOn(handlers.git, 'writeRef');

    const result = await handlers.gitPushToBranch(pair.local.dir, 'preview', null);

    expect(result.success).toBe(false);
    expect(result.code).toBe('STATUS_MATRIX_FAILED');
    expect(result.restored).toBeUndefined();
    expect(writeRefSpy).not.toHaveBeenCalled();
    expect(await pair.local.head()).toBe(headBefore);
    expect(await pair.local.readFile('local.md')).toBe('unpushed work\n');
    statusSpy.mockRestore();
  });

  // (7) safety-backup failure during restore → ABORT
  it('safety-backup failure during restore → ABORT: HEAD untouched, manual-restore hint', async () => {
    await divergeNonConflicting();
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    // statusMatrix calls: (1) _commitAll WIP, (2) initial _assessAndBackup —
    // both must succeed; (3) the restore's safety backup fails.
    const realStatus = handlers.git.statusMatrix.bind(handlers.git);
    let statusCalls = 0;
    const statusSpy = vi.spyOn(handlers.git, 'statusMatrix').mockImplementation(async (...args) => {
      statusCalls += 1;
      if (statusCalls >= 3) throw new Error('disk full — cannot assess');
      return realStatus(...args);
    });

    const mergeSpy = vi.spyOn(handlers.git, 'merge').mockRejectedValue(new Error('merge crashed'));
    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');
    mergeSpy.mockRestore();

    expect(result.success).toBe(false);
    expect(result.restored).toBe(false);
    expect(result.restoreAborted).toBe('SAFETY_BACKUP_FAILED');
    expect(result.restoreHint).toMatch(/config\.html/i);
    // HEAD NOT moved by the restore (still the post-WIP merge-failure state).
    expect(await handlers.git.currentBranch(pair.local.dir)).toBe('preview');
    const log = await pair.local.log(5);
    expect(log.some((c) => /local: edit a\.md/i.test(c.commit.message))).toBe(true);
    statusSpy.mockRestore();

    writeEvidence('task-7-safety-abort.txt', [
      'Cenário: merge falha + safety-backup do restore falha (statusMatrix throw).',
      'Guardrail Metis: restore ABORTA (nunca avisa-e-continua).',
      `restored=${result.restored} restoreAborted=${result.restoreAborted}`,
      `hint manual: ${result.restoreHint}`,
      `HEAD intocado pelo restore (branch preview, WIP commit preservado no log).`,
    ].join('\n'));
  });

  // (8) restore checkout failure → PARTIAL
  it('restore checkout failure → PARTIAL with the exact state reported', async () => {
    await divergeNonConflicting();
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    const mergeSpy = vi.spyOn(handlers.git, 'merge').mockRejectedValue(new Error('merge crashed'));
    // Fail ONLY the restore's force-checkout of preview (no other
    // force-checkout of preview runs in this scenario: clean tree at
    // backup time, merge threw before materialization).
    const realCheckout = handlers.git.checkout.bind(handlers.git);
    const checkoutSpy = vi.spyOn(handlers.git, 'checkout').mockImplementation(async (p, ref, opts) => {
      if (ref === 'preview' && opts && opts.force) {
        throw new Error('checkout exploded');
      }
      return realCheckout(p, ref, opts);
    });

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');
    mergeSpy.mockRestore();
    checkoutSpy.mockRestore();

    expect(result.success).toBe(false);
    expect(result.restored).toBe('PARTIAL');
    expect(result.restoreDetails).toMatchObject({ branch: 'preview' });
    // writeRef landed (branch moved to the backup tip) but the worktree
    // was NOT rewritten — reported, never blindly retried.
    expect(typeof result.restoreDetails.head).toBe('string');
    expect(result.restoreDetails.head).not.toBe(null);
  });

  // (9) conflict tokens invalidated post-restore
  it('restore invalidates the repo’s pending conflict tokens → INVALID_TOKEN on resolve', async () => {
    await divergeNonConflicting();
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    // A stale token pending for THIS repo (state about to move under it).
    const stale = handlers._mintConflictPending(
      pair.local.dir, 'refresh',
      { files: ['a.md'], ours: 'o', theirs: 't', mergeBase: null },
      { auth: { token: 'x' }, author: { name: 'n', email: 'e' }, who: 'tester' },
      1,
    );
    expect(handlers._pendingConflicts.size).toBe(1);

    vi.spyOn(handlers.git, 'merge').mockRejectedValue(new Error('merge crashed'));
    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

    expect(result.restored).toBe(true);
    expect(handlers._pendingConflicts.size).toBe(0);
    const resolve = await handlers.gitResolveConflict(stale.resumeToken, 'MERGE_LOCAL');
    expect(resolve.success).toBe(false);
    expect(resolve.code).toBe('INVALID_TOKEN');
  });

  // (10) restore runs inside the lock
  it('restore runs INSIDE the lock scope — acquireGitLock never re-entered', async () => {
    await divergeNonConflicting();
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    const acquireSpy = vi.spyOn(handlers, 'acquireGitLock');
    vi.spyOn(handlers.git, 'merge').mockRejectedValue(new Error('merge crashed'));

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

    expect(result.restored).toBe(true);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(handlers.gitOperationInProgress).toBe(false);
  });

  // (11) cancel post-merge pre-push → RESTORE (same matrix)
  it('cancel post-merge pre-push → restored, origin untouched, dirty tree exact', async () => {
    const { originHead } = await divergeNonConflicting();
    makeDirty(pair.local, { 'a.md': A_LOCAL });
    const hashBefore = treeHash(pair.local.dir);

    const originalMerge = handlers.git.merge.bind(handlers.git);
    const mergeSpy = vi.spyOn(handlers.git, 'merge').mockImplementation(async (...args) => {
      handlers.requestCancel();
      return originalMerge(...args);
    });
    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');
    mergeSpy.mockRestore();

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.message).toBe('Operation cancelled by user');
    expect(result.restored).toBe(true);
    expect(treeHash(pair.local.dir)).toBe(hashBefore);
    expect(await pair.local.resolveRef('refs/remotes/origin/preview')).toBe(originHead);
    // Recovery contract preserved: backups kept, result gains restored:true.
    expect((await backupNames(handlers, pair.local.dir)).length).toBeGreaterThan(0);
  });

  // (12) cheap probe skip when nothing mutated
  it('failure with nothing mutated → probe skips the restore (ALREADY_AT_ORIGINAL)', async () => {
    // Clean tree + unpushed local commit: a backup IS created (unpushed),
    // but the network failure at fetch mutates nothing → probe skips.
    pair.local.writeFiles({ 'local.md': 'unpushed work\n' });
    await pair.local.commit('local: unpushed', 'local.md');
    const headBefore = await pair.local.head();

    vi.spyOn(handlers.git, 'fetch').mockRejectedValue(new Error('fatal: unable to access origin: ECONNREFUSED'));
    const result = await handlers.gitPushToBranch(pair.local.dir, 'preview', null);

    expect(result.success).toBe(false);
    expect(result.errorClass).toBe('network');
    expect(result.restored).toBe(false);
    expect(result.restoreSkipped).toBe('ALREADY_AT_ORIGINAL');
    expect(await pair.local.head()).toBe(headBefore);
  });
});
