/**
 * @fileoverview publish-update-resilience Task 4 — FAST-PATH PERF
 * proofs (dugite provider, the app's active one).
 *
 * The bottleneck being closed: DugiteProvider had no canFastForward, so
 * every `localAhead` probe in git.js swallowed a TypeError and fell back
 * to deepen-fetch + full merge even when the local branch was SIMPLY
 * AHEAD. These tests COMMAND-TRACE the flows (spy on
 * DugiteProvider.prototype._run records every git argv) and prove:
 *
 *   1. ahead-only publish (gitPushToBranch): ZERO deepen/unshallow
 *      fetches, ZERO merges, direct push, success — the fast path
 *      `_publishCore`'s localAhead=true reactivates;
 *   2. real divergence still merges: CONFLICT_PENDING → MERGE_LOCAL
 *      resume runs `git merge -X ours` (LOCAL wins) and the conflicting
 *      file keeps the LOCAL content (regression guard for the fix);
 *   3. canFastForward unit sanity: ancestor→true, non-ancestor→false,
 *      missing ref → treated error (call-site catch → localAhead=false);
 *   4. _fetchChains keying: plain fetches of DISTINCT refs run in
 *      PARALLEL, same refspec stays serialized, and shallow-WRITING
 *      fetches (--depth) stay repo-serialized (empirical: .git/
 *      shallow.lock contends cross-ref);
 *   5. publish-main backup dedupe: the 2nd _safeResetToOrigin backup is
 *      skipped when the flow's backup (< 5 min) still covers the exact
 *      state — and created whenever ANY condition fails (safety first).
 *
 * Evidence: GENERATE_TASK4_EVIDENCE=1 writes
 * .omo/evidence/task-4-{fastpath,divergent-merge}-trace.json.
 *
 * @vitest-environment node
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// tests/setup.js mocks fs/path globally — these fixtures need the REAL fs.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import gitModule from 'isomorphic-git';

import {
  createRepoPair,
  makeDivergent,
  commitFile,
  httpBackendAvailable,
} from './fixtures/harness.js';
import { GitHandlers } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { providerFactory } from '../git-providers/harness.js';
import { DugiteProvider } from '../../src/git/providers/DugiteProvider.js';
import { GitSafety } from '../../src/ipc/gitSafety.js';
import { BACKUP_BRANCH_PREFIX } from '../../src/ipc/gitFlowTypes.js';

const git = gitModule.default || gitModule;
const EVIDENCE = Boolean(process.env.GENERATE_TASK4_EVIDENCE);

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ─── Canonical DI helpers (characterization/publish-flow structure) ──────────

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Production GitHandlers PINNED to dugite (the provider whose missing
 * canFastForward caused the bottleneck — iso-git's works already).
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

/**
 * Command-trace spy on the provider choke point: records {op, args} of
 * EVERY git invocation and repasses to the original _run.
 *
 * The spy patches the prototype of the provider instance UNDER TEST —
 * vitest runs the CJS factory's `require`d DugiteProvider and the test
 * file's ESM `import` as two module instances (the T19 dual-class
 * gotcha), so spying the imported class would see nothing.
 *
 * @param {{ _resolve?: Function } | object} target - handlers (facade
 *   via _resolve) or a provider instance
 * @param {{ fetchDelayMs?: number }} [opts] - artificial delay inside
 *   fetch commands (chain-parallelism observability)
 * @returns {{ trace: Array<{op: string, args: string[], t: number}>, restore(): void }}
 */
function installTrace(target, { fetchDelayMs = 0 } = {}) {
  const provider =
    typeof target?._resolve === 'function' ? target._resolve() : target;
  const proto = Object.getPrototypeOf(provider);
  const trace = [];
  const original = proto._run;
  const spy = vi.spyOn(proto, '_run').mockImplementation(
    function (operation, args, ...rest) {
      trace.push({ op: operation, args: [...args], t: Date.now() });
      if (fetchDelayMs > 0 && args[0] === 'fetch') {
        return new Promise((resolve) => setTimeout(resolve, fetchDelayMs)).then(
          () => original.apply(this, [operation, args, ...rest]),
        );
      }
      return original.apply(this, [operation, args, ...rest]);
    },
  );
  return {
    trace,
    restore() {
      spy.mockRestore();
    },
  };
}

const commands = (trace, subcommand) => trace.filter((t) => t.args[0] === subcommand);
const deepeningFetches = (trace) =>
  commands(trace, 'fetch').filter(
    (t) => t.args.includes('--unshallow') || t.args.includes('--deepen'),
  );

function writeEvidence(name, payload) {
  if (!EVIDENCE) return;
  fs.mkdirSync(path.join(process.cwd(), '.omo', 'evidence'), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), '.omo', 'evidence', name),
    JSON.stringify(payload, null, 2),
  );
}

// Distinct-length fixtures (iso-git same-second stat-cache gotcha).
const A_BASE = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
const A_LOCAL = A_BASE.replace('line5', 'line5-LOCAL-EDIT');
const A_REMOTE = A_BASE.replace('line5', 'line5-REMOTE-EDIT');

// ─── Scenario 1: ahead-only publish takes the fast path ──────────────────────

describe.skipIf(!httpBackendAvailable)('fast path — local ahead only (dugite trace)', () => {
  // GATE (capability, never unconditional): real repos over the loopback
  // git-http-backend server; skipped only where the bundled git lacks the
  // CGI — re-opens by itself when the runner ships http-backend.
  let pair;
  let handlers;
  let tracer;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
    handlers = makeHandlers(pair.local.dir);
    tracer = installTrace(handlers.git);
  });

  afterEach(() => {
    tracer.restore();
    pair.dispose();
  });

  it('gitPushToBranch: ZERO deepen/unshallow fetches, ZERO merges, direct push', async () => {
    // Local is exactly ONE commit ahead of origin/preview — no divergence.
    await commitFile(pair.local, 'local-only.md', 'local ahead\n', 'local: ahead commit');

    const result = await handlers.gitPushToBranch(pair.local.dir, 'preview', null);

    expect(result.success).toBe(true);

    // ZERO deepening fetches (--unshallow / --deepen) — the depth:1 sync
    // fetch is allowed, the deepen round must not run.
    expect(deepeningFetches(tracer.trace)).toHaveLength(0);
    // ZERO merge commands (the old path merged even when merely ahead).
    expect(commands(tracer.trace, 'merge')).toHaveLength(0);
    // The direct push IS there and landed on the remote.
    expect(commands(tracer.trace, 'push')).toHaveLength(1);
    const origin = await pair.local.resolveRef('refs/remotes/origin/preview');
    expect(origin).toBe(await pair.local.head());
    // The fast path really probed ancestry (merge-base --is-ancestor).
    expect(
      tracer.trace.some(
        (t) => t.args[0] === 'merge-base' && t.args.includes('--is-ancestor'),
      ),
    ).toBe(true);

    writeEvidence('task-4-fastpath-trace.json', {
      scenario: 'local 1 commit ahead, no divergence → gitPushToBranch',
      provider: 'dugite',
      assertions: {
        success: result.success,
        deepeningFetches: 0,
        mergeCommands: 0,
        pushCommands: 1,
      },
      commandTrace: tracer.trace.map(({ op, args }) => ({ op, args })),
    });
  });

  it('refresh (gitRefresh) ahead-only: upToDate/ahead early return, no merge', async () => {
    await commitFile(pair.local, 'local-only.md', 'local ahead\n', 'local: ahead commit');
    // refresh fetches origin/preview (depth:1) and finds HEAD ahead → done.
    const result = await handlers.gitRefresh(1);

    expect(result.success).toBe(true);
    expect(commands(tracer.trace, 'merge')).toHaveLength(0);
    expect(deepeningFetches(tracer.trace)).toHaveLength(0);
  });
});

// ─── Scenario 2: real divergence still merges with -X ours (LOCAL wins) ──────

describe.skipIf(!httpBackendAvailable)('divergence regression — merge -X ours still runs', () => {
  let pair;
  let handlers;
  let tracer;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
    handlers = makeHandlers(pair.local.dir);
    tracer = installTrace(handlers.git);
  });

  afterEach(() => {
    tracer.restore();
    pair.dispose();
  });

  it('CONFLICT_PENDING → MERGE_LOCAL: merge command with -X ours, LOCAL content wins', async () => {
    // Real divergence: local edits line5, colleague pushes a CONFLICTING
    // edit of line5 plus a clean remote-only file.
    await makeDivergent(pair, {
      localFiles: { 'a.md': A_LOCAL },
      localMessage: 'local: conflicting edit',
      remoteFiles: { 'a.md': A_REMOTE, 'new-remote.md': 'from remote\n' },
      remoteMessage: 'remote: conflicting edit',
      syncRemote: true,
    });

    const pending = await handlers.gitPublishPreview(1, null);
    expect(pending.success).toBe(false);
    expect(pending.code).toBe('CONFLICT_PENDING');

    const resumed = await handlers.gitResolveConflict(pending.resumeToken, 'MERGE_LOCAL');
    expect(resumed.success).toBe(true);

    // The merge REALLY ran (fast path correctly did NOT trigger — the
    // branches genuinely diverged) with LOCAL-wins favor.
    const merges = commands(tracer.trace, 'merge');
    expect(merges.length).toBeGreaterThanOrEqual(1);
    expect(merges.some((m) => m.args.includes('-X') && m.args.includes('ours'))).toBe(true);

    // Conflicting file = LOCAL version; remote clean file integrated.
    const aMd = fs.readFileSync(path.join(pair.local.dir, 'a.md'), 'utf8');
    expect(aMd).toContain('line5-LOCAL-EDIT');
    expect(aMd).not.toContain('line5-REMOTE-EDIT');
    expect(fs.existsSync(path.join(pair.local.dir, 'new-remote.md'))).toBe(true);

    writeEvidence('task-4-divergent-merge-trace.json', {
      scenario: 'local+remote diverged (conflicting line) → CONFLICT_PENDING → MERGE_LOCAL',
      provider: 'dugite',
      assertions: {
        conflictPending: true,
        resumed: resumed.success,
        mergeWithXOurs: true,
        localWinsConflictingFile: true,
      },
      commandTrace: tracer.trace.map(({ op, args }) => ({ op, args })),
    });
  });
});

// ─── Scenario 3: canFastForward unit sanity through the real provider ────────

describe.skipIf(!httpBackendAvailable)('canFastForward call-site semantics (dugite)', () => {
  let pair;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
  });

  afterEach(() => {
    pair.dispose();
  });

  it('ancestor→true, non-ancestor→false, missing ref→treated error (localAhead=false)', async () => {
    await commitFile(pair.local, 'local-only.md', 'ahead\n', 'local: ahead');
    await pair.local.fetch(); // materialize refs/remotes/origin/preview

    const provider = new DugiteProvider();
    const dir = pair.local.dir;

    // ahead-only: origin tip is an ancestor of HEAD → ff possible
    await expect(
      provider.canFastForward(dir, { ref: 'origin/preview', target: 'HEAD' })
    ).resolves.toBe(true);
    // reverse direction is not
    await expect(
      provider.canFastForward(dir, { ref: 'HEAD', target: 'origin/preview' })
    ).resolves.toBe(false);

    // missing ref throws — the call sites' try/catch treats it as
    // localAhead=false (never a crash of the flow).
    let localAhead = true;
    try {
      localAhead = await provider.canFastForward(dir, {
        ref: 'origin/does-not-exist',
        target: 'HEAD',
      });
    } catch (_ffErr) {
      localAhead = false;
    }
    expect(localAhead).toBe(false);
  });
});

// ─── _fetchChains keying (Task 4 secondary bottleneck) ────────────────────────

describe.skipIf(!httpBackendAvailable)('_fetchChains — repo+refspec keying', () => {
  let pair;
  let provider;
  let tracer;
  const DELAY = 150;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'main', files: { 'a.md': A_BASE } });
    // Second remote branch so main/preview fetches have distinct targets.
    await git.branch({ fs, dir: pair.local.dir, ref: 'preview' });
    await pair.local.push('preview');
    provider = new DugiteProvider();
    tracer = installTrace(provider, { fetchDelayMs: DELAY });
  });

  afterEach(() => {
    tracer.restore();
    pair.dispose();
  });

  it('DISTINCT plain refs start in parallel (no cross-ref queueing)', async () => {
    await Promise.all([
      provider.fetch(pair.local.dir, { remote: 'origin', ref: 'main' }),
      provider.fetch(pair.local.dir, { remote: 'origin', ref: 'preview' }),
    ]);
    const starts = commands(tracer.trace, 'fetch').map((t) => t.t);
    expect(starts).toHaveLength(2);
    expect(Math.abs(starts[1] - starts[0])).toBeLessThan(DELAY - 25);
  });

  it('SAME refspec stays serialized (shallow.lock protection)', async () => {
    await Promise.all([
      provider.fetch(pair.local.dir, { remote: 'origin', ref: 'main' }),
      provider.fetch(pair.local.dir, { remote: 'origin', ref: 'main' }),
    ]);
    const starts = commands(tracer.trace, 'fetch').map((t) => t.t);
    expect(starts).toHaveLength(2);
    expect(Math.abs(starts[1] - starts[0])).toBeGreaterThanOrEqual(DELAY - 25);
  });

  it('shallow-WRITING fetches (--depth) serialize repo-wide, even cross-ref', async () => {
    // Empirical guard: two concurrent --depth fetches race on
    // .git/shallow.lock regardless of ref — they must share the repo key.
    await Promise.all([
      provider.fetch(pair.local.dir, { remote: 'origin', ref: 'main', depth: 1 }),
      provider.fetch(pair.local.dir, { remote: 'origin', ref: 'preview', depth: 1 }),
    ]);
    const starts = commands(tracer.trace, 'fetch').map((t) => t.t);
    expect(starts).toHaveLength(2);
    expect(Math.abs(starts[1] - starts[0])).toBeGreaterThanOrEqual(DELAY - 25);
  });
});

// ─── publish-main backup dedupe (Task 4 secondary bottleneck) ─────────────────

describe.skipIf(!httpBackendAvailable)('publish-main — 2nd backup dedupe', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'main', files: { 'a.md': A_BASE } });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  /**
   * Promotable, NON-conflicting state with the flow backup guaranteed:
   *   - colleague advances origin/main (main-note.md)
   *   - local publishes preview once, then adds an UNPUSHED commit on
   *     preview (origin/preview ≠ local HEAD → withMandatoryBackup MUST
   *     create the flow backup; the inner _safeResetToOrigin would have
   *     created a 2nd one pre-dedupe)
   */
  async function setupPromotable() {
    await commitFile(pair.remote, 'main-note.md', 'from main\n', 'main: advance');
    await pair.remote.push('main');

    const baseOid = await pair.local.head();
    await git.branch({ fs, dir: pair.local.dir, ref: 'preview', object: baseOid });
    await git.checkout({ fs, dir: pair.local.dir, ref: 'preview' });
    await commitFile(pair.local, 'preview-note.md', 'from preview\n', 'preview: first');
    await pair.local.push('preview');
    // Unpushed local work → flow backup exists → reuse context non-null.
    await commitFile(pair.local, 'preview-note-2.md', 'unpushed\n', 'preview: unpushed');
  }

  it('creates ONE backup branch (flow backup reused by _safeResetToOrigin)', async () => {
    await setupPromotable();

    const createSpy = vi.spyOn(handlers.gitSafety, '_createBackup');
    const result = await handlers.gitPublishMain(1);

    expect(result.success).toBe(true);
    // Exactly one backup was CREATED (the flow's); the inner
    // _safeResetToOrigin assessment reused it instead of minting #2.
    expect(createSpy).toHaveBeenCalledTimes(1);
    createSpy.mockRestore();

    const branches = await handlers.git.listBranches(pair.local.dir);
    const backups = branches
      .map((b) => (typeof b === 'string' ? b : b.name))
      .filter((n) => n.startsWith(BACKUP_BRANCH_PREFIX));
    expect(backups).toHaveLength(1);

    // Promotion itself is intact: origin/main now carries BOTH sides.
    await pair.remote.fetch();
    await git.checkout({ fs, dir: pair.remote.dir, ref: 'origin/main', force: true });
    expect(fs.existsSync(path.join(pair.remote.dir, 'main-note.md'))).toBe(true);
    expect(fs.existsSync(path.join(pair.remote.dir, 'preview-note.md'))).toBe(true);
  });
});

// ─── _assessAndBackup reuse condition matrix (unit, mock gitMod) ─────────────

describe('_assessAndBackup recentBackup reuse conditions', () => {
  const HEAD = 'a'.repeat(40);
  const ORIGIN = 'b'.repeat(40);
  const BACKUP_NAME = `${BACKUP_BRANCH_PREFIX}preview-aaaaaaa-123`;

  function mockGitMod({ dirty = [], backupTip = HEAD, backupMissing = false } = {}) {
    const created = [];
    return {
      created,
      currentBranch: vi.fn(async () => 'preview'),
      resolveRef: vi.fn(async ({ ref }) => {
        if (ref === 'HEAD') return HEAD;
        if (ref === 'refs/remotes/origin/preview') return ORIGIN;
        if (ref === BACKUP_NAME) {
          if (backupMissing) throw new Error(`ref not found: ${ref}`);
          return backupTip;
        }
        throw new Error(`ref not found: ${ref}`);
      }),
      statusMatrix: vi.fn(async () => dirty),
      branch: vi.fn(async ({ ref }) => {
        created.push(ref);
      }),
      checkout: vi.fn(async () => {}),
      add: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      commit: vi.fn(async () => 'c'.repeat(40)),
    };
  }

  function safety() {
    return new GitSafety({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } });
  }

  const freshContext = (over = {}) => ({
    name: BACKUP_NAME,
    branch: 'preview',
    localHead: HEAD,
    timestamp: Date.now(),
    ...over,
  });

  it('reuses when <5min, same branch+HEAD, clean tree, backup tip verified', async () => {
    const gitMod = mockGitMod();
    const out = await safety()._assessAndBackup(gitMod, fs, '/repo', 'main', {
      recentBackup: freshContext(),
    });
    expect(out.backupBranch).toBe(BACKUP_NAME);
    expect(out.reusedBackup).toBe(true);
    expect(gitMod.branch).not.toHaveBeenCalled();
  });

  it('creates a fresh backup when the context is older than 5 minutes', async () => {
    const gitMod = mockGitMod();
    const out = await safety()._assessAndBackup(gitMod, fs, '/repo', 'main', {
      recentBackup: freshContext({ timestamp: Date.now() - 6 * 60 * 1000 }),
    });
    expect(out.reusedBackup).toBeUndefined();
    expect(gitMod.branch).toHaveBeenCalledTimes(1);
    expect(out.backupInfo).toMatchObject({ branch: 'preview', localHead: HEAD });
  });

  it('creates a fresh backup when HEAD moved since the flow backup', async () => {
    const gitMod = mockGitMod();
    const out = await safety()._assessAndBackup(gitMod, fs, '/repo', 'main', {
      recentBackup: freshContext({ localHead: 'd'.repeat(40) }),
    });
    expect(out.reusedBackup).toBeUndefined();
    expect(gitMod.branch).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh backup when the branch differs', async () => {
    const gitMod = mockGitMod();
    await safety()._assessAndBackup(gitMod, fs, '/repo', 'main', {
      recentBackup: freshContext({ branch: 'main' }),
    });
    expect(gitMod.branch).toHaveBeenCalledTimes(1);
  });

  it('NEVER reuses with a dirty tree (Block 3 dirty-snapshot contract)', async () => {
    const gitMod = mockGitMod({ dirty: [['f.txt', 1, 2, 1]] });
    await safety()._assessAndBackup(gitMod, fs, '/repo', 'main', {
      recentBackup: freshContext(),
    });
    expect(gitMod.branch).toHaveBeenCalledTimes(1);
    // the fresh backup snapshot-stages the dirty file
    expect(gitMod.add).toHaveBeenCalledWith(expect.objectContaining({ filepath: 'f.txt' }));
  });

  it('creates a fresh backup when the flow backup was pruned or moved', async () => {
    const gone = mockGitMod({ backupMissing: true }); // resolveRef(BACKUP_NAME) throws
    await safety()._assessAndBackup(gone, fs, '/repo', 'main', {
      recentBackup: freshContext(),
    });
    expect(gone.branch).toHaveBeenCalledTimes(1);

    const moved = mockGitMod({ backupTip: 'e'.repeat(40) });
    await safety()._assessAndBackup(moved, fs, '/repo', 'main', {
      recentBackup: freshContext(),
    });
    expect(moved.branch).toHaveBeenCalledTimes(1);
  });

  it('no recentBackup → unchanged legacy behavior (backup created)', async () => {
    const gitMod = mockGitMod();
    const out = await safety()._assessAndBackup(gitMod, fs, '/repo', 'main', {});
    expect(out.backupBranch).toBeTruthy();
    expect(out.backupInfo).toMatchObject({ name: out.backupBranch, branch: 'preview', localHead: HEAD });

    // withMandatoryBackup hands its OWN backupInfo to the operation
    let seen;
    const wmb = await safety().withMandatoryBackup(
      gitMod,
      fs,
      '/repo',
      async (info) => {
        seen = info;
      },
      { branch: 'preview' },
    );
    expect(seen).toMatchObject({ name: wmb.backupBranch, localHead: HEAD });
  });
});
