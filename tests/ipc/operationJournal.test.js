/**
 * @fileoverview publish-update-resilience Task 3: per-operation raw
 * output journal ("Journal de operação — saída bruta sanitizada do git").
 *
 * Contract (plan; written BEFORE the implementation — TDD):
 *   - Every git command executed by DugiteProvider._run during an
 *     operation is captured as
 *       { seq, timestamp, args[], exitCode, stdout, stderr, durationMs }
 *     in an in-memory ring (cap 500/operation), sanitized BEFORE storing.
 *   - Attribution: _run does not know the operationId — GitHandlers sets
 *     the journal's CURRENT operation in _beginOperation (born with the
 *     single git lock); _run notifies recordCommand(null, entry) which
 *     inherits the current operation. Commands outside any operation
 *     land in a disposable unattributed buffer.
 *   - Expiry: 30 min after the terminal event (timer) + sweepExpired()
 *     backstop (injected clock for tests). Never persisted to disk.
 *   - Sanitization (security): URL-embedded credentials
 *     https://user:token@host → https://user:***@host, Authorization
 *     headers, GH_TOKEN/GITHUB_TOKEN env values, and the GitError token
 *     patterns (reuse, not duplication). The journal must NEVER contain
 *     a raw credential in any field.
 *   - IPC git:get-operation-log (invoke, args: operationId) →
 *     {success:true, entries[]} | {success:false, code:'LOG_NOT_FOUND'}.
 *
 * Structure: real repositories from the fixtures harness + DugiteProvider
 * (the only provider whose _run choke point journals raw output) +
 * canonical DI (vi.unmock('fs')/vi.unmock('path') — setup.js mocks them
 * globally). webContents capture mirrors git.progress.test.js.
 *
 * Evidence: run with GENERATE_JOURNAL_EVIDENCE=1 to (re)write
 * .omo/evidence/task-3-journal-publish.json and
 * .omo/evidence/task-3-token-sanitized.txt.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// tests/setup.js mocks fs/path globally — these fixtures need the REAL fs.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';
import { exec as dugiteExec } from 'dugite';

import { createRepoPair, makeDivergent, makeDirty } from '../git/fixtures/harness.js';
import { sanitizeCommandOutput } from '../../src/git/GitError.js';
import { GitHandlers } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { providerFactory } from '../git-providers/harness.js';

// git.js wires the journal singleton through a NATIVE CJS require, which
// does NOT share the vite-transformed module registry — importing the
// singleton as ESM here would yield a SEPARATE instance. createRequire
// goes through node's module cache, so test and wiring share state.
import { createRequire } from 'module';
const nodeRequire = createRequire(import.meta.url);
const {
  journal,
  OperationJournal,
  JOURNAL_TTL_MS,
  JOURNAL_MAX_ENTRIES,
  JOURNAL_MAX_OPERATION_LIFETIME_MS,
} = nodeRequire('../../src/ipc/operationJournal.js');

const EVIDENCE_DIR = path.resolve(process.cwd(), '.omo/evidence');

// ─── Event capture (webContents.send at the broadcastToWindows fan-out) ──────

const sendSpy = vi.fn();
const fakeWindow = { isDestroyed: () => false, webContents: { send: sendSpy } };
let originalGetAllWindows;

/** All git:progress payloads broadcast so far. */
function progressEvents() {
  return sendSpy.mock.calls
    .filter(([channel]) => channel === 'git:progress')
    .map(([, payload]) => payload);
}

/** The (single) operationId of the last operation, from its terminal event. */
function lastOperationId() {
  const terminal = progressEvents().filter((e) => e.terminal).pop();
  expect(terminal).toBeDefined();
  return terminal.operationId;
}

// ─── DI helpers (canonical structure — git.progress.test.js pattern) ─────────

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * GitHandlers whose getProjectPath(1) resolves to `projectPath`, pinned
 * to the DUGITE provider (the journal's capture point is
 * DugiteProvider._run — the only place raw stdout/stderr exist before
 * being discarded).
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
    gitService: new GitService({
      provider: providerFactory('dugite')(),
    }),
  });
  vi.spyOn(handlers.gitOps, 'getGitHubToken').mockResolvedValue('test-token');
  vi.spyOn(handlers.gitOps, 'configureGitForUser').mockResolvedValue(true);
  vi.spyOn(handlers.gitOps, 'getGitHubUserInfo').mockResolvedValue({ login: 'testuser' });
  handlers.gitPreflight = null;
  return handlers;
}

// ─── Shared fixture lifecycle ────────────────────────────────────────────────

/** @type {Array<{dispose(): void}>} */
const pairs = [];

beforeEach(() => {
  sendSpy.mockClear();
  journal.reset();
  originalGetAllWindows = global.mockElectron.BrowserWindow.getAllWindows;
  global.mockElectron.BrowserWindow.getAllWindows = vi.fn(() => [fakeWindow]);
  if (!global.mockElectron.ipcMain.removeHandler) {
    global.mockElectron.ipcMain.removeHandler = vi.fn();
  }
});

afterEach(async () => {
  global.mockElectron.BrowserWindow.getAllWindows = originalGetAllWindows;
  while (pairs.length > 0) {
    pairs.pop().dispose();
  }
});

/** Run a git CLI command via dugite (setup-only helper). */
async function gitCli(dir, args) {
  const res = await dugiteExec(args, dir);
  if (res.exitCode !== 0) throw new Error(res.stderr || 'git setup failed');
  return res.stdout;
}

// ─── 1. Capture: a real publish flow journals every command ──────────────────

describe('operation journal — capture (real gitPushToBranch flow, dugite)', () => {
  it('journals ≥6 commands (commit/branch/fetch/merge/push/checkout) with the full entry shape', async () => {
    const pair = await createRepoPair({ files: { 'README.md': '# base' } });
    pairs.push(pair);
    // True divergence (different files → no conflict gate) forces the
    // fetch → deepen → merge path; a dirty tree forces the WIP commit;
    // the backup-guarded publish creates the backup branch; post-merge
    // materialization + original-branch restore run checkouts.
    await makeDivergent(pair, {
      localFiles: { 'local-note.md': 'local side' },
      remoteFiles: { 'remote-note.md': 'remote side' },
    });
    makeDirty(pair.local, { 'draft.txt': 'wip' });

    const handlers = makeHandlers(pair.local.dir);
    const result = await handlers.gitPushToBranch(pair.local.dir, 'main', 'journal capture test', 1);

    expect(result.success).toBe(true);
    const operationId = lastOperationId();
    const entries = journal.getEntries(operationId);

    // Enough commands for a meaningful diagnosis…
    expect(entries).not.toBeNull();
    expect(entries.length).toBeGreaterThanOrEqual(6);

    if (process.env.DEBUG_JOURNAL === '1') {
      console.log('CAPTURE HEADS:', JSON.stringify(entries.map((e) => [e.seq, e.args.slice(0, 3), e.exitCode]), null, 1));
    }

    // …including the 6 canonical publish steps. Token-based (args
    // INCLUDES the verb): dugite prefixes identity config on some
    // commands (`-c user.name=… commit -m …`), so argv[0] is not
    // always the verb itself.
    for (const verb of ['commit', 'branch', 'fetch', 'merge', 'push', 'checkout']) {
      expect(
        entries.some((e) => e.args.includes(verb)),
        `journal must contain a '${verb}' command`
      ).toBe(true);
    }

    // Entry shape contract on EVERY entry.
    let lastSeq = 0;
    for (const e of entries) {
      expect(Array.isArray(e.args)).toBe(true);
      expect(e.args.length).toBeGreaterThan(0);
      expect(e.args.every((a) => typeof a === 'string')).toBe(true);
      expect(typeof e.exitCode).toBe('number');
      expect(typeof e.durationMs).toBe('number');
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof e.timestamp).toBe('number');
      expect(e.seq).toBe(lastSeq + 1); // 1-based, strictly sequential
      lastSeq = e.seq;
    }
    // Successful flow → the push itself exited 0. (Other entries may
    // legitimately be non-zero: T4's allowedExitCodes plumbing treats
    // e.g. `merge-base --is-ancestor` exit 1 as a RESULT, not an error.)
    expect(entries.some((e) => e.args.includes('push') && e.exitCode === 0)).toBe(true);

    if (process.env.GENERATE_JOURNAL_EVIDENCE === '1') {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, 'task-3-journal-publish.json'),
        JSON.stringify({
          operationId,
          flow: 'publish-preview',
          entryCount: entries.length,
          entries,
        }, null, 2)
      );
    }
  }, 120000);
});

// ─── 2. Sanitization (security) — credentials never reach the journal ────────

describe('operation journal — sanitization (security)', () => {
  it('masks URL-embedded credentials: a failed fetch against a credentialed remote never stores the token', async () => {
    const pair = await createRepoPair({ files: { 'README.md': '# base' } });
    pairs.push(pair);
    makeDirty(pair.local, { 'draft.txt': 'wip' });

    // Remote URL with an embedded PAT, pointing at a CLOSED local port
    // (127.0.0.1:9 = discard) — git fails fast at the fetch step and
    // echoes the full URL (credentials included) in its stderr.
    const CRED_URL = 'https://user:ghp_FAKE123@127.0.0.1:9/nonexistent.git';
    await gitCli(pair.local.dir, ['remote', 'set-url', 'origin', CRED_URL]);

    const handlers = makeHandlers(pair.local.dir);
    const result = await handlers.gitPushToBranch(pair.local.dir, 'main', 'sanitize test', 1);

    expect(result.success).toBe(false); // fetch against dead origin fails
    const operationId = lastOperationId();
    const entries = journal.getEntries(operationId);
    expect(entries).not.toBeNull();

    // The fetch command itself ran and failed — the journal captured it.
    expect(entries.some((e) => e.args[0] === 'fetch' && e.exitCode !== 0)).toBe(true);

    // SECURITY: the token must not appear in ANY field of ANY entry.
    const blob = JSON.stringify(entries);
    if (process.env.DEBUG_JOURNAL === '1') {
      console.log('SANITIZE HEADS:', JSON.stringify(entries.map((e) => [e.args.slice(0, 3), e.exitCode, (e.stderr || '').slice(0, 160)]), null, 1));
    }
    expect(blob.includes('ghp_FAKE123')).toBe(false);

    // Positive control via argv: modern git REDACTS userinfo from URLs it
    // echoes in errors (defense-in-depth on git's side), so a flow-level
    // stderr cannot prove the mask. ls-remote/clone carry the raw URL IN
    // ARGV (the production path for project clone) — run one through the
    // wired journal and assert the mask on the stored args.
    const CRED_URL_ARGV = 'https://argvuser:ghp_FAKE123@127.0.0.1:9/nonexistent.git';
    journal.setCurrentOperation('sanitize-argv-probe', { projectId: 1, flow: 'publish-preview' });
    const provider = providerFactory('dugite')();
    await provider.listServerRefs(CRED_URL_ARGV).catch(() => { /* conn refused — captured anyway */ });
    journal.markTerminal('sanitize-argv-probe');
    const probe = journal.getEntries('sanitize-argv-probe');
    expect(probe).not.toBeNull();
    expect(probe.some((e) => e.args.includes('ls-remote') && e.exitCode !== 0)).toBe(true);
    const probeBlob = JSON.stringify(probe);
    expect(probeBlob.includes('ghp_FAKE123')).toBe(false);
    expect(probeBlob.includes('argvuser:***@')).toBe(true); // masked URL retained

    if (process.env.GENERATE_JOURNAL_EVIDENCE === '1') {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, 'task-3-token-sanitized.txt'),
        [
          `operationId: ${operationId}`,
          `flow entries: ${entries.length} | argv-probe entries: ${probe.length}`,
          `flow journal contains the token: ${blob.includes('ghp_FAKE123') ? 'FOUND (FAIL)' : 'NOT FOUND (PASS)'}`,
          `argv probe (ls-remote URL in args) contains the token: ${probeBlob.includes('ghp_FAKE123') ? 'FOUND (FAIL)' : 'NOT FOUND (PASS)'}`,
          `argv probe masked URL retained ('argvuser:***@'): ${probeBlob.includes('argvuser:***@') ? 'yes (PASS)' : 'no (FAIL)'}`,
          'note: modern git itself redacts userinfo from URLs echoed in stderr —',
          'the argv probe is the deterministic mask proof (clone/ls-remote carry raw URLs in argv).',
          '',
          '--- sanitized flow entries ---',
          blob,
          '',
          '--- sanitized argv-probe entries ---',
          probeBlob,
          '',
        ].join('\n')
      );
    }
  }, 120000);

  it('sanitizes args arrays too (push URL arg is masked at record time)', () => {
    const j = new OperationJournal();
    j.beginEntry('args-mask');
    j.recordCommand('args-mask', {
      args: ['push', 'https://user:ghp_FAKE123@localhost/repo.git'],
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
    });
    const [entry] = j.getEntries('args-mask');
    expect(entry.args[1]).toBe('https://user:***@localhost/repo.git');
    j.dispose('args-mask');
  });
});

// ─── 3. sanitizeCommandOutput unit contract (layered on GitError tokens) ─────

describe('sanitizeCommandOutput (GitError export, reused by the journal)', () => {
  it('masks URL-embedded credentials preserving the username', () => {
    expect(sanitizeCommandOutput('fatal: unable to access \'https://user:ghp_FAKE123@localhost/repo.git/\': failed'))
      .toBe('fatal: unable to access \'https://user:***@localhost/repo.git/\': failed');
  });

  it('masks bare-token userinfo URLs (https://token@host)', () => {
    expect(sanitizeCommandOutput('https://ghp_SOMETHINGLONGERTHAN20@host/x.git'))
      .toBe('https://***@host/x.git');
  });

  it('masks Authorization headers entirely', () => {
    expect(sanitizeCommandOutput('Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUV123'))
      .toBe('Authorization: ***');
    expect(sanitizeCommandOutput('authorization: Basic dXNlcjpwYXNzd29yZA=='))
      .toBe('authorization: ***');
  });

  it('masks GH_TOKEN/GITHUB_TOKEN env values', () => {
    expect(sanitizeCommandOutput('GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUV')).toBe('GH_TOKEN=***');
    expect(sanitizeCommandOutput('GITHUB_TOKEN: ghp_ABCDEFGHIJKLMNOPQRSTUV')).toBe('GITHUB_TOKEN: ***');
  });

  it('still applies the GitError standalone token patterns (reuse, not duplication)', () => {
    expect(sanitizeCommandOutput('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ rejected'))
      .toBe('token [REDACTED] rejected');
    expect(sanitizeCommandOutput('pair secret12345678:x-oauth-basic'))
      .toBe('pair [REDACTED]');
  });

  it('passes through undefined/null untouched (GitError.sanitize parity)', () => {
    expect(sanitizeCommandOutput(undefined)).toBeUndefined();
    expect(sanitizeCommandOutput(null)).toBeUndefined();
  });
});

// ─── 4. Expiry — 30 min post-terminal (timer) + sweep backstop ───────────────

describe('operation journal — expiry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-disposes 30 min after markTerminal via the expiry timer', () => {
    vi.useFakeTimers();
    const j = new OperationJournal();
    j.beginEntry('op-a');
    j.recordCommand('op-a', { args: ['fetch'], exitCode: 0, stdout: '', stderr: '', durationMs: 5 });
    j.markTerminal('op-a');

    expect(j.getEntries('op-a').length).toBe(1); // alive before TTL

    vi.advanceTimersByTime(JOURNAL_TTL_MS - 1);
    expect(j.getEntries('op-a')).not.toBeNull(); // last ms before expiry

    vi.advanceTimersByTime(1);
    expect(j.getEntries('op-a')).toBeNull(); // expired
  });

  it('sweepExpired() drops terminalized ops past TTL (injected clock, no timer)', () => {
    let t = 1000;
    const j = new OperationJournal({ now: () => t });
    j.beginEntry('s1');
    j.recordCommand('s1', { args: ['push'], exitCode: 0, stdout: '', stderr: '', durationMs: 1 });
    j.markTerminal('s1');
    j.beginEntry('s2'); // never terminalized

    j.sweepExpired();
    expect(j.getEntries('s1')).not.toBeNull();

    t += JOURNAL_TTL_MS;
    j.sweepExpired();
    expect(j.getEntries('s1')).toBeNull(); // terminal + TTL elapsed
    expect(j.getEntries('s2')).not.toBeNull(); // no terminal → kept (for now)

    t += JOURNAL_MAX_OPERATION_LIFETIME_MS;
    j.sweepExpired();
    expect(j.getEntries('s2')).toBeNull(); // leak guard: never-terminalized ops die too
  });
});

// ─── 5. Ring cap — 500 entries per operation ─────────────────────────────────

describe('operation journal — ring cap', () => {
  it('keeps the LAST 500 entries of 520 (first 20 discarded, seq is continuous)', () => {
    const j = new OperationJournal();
    j.beginEntry('cap');
    for (let i = 0; i < 520; i += 1) {
      j.recordCommand('cap', {
        args: ['status'], exitCode: 0, stdout: String(i), stderr: '', durationMs: 1,
      });
    }
    const entries = j.getEntries('cap');
    expect(entries.length).toBe(JOURNAL_MAX_ENTRIES);
    expect(entries.length).toBe(500);
    expect(entries[0].seq).toBe(21);       // first 20 discarded…
    expect(entries[0].stdout).toBe('20');
    expect(entries[499].seq).toBe(520);    // …latest kept
    expect(entries[499].stdout).toBe('519');
    j.dispose('cap');
  });
});

// ─── 6. Current-operation attribution + unattributed buffer ──────────────────

describe('operation journal — current-operation attribution', () => {
  it('recordCommand(null, …) inherits the operation set by setCurrentOperation; terminal clears it', () => {
    const j = new OperationJournal();
    j.setCurrentOperation('cur-1', { projectId: 7, flow: 'refresh' });
    expect(j.getCurrentOperationId()).toBe('cur-1');

    j.recordCommand(null, { args: ['fetch', 'origin'], exitCode: 0, stdout: 'ok', stderr: '', durationMs: 3 });
    const entries = j.getEntries('cur-1');
    expect(entries.length).toBe(1);
    expect(entries[0].args).toEqual(['fetch', 'origin']);

    j.markTerminal('cur-1'); // terminal also clears the current operation
    expect(j.getCurrentOperationId()).toBeNull();

    // Post-terminal commands (outside any lock) are unattributed —
    // never appended to the expired-but-still-readable operation.
    j.recordCommand(null, { args: ['clone'], exitCode: 0, stdout: '', stderr: '', durationMs: 9 });
    expect(j.getEntries('cur-1').length).toBe(1);
    const unattributed = j.getUnattributedEntries();
    expect(unattributed.length).toBe(1);
    expect(unattributed[0].args).toEqual(['clone']);
    j.reset();
  });
});

// ─── 7. IPC channel git:get-operation-log (invoke/handle contract) ───────────

describe('IPC git:get-operation-log', () => {
  it('returns {success:true, entries} for a known operation and LOG_NOT_FOUND otherwise', async () => {
    const handlers = makeHandlers('/tmp/journal-ipc-probe');
    handlers.registerHandlers();

    const call = global.mockElectron.ipcMain.handle.mock.calls
      .map(([channel, fn]) => ({ channel, fn }))
      .find(({ channel }) => channel === 'git:get-operation-log');
    expect(call).toBeDefined();
    expect(typeof call.fn).toBe('function');

    // Unknown id → typed failure (never throws across IPC).
    const unknown = await call.fn({}, '00000000-not-a-real-op');
    expect(unknown.success).toBe(false);
    expect(unknown.code).toBe('LOG_NOT_FOUND');
    expect(typeof unknown.error).toBe('string');

    // Missing/invalid arg → same typed failure.
    const missing = await call.fn({}, undefined);
    expect(missing.success).toBe(false);
    expect(missing.code).toBe('LOG_NOT_FOUND');

    // Known id → full sanitized journal.
    journal.beginEntry('ipc-known');
    journal.recordCommand('ipc-known', { args: ['fetch', 'origin'], exitCode: 128, stdout: '', stderr: 'boom', durationMs: 12 });
    const ok = await call.fn({}, 'ipc-known');
    expect(ok.success).toBe(true);
    expect(ok.entries.length).toBe(1);
    expect(ok.entries[0].args).toEqual(['fetch', 'origin']);
    expect(ok.entries[0].exitCode).toBe(128);
    journal.dispose('ipc-known');

    // Unregister follows the removeHandler pattern of the other channels.
    handlers.unregisterHandlers();
    const removed = global.mockElectron.ipcMain.removeHandler.mock.calls
      .map(([channel]) => channel);
    expect(removed).toContain('git:get-operation-log');
  });
});
