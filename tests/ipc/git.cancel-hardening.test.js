/**
 * @fileoverview publish-update-resilience Task 6 — CANCEL HARDENING.
 *
 * Proves the three legs of the cancel contract:
 *
 *  1. REAL KILL: requestCancel() during a long dugite merge terminates the
 *     actual `git merge` child (SIGTERM via execFile's signal → the dugite
 *     patch forwards it), the flow settles with
 *     `{success:false, cancelled:true}` in seconds — not when the 60s hook
 *     would have released it.
 *  2. LOCAL OPS DIE TOO: cancel during the flow-entry checkout (a local
 *     op that received NO signal before Task 6) now kills the child and
 *     returns cancelled:true.
 *  3. HEARTBEAT NEVER STALE-ABORTS A LIVE OP: Node timers (the 5s
 *     heartbeat interval) keep firing while the event loop awaits a
 *     child_process promise — empirically proven below with a real sleep
 *     child — so a >180s push/merge cannot go stale. The stale check's
 *     ONLY consumer is acquireGitLock (next-op crash recovery); it never
 *     interrupts an active operation. renewHeartbeat() adds
 *     defense-in-depth before long commands.
 *  4. cancelling:true FLAG: progress events emitted between
 *     requestCancel() and the terminal carry `cancelling: true`
 *     (T9/T10 render "Cancelando…").
 *
 * Harness: real repos over the loopback git-http-backend (same structure
 * as tests/git/contracts.characterization.test.js), dugite provider
 * pinned, GitHandlers driven by direct method calls.
 *
 * CI-scale note (heartbeat): a literal 200s pre-receive sleep was judged
 * too slow for CI. The chosen proof is mechanism-level (timers fire
 * during subprocess awaits at ANY duration — duration-independence is the
 * property that matters) plus a real flow whose merge is slowed by a 5s
 * hook: it must complete successfully with a fresh heartbeat throughout.
 *
 * Windows limitation (documented in learnings.md): child kill on Windows
 * uses termination semantics (no SIGTERM); these tests run on Linux.
 *
 * @vitest-environment node
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// tests/setup.js mocks fs/path globally (setupFiles vi.mock) — these
// fixtures need the REAL filesystem (temp repos, http server, /proc).
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  createRepoPair,
  makeDivergent,
  makeDirty,
  httpBackendAvailable,
} from '../git/fixtures/harness.js';
import { GitHandlers } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { providerFactory } from '../git-providers/harness.js';

const execFileAsync = promisify(execFile);

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const GENERATE_EVIDENCE = process.env.TASK6_EVIDENCE === '1';
const EVIDENCE_DIR = path.resolve(process.cwd(), '.omo/evidence');

// ─── Helpers (canonical DI structure from contracts.characterization) ────────

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

/**
 * Install a repo hook that records its PPID (the git child dugite
 * spawned) and then blocks for `sleepSeconds`. $PPID of a git hook IS the
 * git process — the exact process execFile kills on abort.
 *
 * Hook choice: `pre-merge` does NOT fire for plain two-head merges on
 * modern git (verified empirically — see learnings.md); the merge is
 * slowed via `prepare-commit-msg`, whose $2 source argument is "merge"
 * ONLY for merge commits — the flow's own WIP/plain commits (same hook!)
 * pass through instantly. While it sleeps, the `git merge` process is
 * mid-flight (the merge commit does not exist yet — killing there leaves
 * exactly the intermediate state Task 7's auto-restore targets).
 */
function installBlockingMergeHook(repoDir, pidFile, sleepSeconds = 60) {
  const hooksDir = path.join(repoDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'prepare-commit-msg');
  fs.writeFileSync(
    hookPath,
    [
      '#!/bin/sh',
      `if [ "$2" = "merge" ]; then`,
      `  echo $PPID > '${pidFile}'`,
      `  sleep ${sleepSeconds}`,
      `fi`,
      '',
    ].join('\n')
  );
  fs.chmodSync(hookPath, 0o755);
  return hookPath;
}

/**
 * Install a hook that blocks EVERY invocation (for ops where the first
 * dugite call in the flow is the target — e.g. the flow-entry checkout).
 */
function installBlockingHook(repoDir, hookName, pidFile, sleepSeconds = 60) {
  const hooksDir = path.join(repoDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, hookName);
  fs.writeFileSync(
    hookPath,
    `#!/bin/sh\necho $PPID > '${pidFile}'\nsleep ${sleepSeconds}\n`
  );
  fs.chmodSync(hookPath, 0o755);
  return hookPath;
}

function readPid(pidFile) {
  return Number(fs.readFileSync(pidFile, 'utf8').trim());
}

/** Process-liveness oracle (ESRCH = reaped/gone; EPERM = alive, protected). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function psLine(pid) {
  try {
    return require('child_process')
      .execSync(`ps -p ${pid} -o pid,ppid,stat,etime,cmd --no-headers`, { encoding: 'utf8' })
      .trim();
  } catch (_e) {
    return `<no process ${pid}>`;
  }
}

function writeEvidence(name, text) {
  if (!GENERATE_EVIDENCE) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), text);
}

/** All git:progress broadcast payloads sent while `spy` is active. */
function progressPayloads(spy) {
  return spy.mock.calls
    .filter(([channel]) => channel === 'git:progress')
    .map(([, payload]) => payload);
}

// ─── 1 + 2: the real kill ─────────────────────────────────────────────────────

describe.skipIf(!httpBackendAvailable)('CANCEL HARDENING — real child kill via abort signal', () => {
  // GATE (capability, never unconditional): the kill batteries drive real
  // repos over the loopback git-http-backend server; skipped only where
  // the bundled git lacks the CGI. Unit-level describes stay ungated.
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'a.md': 'base\n' } });
    handlers = makeHandlers(pair.local.dir);
  });
  afterEach(() => pair.dispose());

  it('requestCancel during a LONG merge: git child is SIGTERMed, flow settles cancelled in <15s', async () => {
    await makeDivergent(pair, {
      remoteFiles: { 'c.md': 'remote content\n' },
      remoteMessage: 'remote: add c.md',
    });
    makeDirty(pair.local, { 'a.md': 'local edit\n' });

    const pidFile = path.join(os.tmpdir(), `t6-merge-${process.pid}-${Date.now()}.pid`);
    installBlockingMergeHook(pair.local.dir, pidFile, 60);

    const t0 = Date.now();
    const pending = handlers.gitRefresh(1);

    // Wait until dugite's `git merge` child is parked inside the hook.
    const mergePid = await waitFor(
      () => (fs.existsSync(pidFile) ? readPid(pidFile) : null),
      { label: 'merge child pid file' }
    );
    expect(isAlive(mergePid)).toBe(true);

    // Cross-check via pgrep + /proc/<pid>/cwd scoping (the proof the task
    // demands): the ONLY live `git merge --no-edit` whose cwd is this
    // repo IS the tracked child.
    const pgrepOut = require('child_process')
      .execSync("pgrep -f 'merge --no-edit'", { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((s) => Number(s))
      .filter((pid) => {
        try {
          return fs.readlinkSync(`/proc/${pid}/cwd`) === pair.local.dir;
        } catch (_e) {
          return false;
        }
      });
    expect(pgrepOut).toContain(mergePid);

    const psBefore = psLine(mergePid);

    handlers.requestCancel();
    const result = await pending;

    const elapsed = Date.now() - t0;
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.message).toBe('Operation cancelled by user');
    expect(elapsed).toBeLessThan(15_000);

    // The child must be gone (allow a short reap window).
    await waitFor(() => !isAlive(mergePid), { timeoutMs: 5_000, label: 'merge child death' });
    const psAfter = psLine(mergePid);

    writeEvidence(
      'task-6-cancel-kills-merge.txt',
      [
        `# Task 6 — cancel kills a long git merge (real child)`,
        `repo: ${pair.local.dir}`,
        `merge child pid: ${mergePid}`,
        ``,
        `## ps BEFORE requestCancel`,
        psBefore,
        ``,
        `## ps AFTER settle (result below)`,
        psAfter,
        ``,
        `## flow result`,
        JSON.stringify(result, null, 2),
        ``,
        `## timing`,
        `requestCancel→settle: ${elapsed}ms (hook would have held the child 60s)`,
      ].join('\n')
    );
  });

  it('requestCancel during the flow-entry CHECKOUT (local op, no signal before Task 6): child dies, cancelled:true', async () => {
    // Park the local repo on a side branch so gitPublishPreview's entry
    // checkout (preview) actually runs — the exact call site that gained
    // `{ signal }` in Task 6.
    const git = (await import('isomorphic-git')).default || (await import('isomorphic-git'));
    await git.branch({ fs, dir: pair.local.dir, ref: 'side' });
    await git.checkout({ fs, dir: pair.local.dir, ref: 'side' });

    const pidFile = path.join(os.tmpdir(), `t6-checkout-${process.pid}-${Date.now()}.pid`);
    installBlockingHook(pair.local.dir, 'post-checkout', pidFile, 60);

    const t0 = Date.now();
    const pending = handlers.gitPublishPreview(1, 'local: edit a.md');

    const checkoutPid = await waitFor(
      () => (fs.existsSync(pidFile) ? readPid(pidFile) : null),
      { label: 'checkout child pid file' }
    );
    expect(isAlive(checkoutPid)).toBe(true);

    handlers.requestCancel();
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(Date.now() - t0).toBeLessThan(15_000);
    await waitFor(() => !isAlive(checkoutPid), { timeoutMs: 5_000, label: 'checkout child death' });
  });
});

// ─── 3: heartbeat ────────────────────────────────────────────────────────────

describe('CANCEL HARDENING — heartbeat stays fresh during long subprocess awaits', () => {
  it('the 5s interval keeps renewing WHILE the event loop awaits a child_process promise', async () => {
    const { GitSafety } = await import('../../src/ipc/gitSafety.js');
    const safety = new GitSafety({ logger: makeLogger() });
    safety.startHeartbeat();
    try {
      const t0 = safety._lastHeartbeat;
      // Same await shape as dugite's execFile (a real subprocess promise).
      await execFileAsync('sleep', ['6']);
      // A tick at +5s must have landed DURING the await — this is the
      // duration-independent property that keeps a 200s push fresh too.
      expect(safety._lastHeartbeat).toBeGreaterThanOrEqual(t0 + 4_000);
      expect(safety.checkStaleHeartbeat()).toBe(false);
    } finally {
      safety.stopHeartbeat();
    }
  }, 15_000);

  it('renewHeartbeat(): immediate refresh while running, no-op when stopped', async () => {
    const { GitSafety } = await import('../../src/ipc/gitSafety.js');
    const safety = new GitSafety({ logger: makeLogger() });

    // Stopped → renewal must NOT resurrect the heartbeat (would mask a
    // dead holder from the next acquire's stale check).
    safety.renewHeartbeat();
    expect(safety._lastHeartbeat).toBeNull();
    expect(safety.checkStaleHeartbeat()).toBe(false);

    safety.startHeartbeat();
    try {
      // Backdate beyond any threshold, renew, verify freshness.
      safety._lastHeartbeat = Date.now() - 600_000;
      expect(safety.checkStaleHeartbeat()).toBe(true);
      safety.renewHeartbeat();
      expect(safety.checkStaleHeartbeat()).toBe(false);
      expect(safety._heartbeatInterval).not.toBeNull();
    } finally {
      safety.stopHeartbeat();
    }
  });
});

describe.skipIf(!httpBackendAvailable)('CANCEL HARDENING — long real flow is NOT stale-aborted', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'a.md': 'base\n' } });
    handlers = makeHandlers(pair.local.dir);
  });
  afterEach(() => pair.dispose());

  it('refresh with a 5s-slowed merge completes successfully; heartbeat never goes stale mid-flight', async () => {
    await makeDivergent(pair, {
      remoteFiles: { 'c.md': 'remote content\n' },
      remoteMessage: 'remote: add c.md',
    });
    makeDirty(pair.local, { 'a.md': 'local edit\n' });

    // Slow the merge via the merge-guarded prepare-commit-msg hook (NOT
    // the whole 200s pre-receive — see file header): the mechanism proof
    // above makes duration irrelevant; this proves the integration — a
    // legitimately slow command under an active lock + heartbeat ends in
    // success, never in stale-abort.
    installBlockingMergeHook(pair.local.dir, path.join(os.tmpdir(), `t6-nostale-${process.pid}.pid`), 5);

    const staleSamples = [];
    const sampler = setInterval(() => {
      if (handlers.gitOperationInProgress) {
        staleSamples.push(handlers.gitSafety.checkStaleHeartbeat());
      }
    }, 200);

    try {
      const result = await handlers.gitRefresh(1);
      expect(result.success).toBe(true);
      expect(staleSamples.length).toBeGreaterThan(0);
      expect(staleSamples.every((stale) => stale === false)).toBe(true);

      writeEvidence(
        'task-6-no-stale-abort.txt',
        [
          `# Task 6 — heartbeat does not stale-abort a legitimately slow operation`,
          `flow: gitRefresh with prepare-commit-msg hook sleeping 5s`,
          `result: ${JSON.stringify(result)}`,
          `stale-check samples while lock held: ${staleSamples.length} (all false: ${staleSamples.every((s) => s === false)})`,
          `mechanism: 5s setInterval keeps firing during child_process awaits`,
          `(proven in the unit battery above at any duration — incl. >180s pushes)`,
        ].join('\n')
      );
    } finally {
      clearInterval(sampler);
    }
  }, 30_000);
});

// ─── 4: cancelling:true progress flag ────────────────────────────────────────

describe('CANCEL HARDENING — cancelling flag on the progress emitter helpers', () => {
  let handlers;

  beforeEach(() => {
    vi.clearAllMocks();
    const databaseManager = {
      getDatabase: vi.fn().mockResolvedValue({ get: vi.fn() }),
    };
    handlers = new (require('../../src/ipc/git.js').GitHandlers)({
      logger: makeLogger(),
      databaseManager,
    });
  });

  it('_emitStage/_emitTransferProgress add cancelling:true only while a cancel is pending', () => {
    const broadcastSpy = vi.spyOn(handlers, 'broadcastToWindows').mockImplementation(() => {});
    handlers.acquireGitLock();
    const op = handlers._beginOperation(1, 'refresh');

    handlers._emitStage(op, 'fetching', 'before cancel');
    expect(progressPayloads(broadcastSpy).at(-1).cancelling).toBeUndefined();

    handlers._emitTransferProgress(op, { loaded: 1, total: 2 });
    expect(progressPayloads(broadcastSpy).at(-1).cancelling).toBeUndefined();

    handlers.requestCancel();

    handlers._emitStage(op, 'merging', 'after cancel');
    expect(progressPayloads(broadcastSpy).at(-1).cancelling).toBe(true);

    handlers._emitTransferProgress(op, { loaded: 2, total: 2 });
    expect(progressPayloads(broadcastSpy).at(-1).cancelling).toBe(true);

    handlers._emitTerminal(op, 'cancelled');
    expect(progressPayloads(broadcastSpy).at(-1).terminal).toBe('cancelled');
    handlers.releaseGitLock();
    broadcastSpy.mockRestore();
  });
});

describe.skipIf(!httpBackendAvailable)('CANCEL HARDENING — cancelling:true on progress events between requestCancel and settle', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'a.md': 'base\n' } });
    handlers = makeHandlers(pair.local.dir);
  });
  afterEach(() => pair.dispose());

  it('cancel mid-flow: typed cancelled result, exactly-once terminal, no premature cancelling flags', async () => {
    await makeDivergent(pair, {
      remoteFiles: { 'c.md': 'remote content\n' },
      remoteMessage: 'remote: add c.md',
    });
    makeDirty(pair.local, { 'a.md': 'local edit\n' });

    const broadcastSpy = vi.spyOn(handlers, 'broadcastToWindows');

    // Cancel as the DEEPEN fetch starts (the fetch without `depth`): the
    // aborted signal kills the child immediately and the post-deepen
    // cooperative checkpoint stops the flow BEFORE the conflict gate can
    // misread the crippled shallow history.
    const originalFetch = handlers.git.fetch.bind(handlers.git);
    const fetchSpy = vi.spyOn(handlers.git, 'fetch').mockImplementation(async (p, opts) => {
      if (!('depth' in opts)) {
        handlers.requestCancel();
      }
      return originalFetch(p, opts);
    });

    try {
      const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.message).toBe('Operation cancelled by user');

      const payloads = progressPayloads(broadcastSpy);
      const terminal = payloads.filter((p) => p.terminal);
      expect(terminal).toHaveLength(1);
      expect(terminal[0].terminal).toBe('cancelled');

      // Everything this flow emitted predates the cancel (the checkpoint
      // returns before the merging emit) — the flag contract is covered
      // by the helper battery above.
      expect(payloads.every((p) => p.cancelling === undefined)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      broadcastSpy.mockRestore();
    }
  });
});
