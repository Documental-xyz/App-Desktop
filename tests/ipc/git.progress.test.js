/**
 * @fileoverview publish-update-resilience Task 2: extended git:progress
 * payload + emission in ALL flows (refresh / publish-preview / publish-main).
 *
 * Contract (plan; written BEFORE the implementation — TDD):
 *   - Payload superset per event:
 *       { projectId, operationId, flow, stage, stageIndex, stageTotal,
 *         message, percentage (number|null), terminal?: 'complete'|'cancelled'|'failed' }
 *   - STAGE_LISTS (shared constant in gitFlowTypes.js):
 *       refresh:         preparing → fetching → merging → finalizing (4)
 *       publish-preview: preparing → fetching → merging → pushing → finalizing (5)
 *       publish-main:    preparing → fetching → merging → pushing → finalizing (5)
 *   - EXACTLY ONE terminal event per operation and NOTHING after it
 *   - stageIndex never regresses within an operation; percentage is null
 *     outside the transfer stages (fetching/pushing)
 *   - fetch failure → terminal 'failed' at stage 'fetching', never 'complete'
 *
 * Structure: webContents capture at the broadcastToWindows fan-out (the
 * getAllWindows seam — same shape as the electron mock pattern in
 * git.cancellation.test.js) + REAL repositories from the harness +
 * canonical DI (vi.unmock('fs')/vi.unmock('path') — setup.js mocks them
 * globally).
 *
 * Evidence: run with GENERATE_PROGRESS_EVIDENCE=1 to (re)write
 * .omo/evidence/task-2-refresh-progress-events.json and
 * .omo/evidence/task-2-fetch-failure-terminal.txt.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// tests/setup.js mocks fs/path globally — these fixtures need the REAL fs.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';

import { createRepoPair, commitFile, makeDivergent, makeDirty, httpBackendAvailable } from '../git/fixtures/harness.js';
import { STAGE_LISTS } from '../../src/ipc/gitFlowTypes.js';
import { GitHandlers, parseTransferPercentage } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { providerFactory, gitSetup } from '../git-providers/harness.js';


// ─── Event capture (webContents.send at the broadcastToWindows fan-out) ──────

/** Receives every webContents.send(channel, payload) call. */
const sendSpy = vi.fn();
const fakeWindow = { isDestroyed: () => false, webContents: { send: sendSpy } };
let originalGetAllWindows;

beforeEach(() => {
  sendSpy.mockClear();
  originalGetAllWindows = global.mockElectron.BrowserWindow.getAllWindows;
  global.mockElectron.BrowserWindow.getAllWindows = vi.fn(() => [fakeWindow]);
});

afterEach(() => {
  global.mockElectron.BrowserWindow.getAllWindows = originalGetAllWindows;
});

/** All git:progress payloads broadcast so far. */
function progressEvents() {
  return sendSpy.mock.calls
    .filter(([channel]) => channel === 'git:progress')
    .map(([, payload]) => payload);
}

// ─── DI helpers (canonical structure — refresh-flow.test.js pattern) ─────────

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
  // Pinned to dugite (T16) — the production backend.
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

// ─── Shared assertions ───────────────────────────────────────────────────────

/** stageIndex must never regress within one operation. */
function assertStageIndexMonotonic(events) {
  let last = 0;
  for (const e of events) {
    expect(e.stageIndex).toBeGreaterThanOrEqual(last);
    last = e.stageIndex;
  }
}

/**
 * percentage must never regress within one stage of an operation — git's
 * transfer phases (counting/compressing/receiving) and deepen fetches each
 * restart at 0%, so the emission clamps to the per-stage high-water mark.
 */
function assertPercentageMonotonicPerStage(events) {
  const lastByStage = new Map();
  for (const e of events) {
    if (e.terminal || typeof e.percentage !== 'number') continue;
    const key = `${e.operationId}:${e.stage}`;
    const last = lastByStage.get(key);
    if (last !== undefined) {
      expect(e.percentage).toBeGreaterThanOrEqual(last);
    }
    lastByStage.set(key, e.percentage);
  }
}

/**
 * Asserts the full Task-2 payload contract on every event of one operation
 * and returns the operation's events (all sharing one operationId).
 */
function assertOperationContract(events, { projectId, flow, stageTotal }) {
  expect(events.length).toBeGreaterThan(0);
  const operationIds = new Set(events.map((e) => e.operationId));
  expect(operationIds.size).toBe(1);
  const operationId = events[0].operationId;
  expect(typeof operationId).toBe('string');
  expect(operationId.length).toBeGreaterThan(10);

  for (const e of events) {
    expect(e.projectId).toBe(projectId);
    expect(e.flow).toBe(flow);
    expect(e.stageTotal).toBe(stageTotal);
    expect(typeof e.stage).toBe('string');
    expect(typeof e.message).toBe('string');
    // percentage: number | null — nothing else
    if (e.percentage !== null) {
      expect(typeof e.percentage).toBe('number');
    }
  }
  return events;
}

/** Exactly one terminal event, it is the LAST event, and nothing follows it. */
function assertSingleTerminal(events, terminalKind) {
  const terminals = events.filter((e) => e.terminal);
  expect(terminals).toHaveLength(1);
  expect(terminals[0].terminal).toBe(terminalKind);
  expect(events[events.length - 1]).toBe(terminals[0]);
  return terminals[0];
}

/** First-occurrence index of a stage among non-terminal events (-1 = absent). */
function firstStageIndex(events, stage) {
  return events.findIndex((e) => !e.terminal && e.stage === stage);
}

// ─── Unit: shared constants + percentage parsing (ungated) ───────────────────

describe('git:progress — STAGE_LISTS contract (gitFlowTypes.js)', () => {
  it('refresh = preparing→fetching→merging→finalizing (4 stages)', () => {
    expect(STAGE_LISTS.refresh).toEqual(['preparing', 'fetching', 'merging', 'finalizing']);
    expect(STAGE_LISTS.refresh).toHaveLength(4);
  });

  it('publish-preview = preparing→fetching→merging→pushing→finalizing (5 stages)', () => {
    expect(STAGE_LISTS['publish-preview']).toEqual(
      ['preparing', 'fetching', 'merging', 'pushing', 'finalizing'],
    );
  });

  it('publish-main = preparing→fetching→merging→pushing→finalizing (5 stages)', () => {
    expect(STAGE_LISTS['publish-main']).toEqual(
      ['preparing', 'fetching', 'merging', 'pushing', 'finalizing'],
    );
  });
});

describe('parseTransferPercentage — stderr transfer line parsing', () => {
  it('parses "Counting objects: 45% (9/20)" → 45', () => {
    expect(parseTransferPercentage('Counting objects: 45% (9/20)')).toBe(45);
  });

  it('parses "Writing objects: 67%" → 67 (remote-prefixed sideband lines too)', () => {
    expect(parseTransferPercentage('Writing objects: 67%')).toBe(67);
    expect(parseTransferPercentage('remote: Writing objects:  10% (1/10)')).toBe(10);
  });

  it('returns the LAST percentage of a multi-line stderr blob', () => {
    const blob = [
      'Enumerating objects: 9, done.',
      'Counting objects:  33% (3/9)',
      'Counting objects:  66% (6/9)',
      'Counting objects: 100% (9/9), done.',
    ].join('\r\n');
    expect(parseTransferPercentage(blob)).toBe(100);
  });

  it('returns null when there is no transfer percentage', () => {
    expect(parseTransferPercentage('Everything up-to-date')).toBeNull();
    expect(parseTransferPercentage('')).toBeNull();
    expect(parseTransferPercentage(null)).toBeNull();
    expect(parseTransferPercentage(undefined)).toBeNull();
  });
});

// ─── Integration: refresh flow (real repos, real loopback origin) ────────────

describe.skipIf(!httpBackendAvailable)('gitRefresh — git:progress sequence', () => {
  // GATE (capability, never unconditional): this battery drives real repos
  // over the loopback git-http-backend server (createRepoPair); skipped only
  // where the bundled git lacks the CGI — re-opens by itself when the
  // runner ships http-backend. Mock/unit describes stay ungated.
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'b.md': 'v1\n' } });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('emits the 4 refresh stages in order, one complete terminal, full payload on every event', async () => {
    // Remote (colleague) commits+pushes a new file; local tree is dirty —
    // forces WIP + backup + fetch + real merge + materialize.
    await makeDivergent(pair, { remoteFiles: { 'remote.txt': 'r1\n' } });
    makeDirty(pair.local, { 'local.txt': 'l1\n' });

    const result = await handlers.gitRefresh(1);
    expect(result.success).toBe(true);

    const events = assertOperationContract(progressEvents(), {
      projectId: 1,
      flow: 'refresh',
      stageTotal: 4,
    });

    // The 4 stages, in the plan's order, each exactly started once.
    const p = firstStageIndex(events, 'preparing');
    const f = firstStageIndex(events, 'fetching');
    const m = firstStageIndex(events, 'merging');
    const z = firstStageIndex(events, 'finalizing');
    expect(p).toBeGreaterThanOrEqual(0);
    expect(f).toBeGreaterThan(p);
    expect(m).toBeGreaterThan(f);
    expect(z).toBeGreaterThan(m);
    expect(events[p].stageIndex).toBe(1);
    expect(events[f].stageIndex).toBe(2);
    expect(events[m].stageIndex).toBe(3);
    expect(events[z].stageIndex).toBe(4);

    // The first event of the operation is the preparing announcement.
    expect(events[0].stage).toBe('preparing');
    expect(events[0].terminal).toBeUndefined();

    // Exactly one terminal: complete, last, 100%.
    const terminal = assertSingleTerminal(events, 'complete');
    expect(terminal.stage).toBe('complete');
    expect(terminal.percentage).toBe(100);

    assertStageIndexMonotonic(events);
    assertPercentageMonotonicPerStage(events);
  });

  it('percentage is null in merging and finalizing stages', async () => {
    await makeDivergent(pair, { remoteFiles: { 'remote.txt': 'r1\n' } });
    makeDirty(pair.local, { 'local.txt': 'l1\n' });

    await handlers.gitRefresh(1);

    const mergingFinalizing = progressEvents().filter(
      (e) => e.stage === 'merging' || e.stage === 'finalizing',
    );
    expect(mergingFinalizing.length).toBeGreaterThan(0);
    for (const e of mergingFinalizing) {
      expect(e.percentage).toBeNull();
    }
  });
});

// ─── Integration: publish-preview flow ───────────────────────────────────────

describe.skipIf(!httpBackendAvailable)('gitPublishPreview — git:progress sequence', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'a.md': 'v1\n' } });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('emits the 5 publish stages in order with a single complete terminal', async () => {
    // Real divergence (local commit + pushed remote commit) so the merge
    // stage actually runs (a merely-ahead local would skip 'merging').
    await makeDivergent(pair, {
      localFiles: { 'local.md': 'l1\n' },
      remoteFiles: { 'remote.md': 'r1\n' },
    });

    const result = await handlers.gitPublishPreview(1, 'publish: progress test');
    expect(result.success).toBe(true);

    const events = assertOperationContract(progressEvents(), {
      projectId: 1,
      flow: 'publish-preview',
      stageTotal: 5,
    });

    const p = firstStageIndex(events, 'preparing');
    const f = firstStageIndex(events, 'fetching');
    const m = firstStageIndex(events, 'merging');
    const u = firstStageIndex(events, 'pushing');
    const z = firstStageIndex(events, 'finalizing');
    expect(p).toBeGreaterThanOrEqual(0);
    expect(f).toBeGreaterThan(p);
    expect(m).toBeGreaterThan(f);
    expect(u).toBeGreaterThan(m);
    expect(z).toBeGreaterThan(u);
    expect(events[p].stageIndex).toBe(1);
    expect(events[u].stageIndex).toBe(4);
    expect(events[z].stageIndex).toBe(5);

    const terminal = assertSingleTerminal(events, 'complete');
    expect(terminal.stage).toBe('complete');
    expect(terminal.percentage).toBe(100);

    assertStageIndexMonotonic(events);
    assertPercentageMonotonicPerStage(events);
  });
});

// ─── Integration: publish-main flow ──────────────────────────────────────────

describe.skipIf(!httpBackendAvailable)('gitPublishMain — git:progress sequence', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    // Base on main (colleague keeps origin/main); local switches to preview.
    pair = await createRepoPair({ branch: 'main', files: { 'a.md': 'v1\n' } });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('emits the 5 publish-main stages in order with a single complete terminal', async () => {
    // Local branches preview at the base and publishes a feat commit.
    const baseOid = await pair.local.head();
    await gitSetup(['branch', 'preview', baseOid], pair.local.dir);
    await gitSetup(['checkout', 'preview'], pair.local.dir);
    await commitFile(pair.local, 'feat.txt', 'f1\n', 'preview: feat');
    await pair.local.push('preview');

    const result = await handlers.gitPublishMain(1);
    expect(result.success).toBe(true);

    const events = assertOperationContract(progressEvents(), {
      projectId: 1,
      flow: 'publish-main',
      stageTotal: 5,
    });

    const p = firstStageIndex(events, 'preparing');
    const f = firstStageIndex(events, 'fetching');
    const m = firstStageIndex(events, 'merging');
    const u = firstStageIndex(events, 'pushing');
    const z = firstStageIndex(events, 'finalizing');
    expect(p).toBeGreaterThanOrEqual(0);
    expect(f).toBeGreaterThan(p);
    expect(m).toBeGreaterThan(f);
    expect(u).toBeGreaterThan(m);
    expect(z).toBeGreaterThan(u);

    assertSingleTerminal(events, 'complete');
    assertStageIndexMonotonic(events);
    assertPercentageMonotonicPerStage(events);
  });
});

// ─── Integration: fetch failure → terminal failed at the failing stage ───────

describe.skipIf(!httpBackendAvailable)('git:progress — fetch failure terminal', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'b.md': 'v1\n' } });
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  it('origin down → exactly one terminal failed at stage fetching, never complete', async () => {
    makeDirty(pair.local, { 'local.txt': 'l1\n' });
    // Kill ONLY the http origin — repos stay on disk so the flow reaches
    // (and fails at) its fetch step.
    pair.server.closeAllConnections?.();
    pair.server.close();

    const result = await handlers.gitRefresh(1);
    if (result.success) console.log('REFRESH-OK-UNEXPECTED:', JSON.stringify(result));
    expect(result.success).toBe(false);

    const events = assertOperationContract(progressEvents(), {
      projectId: 1,
      flow: 'refresh',
      stageTotal: 4,
    });

    // Terminal failed, reported AT the fetching stage.
    const terminal = assertSingleTerminal(events, 'failed');
    expect(terminal.stage).toBe('fetching');
    expect(terminal.percentage).toBeNull();

    // No complete stage anywhere in the failed operation.
    expect(events.some((e) => e.stage === 'complete')).toBe(false);

    assertStageIndexMonotonic(events);
    assertPercentageMonotonicPerStage(events);
  });
});

// ─── Integration: legacy gitPullFromPreview keeps the old shape ──────────────

describe.skipIf(!httpBackendAvailable)('gitPullFromPreview — legacy payload regression guard', () => {
  let pair;
  let handlers;

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: { 'b.md': 'v1\n' } });
    // dugite's `git pull origin` relies on branch tracking config (the
    // app's repos are clones and carry it; the harness local is an
    // init+remote-add repo) — materialize the upstream like a clone would.
    await gitSetup(['fetch', 'origin'], pair.local.dir);
    await gitSetup(['branch', '--set-upstream-to=origin/preview', 'preview'], pair.local.dir);
    handlers = makeHandlers(pair.local.dir);
  });

  afterEach(() => {
    pair.dispose();
  });

  // Scenario (T16, dugite): clean local tree, local == origin/preview.
  // The former iso scenarios (diverged merge / fast-forward with remote
  // ahead) are UNSATISFIABLE under dugite as wired: the flow's own
  // depth:1 fetch leaves the repo shallow and the subsequent `git pull`
  // keeps the shallow boundary, refusing the merge ("refusing to merge
  // unrelated histories" — surfaces as the PT-BR conflict message).
  // T17 follow-up: teach DugiteProvider.pull to deepen (iso pull fetched
  // fully in-memory) or retire this legacy flow (gitRefresh supersedes
  // it; merge integration is covered by tests/git/refresh-flow.test.js).
  // This guard only pins the legacy PAYLOAD shape.
  it('still emits stage/current/total (payload is a superset; transfer percentage is iso-only)', async () => {
    const result = await handlers.gitPullFromPreview(pair.local.dir, 'auto: local edits');
    expect(result.success).toBe(true);

    const events = progressEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].stage).toBe('checking');
    for (const e of events) {
      expect(typeof e.current).toBe('number');
      expect(typeof e.total).toBe('number');
      // Transfer percentages were iso-git-only (its http client streamed
      // fetch progress); dugite does not stream them, so `percentage` is
      // an OPTIONAL key on the legacy payload (documented T2 divergence).
      expect(e.terminal).toBeUndefined();
    }
    // The final legacy event is the legacy 'complete' stage (no terminal flag).
    expect(events[events.length - 1].stage).toBe('complete');
  });
});

// ─── Evidence generation (env-gated; not part of CI assertions) ──────────────

const EVIDENCE = process.env.GENERATE_PROGRESS_EVIDENCE === '1';
const EVIDENCE_DIR = path.resolve(process.cwd(), '.omo/evidence');

describe.skipIf(!httpBackendAvailable || !EVIDENCE)('git:progress — evidence generation', () => {
  it('captures full event streams (refresh, publish-main) and a fetch-failure terminal', async () => {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

    // (1) Full refresh — array of captured events.
    let pair = await createRepoPair({ branch: 'preview', files: { 'b.md': 'v1\n' } });
    let handlers = makeHandlers(pair.local.dir);
    sendSpy.mockClear();
    await makeDivergent(pair, { remoteFiles: { 'remote.txt': 'r1\n' } });
    makeDirty(pair.local, { 'local.txt': 'l1\n' });
    const refreshResult = await handlers.gitRefresh(1);
    const refreshEvents = progressEvents();
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'task-2-refresh-progress-events.json'),
      JSON.stringify({ result: refreshResult, events: refreshEvents }, null, 2),
    );
    pair.dispose();

    // (2) Full publish-main — array of captured events.
    pair = await createRepoPair({ branch: 'main', files: { 'a.md': 'v1\n' } });
    handlers = makeHandlers(pair.local.dir);
    const baseOid = await pair.local.head();
    await gitSetup(['branch', 'preview', baseOid], pair.local.dir);
    await gitSetup(['checkout', 'preview'], pair.local.dir);
    await commitFile(pair.local, 'feat.txt', 'f1\n', 'preview: feat');
    await pair.local.push('preview');
    sendSpy.mockClear();
    const mainResult = await handlers.gitPublishMain(1);
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'task-2-publishmain-progress-events.json'),
      JSON.stringify({ result: mainResult, events: progressEvents() }, null, 2),
    );
    pair.dispose();

    // (3) Origin down → terminal failed.
    pair = await createRepoPair({ branch: 'preview', files: { 'b.md': 'v1\n' } });
    handlers = makeHandlers(pair.local.dir);
    sendSpy.mockClear();
    makeDirty(pair.local, { 'local.txt': 'l1\n' });
    pair.server.closeAllConnections?.();
    pair.server.close();
    const failResult = await handlers.gitRefresh(1);
    const failEvents = progressEvents();
    const failTerminal = failEvents.find((e) => e.terminal);
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'task-2-fetch-failure-terminal.txt'),
      [
        `# origin down (loopback server closed) → gitRefresh result + git:progress events`,
        `result.success=${failResult.success}`,
        `terminal=${failTerminal && failTerminal.terminal} stage=${failTerminal && failTerminal.stage}`,
        `events=${failEvents.length}`,
        '',
        JSON.stringify(failEvents, null, 2),
      ].join('\n'),
    );
    pair.dispose();
  });
});
