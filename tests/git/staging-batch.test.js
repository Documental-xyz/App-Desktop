/**
 * @fileoverview publish-update-resilience P-1 — BATCHED STAGING proofs.
 *
 * The bug (final-QA finding, repro 1/10 with 4 dirty files): both staging
 * sites — git.js `_commitAll` and gitSafety.js `_createBackup` — ran
 * `Promise.all(batch.map(f => git.add(repo, [f])))`: ONE CONCURRENT
 * `git add` PER FILE. `git add` takes `.git/index.lock` and git has NO
 * lock retry, so concurrent adds collide (`fatal: Unable to create
 * '.git/index.lock': File exists.`) and the losing files stay unstaged
 * → publish fails "Erro ao preparar arquivo(s)". Any publish/update
 * with ≥2 dirty files was a flake.
 *
 * The fix: ONE `git add` PER LOT (DugiteProvider.add already accepts a
 * path array — single `git add -- <lot>` = single index.lock acquisition
 * = zero race). These tests COMMAND-TRACE the flows (spy on
 * DugiteProvider.prototype._run records every git argv — the T4
 * pattern) and prove:
 *
 *   1. publish (gitPublishPreview) with 4 dirty files: exactly ONE
 *      staging `git add` carrying ALL 4 paths in the SAME command —
 *      zero per-file adds;
 *   2. backup (_createBackup) with a mixed dirty matrix (3 present +
 *      1 deleted): ONE `git add` with the 3 present paths + ONE
 *      `git rm --cached` with the deleted path;
 *   3. _commitAll multi-lot unit (mock facade): 250 dirty files →
 *      3 lots → 3 batched adds (100/100/45) + 1 batched remove (5),
 *      per-file error reporting preserved;
 *   4. stress: 10× publish with 4 dirty files → 10/10 success (the
 *      inverse of the 1/10 final-QA repro).
 *
 * @vitest-environment node
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// tests/setup.js mocks fs/path globally — these fixtures need the REAL fs.
vi.unmock('fs');
vi.unmock('path');

import fs from 'fs';
import path from 'path';

import { createRepoPair, httpBackendAvailable } from './fixtures/harness.js';
import { GitHandlers } from '../../src/ipc/git.js';
import { GitService } from '../../src/git/GitService.js';
import { providerFactory } from '../git-providers/harness.js';
import { GitSafety, createObjectStyleOps } from '../../src/ipc/gitSafety.js';

// Object-style git ops over the production facade (setup engine).
const git = createObjectStyleOps(new GitService());

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ─── DI + command-trace helpers (fastpath-perf pattern) ──────────────────────

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
 * Command-trace spy on the provider choke point (T4 pattern): records
 * {op, args} of EVERY git invocation and repasses to the original
 * _run. Spies the PROTOTYPE — the CJS factory's `require`d
 * DugiteProvider and this file's ESM `import` are two module
 * instances (the T19 dual-class gotcha).
 */
function installTrace(target) {
  const provider =
    typeof target?._resolve === 'function' ? target._resolve() : target;
  const proto = Object.getPrototypeOf(provider);
  const trace = [];
  const original = proto._run;
  const spy = vi.spyOn(proto, '_run').mockImplementation(
    function (operation, args, ...rest) {
      trace.push({ op: operation, args: [...args], t: Date.now() });
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
const addCommands = (trace) => commands(trace, 'add');
const rmCommands = (trace) => commands(trace, 'rm');

// ─── Scenario 1: publish flow — one staging add per lot ──────────────────────

describe.skipIf(!httpBackendAvailable)('P-1 publish — batched staging (dugite trace)', () => {
  let pair;
  let handlers;
  let tracer;

  // 4 dirty files: 3 modified tracked + 1 untracked.
  const BASE_FILES = { 'base-1.md': 'one\n', 'base-2.md': 'two\n', 'base-3.md': 'three\n' };
  const DIRTY_FILES = ['base-1.md', 'base-2.md', 'base-3.md', 'added-4.md'];

  function makeDirty(i = 0) {
    for (const f of ['base-1.md', 'base-2.md', 'base-3.md']) {
      fs.writeFileSync(path.join(pair.local.dir, f), `${f} modified ${i}\n`);
    }
    fs.writeFileSync(path.join(pair.local.dir, 'added-4.md'), `added ${i}\n`);
  }

  beforeEach(async () => {
    pair = await createRepoPair({ branch: 'preview', files: BASE_FILES });
    handlers = makeHandlers(pair.local.dir);
    tracer = installTrace(handlers.git);
  });

  afterEach(() => {
    tracer.restore();
    pair.dispose();
  });

  it('gitPublishPreview with 4 dirty files: ONE staging git add carrying ALL 4 paths, zero per-file adds', async () => {
    makeDirty();

    const result = await handlers.gitPublishPreview(1, 'test: publish 4 dirty files');

    expect(result.success).toBe(true);

    // Staging adds = `git add` commands that touch any dirty file.
    const staging = addCommands(tracer.trace).filter((t) =>
      DIRTY_FILES.some((f) => t.args.includes(f)),
    );

    // Exactly ONE staging command — 4 files < BATCH_SIZE(100) = 1 lot.
    // (The backup sees a CLEAN tree post-_commitAll — commit-first flow —
    // so it contributes no staging add.)
    expect(staging).toHaveLength(1);

    // ALL 4 paths ride the SAME command.
    for (const f of DIRTY_FILES) {
      expect(staging[0].args).toContain(f);
    }

    // Zero per-file adds anywhere in the flow (the old racy pattern).
    expect(addCommands(tracer.trace).some((t) => t.args.slice(2).length === 1)).toBe(false);

    // The publish really landed.
    expect(commands(tracer.trace, 'push')).toHaveLength(1);
    const origin = await pair.local.resolveRef('refs/remotes/origin/preview');
    expect(origin).toBe(await pair.local.head());
  });
});

// ─── Scenario 1b: stress — the inverse of the final-QA 1/10 repro ────────────

describe.skipIf(!httpBackendAvailable)('P-1 stress — 10× publish with 4 dirty files', () => {
  const BASE_FILES = { 'base-1.md': 'one\n', 'base-2.md': 'two\n', 'base-3.md': 'three\n' };
  const DIRTY_FILES = ['base-1.md', 'base-2.md', 'base-3.md', 'added-4.md'];

  // Fresh loopback origin per chunk: the git-http-backend CGI tires out
  // after ~30 rapid requests (unrelated transport flake — "remote end
  // hung up"), so 10 iterations run as 2 chunks of 5 on fresh servers.
  async function runChunk(iterations, label) {
    const pair = await createRepoPair({ branch: 'preview', files: BASE_FILES });
    const handlers = makeHandlers(pair.local.dir);
    const tracer = installTrace(handlers.git);
    try {
      for (let i = 0; i < iterations; i++) {
        const start = tracer.trace.length;
        for (const f of ['base-1.md', 'base-2.md', 'base-3.md']) {
          fs.writeFileSync(path.join(pair.local.dir, f), `${f} modified ${i}\n`);
        }
        fs.writeFileSync(path.join(pair.local.dir, 'added-4.md'), `added ${i}\n`);

        const result = await handlers.gitPublishPreview(1, `test: ${label} #${i}`);

        expect(result.success, `${label} ${i}: ${JSON.stringify(result)}`).toBe(true);
        const slice = tracer.trace.slice(start);
        const staging = addCommands(slice).filter((t) =>
          DIRTY_FILES.some((f) => t.args.includes(f)),
        );
        expect(staging, `${label} ${i}`).toHaveLength(1);
        for (const f of DIRTY_FILES) {
          expect(staging[0].args, `${label} ${i}`).toContain(f);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    } finally {
      tracer.restore();
      pair.dispose();
    }
  }

  it('10/10 success, each with exactly ONE batched staging add carrying ALL 4 paths', async () => {
    await runChunk(5, 'chunk-a');
    await runChunk(5, 'chunk-b');
  });
});

// ─── Scenario 2: backup flow — one add + one rm per lot ─────────────────────

describe.skipIf(!httpBackendAvailable)('P-1 backup — batched staging (dugite trace)', () => {
  it('_createBackup with mixed dirty matrix (3 present + 1 deleted): ONE git add (3 paths) + ONE git rm --cached (deleted path)', async () => {
    const pair = await createRepoPair({
      branch: 'preview',
      files: { 'keep-1.md': 'k1\n', 'keep-2.md': 'k2\n', 'keep-3.md': 'k3\n', 'gone.md': 'g\n' },
    });
    const tracer = installTrace(new GitService());
    try {
      const dir = pair.local.dir;
      // 3 modified + 1 deleted (removed from the working tree).
      for (const f of ['keep-1.md', 'keep-2.md', 'keep-3.md']) {
        fs.writeFileSync(path.join(dir, f), `${f} modified\n`);
      }
      fs.rmSync(path.join(dir, 'gone.md'));

      const matrix = await git.statusMatrix({ fs, dir });
      const dirty = matrix.filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));
      expect(dirty).toHaveLength(4);

      const safety = new GitSafety({ logger: makeLogger() });
      const backupBranch = await safety._createBackup({
        gitMod: git,
        fs,
        projectPath: dir,
        currentBranch: 'preview',
        localHead: await pair.local.head(),
        dirty,
      });

      expect(backupBranch).toMatch(/^backup\//);

      // ONE staging add with the 3 PRESENT paths (same command)…
      const adds = addCommands(tracer.trace);
      expect(adds).toHaveLength(1);
      for (const f of ['keep-1.md', 'keep-2.md', 'keep-3.md']) {
        expect(adds[0].args).toContain(f);
      }
      // …and the DELETED path is not `git add`ed…
      expect(adds[0].args).not.toContain('gone.md');

      // …it goes through ONE batched `git rm --cached`.
      const rms = rmCommands(tracer.trace);
      expect(rms).toHaveLength(1);
      expect(rms[0].args).toContain('--cached');
      expect(rms[0].args).toContain('gone.md');

      // Snapshot commit landed on the backup branch (the author -c flags
      // shift argv[0], so match on content).
      expect(tracer.trace.some((t) => t.args.includes('commit'))).toBe(true);
    } finally {
      tracer.restore();
      pair.dispose();
    }
  });
});

// ─── Scenario 3: _commitAll multi-lot partition (unit, mock facade) ──────────

describe('P-1 _commitAll — multi-lot batching (unit)', () => {
  it('250 dirty files (245 present + 5 deleted) → 3 lots → 3 batched adds (100/100/45) + 1 batched remove (5)', async () => {
    const handlers = makeHandlers('/repo');
    const matrix = [];
    for (let i = 0; i < 245; i++) {
      matrix.push([`present-${String(i).padStart(3, '0')}.md`, 1, 2, 1]);
    }
    for (let i = 0; i < 5; i++) {
      matrix.push([`deleted-${String(i).padStart(3, '0')}.md`, 1, 0, 1]);
    }

    const adds = [];
    const removes = [];
    handlers.git = {
      statusMatrix: vi.fn(async () => matrix),
      add: vi.fn(async (_p, files) => adds.push(files)),
      remove: vi.fn(async (_p, files) => removes.push(files)),
      commit: vi.fn(async () => 'a'.repeat(40)),
    };

    const sha = await handlers._commitAll('/repo', 'msg', { name: 't', email: 't@t' });

    expect(sha).toBe('a'.repeat(40));
    // BATCH_SIZE stays 100 (Task 4) — 250 dirty files = 3 lots.
    expect(adds).toHaveLength(3);
    expect(adds[0]).toHaveLength(100);
    expect(adds[1]).toHaveLength(100);
    expect(adds[2]).toHaveLength(45);
    // Deletions ride their own single batched remove.
    expect(removes).toHaveLength(1);
    expect(removes[0]).toHaveLength(5);
    // Zero per-file calls anywhere.
    for (const lot of [...adds, ...removes]) {
      expect(lot.length).toBeGreaterThan(1);
    }
  });

  it('a failed batch reports EVERY filepath of the lot (error message preserved)', async () => {
    const handlers = makeHandlers('/repo');
    handlers.git = {
      statusMatrix: vi.fn(async () => [
        ['a.md', 1, 2, 1],
        ['b.md', 1, 2, 1],
      ]),
      add: vi.fn(async () => {
        throw new Error("fatal: Unable to create '.git/index.lock': File exists.");
      }),
      remove: vi.fn(async () => {}),
      commit: vi.fn(async () => 'a'.repeat(40)),
    };

    await expect(
      handlers._commitAll('/repo', 'msg', { name: 't', email: 't@t' }),
    ).rejects.toThrow('Erro ao preparar arquivo(s): a.md, b.md');
  });
});
