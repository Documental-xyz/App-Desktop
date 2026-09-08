/**
 * @fileoverview publish-update-resilience Task 8 — TRANSIENT push retry.
 *
 * Wiring under test: MAX_PUBLISH_RETRIES (gitFlowTypes.js) drives
 * `_pushWithTransientRetry` around the publish cores' push step — up to
 * 2 retries (3 attempts) with 1s/2s backoff for TRANSIENT failures
 * only (T5 classes timeout|network; iso-git's empty-payload pack
 * ParseError = connection dropped mid-push; legacy
 * gitOperations._isRetriablePushError evidence).
 *
 * Never retried (idempotency / frozen contracts):
 *  - PUSH_REJECTED / large_file (GH001 stderr carries "[remote
 *    rejected]") / auth / 409 → EXACTLY 1 attempt;
 *  - user cancel (AbortError + cancel flag) → 1 attempt, cancelled
 *    result (characterization Block 2 freeze).
 *
 * Order with Task 7: auto-restore (_restoreOnFailure, VERIFY_THEN_RESTORE
 * via gitSafety.verifyRemoteState) runs in the wrappers' failure cleanup
 * — i.e. only AFTER retries are exhausted (scenario 6 proves it: 3
 * attempts, then restored:true).
 *
 * Scenario 1 uses the loopback origin's pre-receive HOOK with a counter
 * FILE: the first invocation KILLS git-receive-pack (drops the HTTP
 * response mid-push — the "conexão ruim" the plan wants self-healed;
 * dugite surfaces the drop as a network-class GitError — "RPC failed"
 * / connection-closed stderr — the actual signature lands in the
 * evidence JSON), the second accepts. A polite `exit 1` decline was
 * probed and is a SERVER REFUSAL (GitPushError "pre-receive hook
 * declined"), correctly NOT retried — same family as remote-rejected.
 *
 * Evidence: writes .omo/evidence/task-8-transient-retry.json and
 * task-8-rejected-single.txt.
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

import {
  createRepoPair,
  makeDivergent,
  makeDirty,
  httpBackendAvailable,
} from './fixtures/harness.js';
import { GitHandlers } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { providerFactory } from '../git-providers/harness.js';
import { verifyRemoteState } from '../../src/ipc/gitSafety.js';
import { MAX_PUBLISH_RETRIES } from '../../src/ipc/gitFlowTypes.js';
import { GitError } from '../../src/git/GitError.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ─── DI helpers (publish-flow structure; dugite since T16 — the killed
// receive-pack surfaces as a network-class GitError, still transient) ─────

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
    gitService: new GitService({
      provider: providerFactory('dugite')(),
    }),
  });
  vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('test-token');
  vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
  handlers.gitPreflight = null;
  return handlers;
}

/** Counting spy over the REAL facade push. */
function countingPushSpy(handlers) {
  const realPush = handlers.git.push.bind(handlers.git);
  const state = { calls: 0, errors: [] };
  const spy = vi.spyOn(handlers.git, 'push').mockImplementation(async (p, opts) => {
    state.calls++;
    try {
      return await realPush(p, opts);
    } catch (e) {
      state.errors.push(`${e.name}: ${String(e.message).split('\n')[0]}`);
      throw e;
    }
  });
  return { spy, state };
}

/** Capture the FINAL git:progress payloads (post stageIndex computation). */
function captureProgress(handlers) {
  const events = [];
  vi.spyOn(handlers, 'broadcastToWindows').mockImplementation((channel, payload) => {
    if (channel === 'git:progress') events.push(payload);
  });
  return events;
}

function writeEvidence(name, content) {
  const dir = path.resolve(process.cwd(), '.omo', 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
}

/**
 * Origin pre-receive hook with a counter FILE (plan-specified mechanism).
 * First invocation kills git-receive-pack ($PPID) — the HTTP response is
 * truncated mid-push and the client sees the drop; later invocations
 * accept. The counter lives in the pair's temp baseDir (auto-cleaned).
 */
function installDroppingHook(pair, dropCount = 1) {
  const counter = path.join(pair.baseDir, 'hook-invocations');
  const hook = path.join(pair.bare, 'hooks', 'pre-receive');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(
    hook,
    [
      '#!/bin/sh',
      'n=$(cat "$0.counter" 2>/dev/null || echo 0)',
      'n=$((n + 1))',
      `echo $n > "\${0}.counter"`,
      `if [ "$n" -le ${dropCount} ]; then kill -9 $PPID; fi`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  fs.chmodSync(hook, 0o755);
  return counter;
}

const A_BASE = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
const A_LOCAL = A_BASE.replace('line5', 'line5-LOCAL');

// ─── Flow battery (real repos over loopback http-backend) ───────────────────

describe.skipIf(!httpBackendAvailable)('push transient retry — publish flow (dugite)', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'a.md': A_BASE } });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  // (1) REAL transport drop: hook kills receive-pack on the 1st push.
  // UNDER DUGITE (T16 divergence, pinned): the drop surfaces as
  // "send-pack: unexpected disconnect … the remote end hung up
  // unexpectedly", which the retry whitelist does NOT carry (it holds the
  // iso-era ParseError signature) → classified unknown → EXACTLY 1
  // attempt, typed failure, remote untouched, local intact. The retry
  // MACHINERY itself stays proven by scenarios 3/5/6 (timeout/network
  // classes → retried) and the unit battery below. TRIPWIRE: when the
  // whitelist gains dugite's drop signature (T17 follow-up), this test
  // fails on purpose — flip it back to the retry-lands scenario.
  it('connection dropped on 1st push (dugite signature) → unknown class → 1 attempt, remote untouched, local intact', async () => {
    installDroppingHook(pair, 1);
    makeDirty(pair.local, { 'a.md': A_LOCAL });
    const { spy, state } = countingPushSpy(handlers);

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');
    spy.mockRestore();

    expect(result.success).toBe(false);
    expect(state.calls).toBe(1); // unknown class is never retried
    expect(result.errorClass).toBe('unknown'); // pinned — flips with T17

    // Remote REALLY does not contain the commit (ls-remote verified).
    const head = await pair.local.resolveRef('HEAD');
    const verify = await verifyRemoteState(
      handlers.git, pair.local.dir, 'preview', head,
    );
    expect(verify.verified).toBe(true);
    expect(verify.remoteContains).toBe(false);

    // Local intact: the edit survived and nothing was lost.
    expect(await pair.local.readFile('a.md')).toContain('line5-LOCAL');

    writeEvidence('task-8-transient-retry.json', {
      scenario: 'origin pre-receive hook (counter file) kills git-receive-pack on the 1st push — dugite drop signature NOT yet in the retry whitelist (T16 pinned; T17 follow-up)',
      maxPublishRetries: MAX_PUBLISH_RETRIES,
      pushAttempts: state.calls,
      firstFailureSignature: state.errors[0] || null,
      result: { success: result.success, errorClass: result.errorClass },
      verifyRemoteState: verify,
    });
  });

  // (2) Remote ahead → deterministic refusal: EXACTLY 1 attempt.
  it('non-fast-forward (remote ahead) → PUSH_REJECTED with EXACTLY 1 attempt', async () => {
    await makeDivergent(pair, {
      remoteFiles: { 'c.md': 'remote content\n' },
      remoteMessage: 'remote: add c.md',
    });
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    const spy = vi.spyOn(handlers.git, 'push').mockRejectedValue(
      Object.assign(new Error('push rejected: non-fast-forward'), {
        code: 'PushRejectedError',
      }),
    );

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');
    const attempts = spy.mock.calls.length; // read BEFORE mockRestore wipes history

    expect(result.success).toBe(false);
    expect(result.code).toBe('PUSH_REJECTED');
    expect(attempts).toBe(1); // single attempt — frozen contract

    spy.mockRestore();

    writeEvidence('task-8-rejected-single.txt', [
      'Cenário 1: remote à frente (non-fast-forward) → PUSH_REJECTED.',
      `push attempts: ${attempts} (EXATAMENTE 1 — rejeição nunca é retriable).`,
      `result: success=${result.success} code=${result.code}`,
      '',
    ].join('\n'));
  });

  // (3) T5 class timeout on the 1st attempt → retry → success.
  it('timeout-classified failure on 1st push → retry succeeds (2 attempts)', async () => {
    makeDirty(pair.local, { 'a.md': A_LOCAL });
    const realPush = handlers.git.push.bind(handlers.git);
    let calls = 0;
    const spy = vi.spyOn(handlers.git, 'push').mockImplementation(async (p, opts) => {
      calls++;
      if (calls === 1) {
        throw new Error('error: RPC failed; curl 28 Operation timed out');
      }
      return realPush(p, opts);
    });

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');
    spy.mockRestore();

    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    const head = await pair.local.resolveRef('HEAD');
    expect(await pair.local.resolveRef('refs/remotes/origin/preview')).toBe(head);
  });

  // (4) large_file (GH001 stderr) → deterministic: EXACTLY 1 attempt.
  it('GH001 large-file stderr → 1 attempt only, errorClass large_file', async () => {
    makeDirty(pair.local, { 'a.md': A_LOCAL });
    const ghStderr = [
      'remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.',
      'To github.com:acme/site.git',
      ' ! [remote rejected] preview -> preview (pre-receive hook declined)',
      "error: failed to push some refs to 'github.com:acme/site.git'",
    ].join('\n');
    const spy = vi.spyOn(handlers.git, 'push');
    spy.mockRejectedValueOnce(
      new GitError({ operation: 'push', provider: 'github', exitCode: 1, stderr: ghStderr }),
    );

    const result = await handlers.gitPublishPreview(1, 'local: add big asset');
    const attempts = spy.mock.calls.length; // read BEFORE mockRestore wipes history

    expect(result.success).toBe(false);
    expect(attempts).toBe(1); // never retried — idempotency
    expect(result.errorClass).toBe('large_file');
    spy.mockRestore();

    const ev = path.resolve(process.cwd(), '.omo', 'evidence', 'task-8-rejected-single.txt');
    fs.appendFileSync(ev, [
      'Cenário 2: GH001 large_file (stub stderr no 1º push).',
      `push attempts: ${attempts} (EXATAMENTE 1 — large_file nunca é retriable).`,
      `result: success=${result.success} errorClass=${result.errorClass}`,
      '',
    ].join('\n'));
  });

  // (5) Progress contract: retry messages present, stageIndex frozen.
  it('progress events: "Tentativa N/3…" on stage pushing, stageIndex never changes between attempts', async () => {
    makeDirty(pair.local, { 'a.md': A_LOCAL });
    const events = captureProgress(handlers);
    const realPush = handlers.git.push.bind(handlers.git);
    let calls = 0;
    const spy = vi.spyOn(handlers.git, 'push').mockImplementation(async (p, opts) => {
      calls++;
      if (calls === 1) {
        throw new Error('fatal: unable to access origin: ECONNRESET');
      }
      return realPush(p, opts);
    });

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');
    spy.mockRestore();

    expect(result.success).toBe(true);
    expect(calls).toBe(2);

    const flowEvents = events.filter((e) => e.flow === 'publish-preview');
    const pushing = flowEvents.filter((e) => e.stage === 'pushing');
    // Every pushing-stage event carries the SAME stageIndex (4 of 5) —
    // retries never regress/advance the reported stage.
    expect(pushing.length).toBeGreaterThan(1);
    expect(pushing.every((e) => e.stageIndex === 4 && e.stageTotal === 5)).toBe(true);
    expect(pushing.some((e) => /^Tentativa 2\/3/.test(e.message || ''))).toBe(true);
    // Terminal discipline (T2): exactly one terminal, after all retries.
    const terminals = flowEvents.filter((e) => e.terminal);
    expect(terminals.length).toBe(1);
    expect(terminals[0].terminal).toBe('complete');
  });

  // (6) All attempts transient → EXACTLY 3 attempts (MAX_PUBLISH_RETRIES=2
  // retries), original error class preserved, and T7 auto-restore fires
  // only AFTER exhaustion (restored:true).
  it('persistent transient failure → 3 attempts, errorClass network, auto-restore after exhaustion', async () => {
    await makeDivergent(pair, {
      remoteFiles: { 'c.md': 'remote content\n' },
      remoteMessage: 'remote: add c.md',
    });
    makeDirty(pair.local, { 'a.md': A_LOCAL });

    const spy = vi.spyOn(handlers.git, 'push').mockRejectedValue(
      new Error('fatal: unable to access origin: ECONNRESET')
    );

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

    expect(result.success).toBe(false);
    expect(spy.mock.calls.length).toBe(3); // 1 + MAX_PUBLISH_RETRIES
    expect(MAX_PUBLISH_RETRIES).toBe(2);
    expect(result.errorClass).toBe('network');
    // T7 order: push stage + network → VERIFY_THEN_RESTORE → remote does
    // NOT contain → restored AFTER the 3 attempts were exhausted.
    expect(result.restored).toBe(true);
    spy.mockRestore();
  });

  // (7) Cancel is never a retry: AbortError → 1 attempt, cancelled result
  // (characterization Block 2 freeze).
  it('AbortError during push → EXACTLY 1 attempt, cancelled result', async () => {
    makeDirty(pair.local, { 'a.md': A_LOCAL });
    const abortErr = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const spy = vi.spyOn(handlers.git, 'push').mockImplementation(async () => {
      handlers.requestCancel();
      throw abortErr;
    });

    const result = await handlers.gitPublishPreview(1, 'local: edit a.md');

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(spy.mock.calls.length).toBe(1); // cancel ≠ transient
    spy.mockRestore();
  });
});

// ─── Classifier unit battery (no transport needed) ───────────────────────────

describe('_isTransientPushError — retry whitelist (unit)', () => {
  let handlers;
  beforeEach(() => {
    handlers = makeHandlers('/unused');
  });

  const transient = (error) => handlers._isTransientPushError(error);
  const err = (msg, props) => Object.assign(new Error(msg), props || {});

  it('retries T5 classes timeout and network', () => {
    expect(transient(err('error: RPC failed; curl 28 Operation timed out'))).toBe(true);
    expect(transient(err('Connection timed out'))).toBe(true);
    expect(transient(err('fatal: unable to access origin: ECONNRESET', { code: 'ECONNRESET' }))).toBe(true);
    expect(transient(err('fatal: could not resolve host'))).toBe(true);
  });

  it('retries iso-git empty-payload ParseError (connection dropped mid-push)', () => {
    expect(transient(err('Expected "unpack ok" or "unpack [error message]" but received "".', { name: 'ParseError' }))).toBe(true);
    // Provider wrap form: GitError carries the parse text in stderr,
    // raw ParseError rides on .cause.
    const wrapped = new GitError({
      operation: 'push',
      provider: 'isomorphic-git',
      stderr: 'Expected "unpack ok" or "unpack [error message]" but received "".',
      cause: Object.assign(new Error('same'), { name: 'ParseError' }),
    });
    expect(transient(wrapped)).toBe(true);
    // Garbage-but-present payloads stay unknown → not retried.
    expect(transient(err('Expected "unpack ok" but received "junk".', { name: 'ParseError' }))).toBe(false);
  });

  it('never retries deterministic refusals', () => {
    expect(transient(err('push rejected: non-fast-forward', { code: 'PushRejectedError' }))).toBe(false);
    expect(transient(err('! [remote rejected] preview (fetch first)'))).toBe(false);
    expect(transient(err('HTTP Error: 401 Unauthorized'))).toBe(false);
    expect(transient(err('HTTP Error: 403 Forbidden'))).toBe(false);
    expect(transient(err('conflict: 409 state mismatch'))).toBe(false);
    expect(transient(err('remote: error: GH001: Large files detected.'))).toBe(false);
  });

  it('never retries cancels', () => {
    expect(transient(err('The operation was aborted', { name: 'AbortError' }))).toBe(false);
    expect(transient(err('boom', { code: 'ABORT_ERR' }))).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect(transient(err('boom'), controller.signal)).toBe(false);
    handlers.requestCancel();
    expect(transient(err('fatal: ECONNRESET'))).toBe(false); // even transient while cancel pending
  });

  it('retries HTTP 5xx via legacy provider evidence (gitOperations._isRetriablePushError)', () => {
    expect(transient(err('git push failed', { response: { status: 502 } }))).toBe(true);
    expect(transient(err('git push failed', { response: { status: 422 } }))).toBe(false);
  });
});
